import {pool,transaction} from './db.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';

export const normalizedName=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').trim().split(/\s+/).sort().join(' ');
export async function ensureBitrixUser(request:BitrixRequest,externalId:string){
 const existing=(await pool.query('SELECT user_id FROM bitrix_user_links WHERE external_id=$1',[externalId])).rows[0];
 if(existing)return existing.user_id as string;
 const people=await request<{ID:unknown;NAME?:string;LAST_NAME?:string;SECOND_NAME?:string}[]>('user.get',{filter:{ID:externalId},select:['ID','NAME','LAST_NAME','SECOND_NAME']});
 const person=Array.isArray(people)&&people.length===1&&String(people[0].ID)===externalId?people[0]:null;
 const name=person&&[person.LAST_NAME,person.NAME,person.SECOND_NAME].filter(Boolean).join(' ').trim();
 if(!person||!name)throw new BitrixError('Нет подтверждённого имени сотрудника Битрикс24 #'+externalId+'.');
 return transaction(async db=>{
  const again=(await db.query('SELECT user_id FROM bitrix_user_links WHERE external_id=$1',[externalId])).rows[0];
  if(again)return again.user_id as string;
  // Only imported employee identities may be matched automatically, never privileged accounts.
  const candidates=(await db.query("SELECT id,name FROM users WHERE role='employee' AND (id LIKE 'person-%' OR id LIKE 'bitrix-person-%')")).rows
   .filter(row=>normalizedName(row.name)===normalizedName(name));
  if(candidates.length>1)throw new BitrixError('Неоднозначное имя сотрудника. Требуется явная команда map-user.');
  const userId=candidates[0]?.id??'bitrix-person-'+externalId;
  if((await db.query('SELECT 1 FROM bitrix_user_links WHERE user_id=$1',[userId])).rowCount)throw new BitrixError('Сотрудник уже связан с другим ID. Требуется проверка map-user.');
  if(!candidates.length)await db.query("INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,'employee','Не указан','Сотрудник Битрикс24')",[userId,name]);
  await db.query('INSERT INTO bitrix_user_links(user_id,external_id) VALUES($1,$2)',[userId,externalId]);
  return userId as string;
 });
}
