import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assert,globalAccess} from './domain.js';
import type {User} from '../shared/types.js';
import {loadAnalyticsScope} from './analytics-scope.js';
import {pool as mainPool} from './db.js';

let pool:pg.Pool|undefined;
export const okbConfigured=()=>!!process.env.OKB_DATABASE_URL;
export function okbPool(){
 const url=process.env.OKB_DATABASE_URL;
 assert(url,503,'Отдельная база ОКБ ещё не настроена.');
 return pool??=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:3000,options:'-c statement_timeout=10000'});
}
export async function closeOkb(){
 if(pool){const current=pool;pool=undefined;await current.end();}
}
export async function migrateOkb(){
 const db=await okbPool().connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(431030)');
  await db.query(await readFile(new URL('./okb-schema.sql',import.meta.url),'utf8'));
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
const companyInput=z.object({name:z.string().trim().min(2).max(250),
 taxId:z.string().trim().regex(/^(?:\d{10}|\d{12})$/).nullable(),
 status:z.enum(['prospect','active','former','unclassified']),contact:z.string().trim().max(500),notes:z.string().trim().max(4000),managerId:z.string().trim().min(1).max(100).nullable().optional(),
 kpp:z.string().regex(/^\d{9}$/).nullable().optional(),ogrn:z.string().regex(/^(?:\d{13}|\d{15})$/).nullable().optional(),
 legalAddress:z.string().trim().max(1000).nullable().optional(),registryStatus:z.string().max(50).nullable().optional()});
export type CompanyInput=z.infer<typeof companyInput>;
export function requireOkbAccess(actor:User){assert(globalAccess(actor),403,'ОКБ доступна руководству.');}
export async function crmTeamIds(actor:User){
 const {rows}=await mainPool.query<{id:string}>(`WITH RECURSIVE team(id) AS (
  SELECT employee_id FROM org_reporting WHERE manager_id=$1
  UNION SELECT r.employee_id FROM org_reporting r JOIN team t ON r.manager_id=t.id
 ) SELECT DISTINCT id FROM team WHERE id<>$1`,[actor.id]);
 return rows.map(row=>row.id);
}
export async function clientScope(actor:User,own=false):Promise<string[]|null>{
 if(own)return [actor.id];
 if(globalAccess(actor))return null;
 if(actor.sales_analytics_access)return [actor.id,...(await loadAnalyticsScope(actor,mainPool)).salesIds];
 if(actor.role==='branch_manager')return [actor.id,...await crmTeamIds(actor)];
 return [actor.id];
}
export async function listCompanies(actor:User,query:string,scopeFilter:'mine'|'unassigned'|'accessible'='accessible'){
 if(scopeFilter==='unassigned')requireOkbAccess(actor);
 const scope=await clientScope(actor,scopeFilter==='mine');
 const needle=query.slice(0,250).toLocaleLowerCase('ru-RU').replaceAll('ё','е');
 const russianLower=(column:'name'|'field.value')=>`translate(lower(${column}),'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯё','абвгдеежзийклмнопрстуфхцчшщъыьэюяе')`;
 const matchingManagers=needle?(await mainPool.query<{id:string}>(`SELECT id FROM users WHERE strpos(${russianLower('name')},$1)>0`,[needle])).rows.map(row=>row.id):[];
 const fields=globalAccess(actor)?'*':'id,name,tax_id,status,manager_id,contact,notes,version,updated_at,kpp,ogrn,legal_address,registry_status,last_contact_at';
 return (await okbPool().query(`SELECT ${fields} FROM companies
  WHERE ($2::text[] IS NULL OR manager_id=ANY($2)) AND (NOT $4 OR manager_id IS NULL) AND bitrix_deleted_at IS NULL AND ($1='' OR strpos(${russianLower('name')},$5)>0 OR strpos(coalesce(tax_id,''),$1)>0
   OR manager_id=ANY($3) OR EXISTS (SELECT 1 FROM jsonb_each_text(xlsx_source) AS field WHERE strpos(${russianLower('field.value')},$5)>0))
  ORDER BY lower(name),id LIMIT 100`,[query.slice(0,250),scope,matchingManagers,scopeFilter==='unassigned',needle])).rows;
}
export async function saveCompany(actor:User,input:unknown,id?:string){
 const elevated=globalAccess(actor);
 const value=companyInput.parse(input);
 const version=id?z.object({version:z.number().int().positive()}).parse(input).version:0;
 const db=await okbPool().connect();
 try{
  await db.query('BEGIN');
  // Serialize event writers so a committed event ID is always safe as a reader cursor.
  await db.query('SELECT pg_advisory_xact_lock(431031)');
  const previous=id?(await db.query('SELECT * FROM companies WHERE id=$1 FOR UPDATE',[id])).rows[0]:null;
  if(id)assert(previous&&!previous.bitrix_deleted_at&&(elevated||previous.manager_id===actor.id),404,'Компания недоступна для редактирования.');
  if(!elevated)assert(value.managerId===undefined||value.managerId===actor.id,403,'Ответственного назначает руководство.');
  if(id)assert(previous.version===version,409,'Карточка изменилась. Обновите список.');
  const manager=elevated?(value.managerId===undefined?previous?.manager_id??null:value.managerId):actor.id;
  if(manager)assert((await mainPool.query('SELECT 1 FROM users WHERE id=$1',[manager])).rowCount,400,'Менеджер не найден в системе.');
  const changedManager=manager!==(previous?.manager_id??null);
  const args=[id??randomUUID(),value.name,value.taxId,value.status,value.contact,value.notes,manager,changedManager?'manual':previous?.manager_source??(manager?'manual':null),
   value.kpp===undefined?previous?.kpp??null:value.kpp,value.ogrn===undefined?previous?.ogrn??null:value.ogrn,
   value.legalAddress===undefined?previous?.legal_address??null:value.legalAddress,value.registryStatus===undefined?previous?.registry_status??null:value.registryStatus];
  const company=(await db.query(id?`UPDATE companies SET name=$2,tax_id=$3,status=$4,contact=$5,notes=$6,
   manager_id=$7,manager_source=$8,kpp=$9,ogrn=$10,legal_address=$11,registry_status=$12,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`:
   'INSERT INTO companies(id,name,tax_id,status,contact,notes,manager_id,manager_source,kpp,ogrn,legal_address,registry_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',args)).rows[0];
  if(changedManager)await db.query("INSERT INTO company_responsibility_events(id,company_id,actor_id,source,before_value,after_value) VALUES($1,$2,$3,'manual',$4,$5)",[randomUUID(),company.id,actor.id,JSON.stringify({managerId:previous?.manager_id??null}),JSON.stringify({managerId:manager})]);
  if(previous?.status!==company.status)await db.query(`INSERT INTO company_status_events(event_id,company_id,snapshot) VALUES($1,$2,$3)`,
   [randomUUID(),company.id,JSON.stringify({id:company.id,name:company.name,status:company.status,previousStatus:previous?.status??null})]);
  await db.query('COMMIT');
  return company;
 }catch(e){
  await db.query('ROLLBACK');
  assert((e as {code?:string}).code!=='23505',409,'Компания с таким ИНН уже есть.');
  throw e;
 }finally{db.release();}
}

export async function getCompany(actor:User,id:string){
 const fields=globalAccess(actor)?'*':'id,name,tax_id,status,manager_id,contact,notes,version,updated_at,kpp,ogrn,legal_address,registry_status,last_contact_at';
 const company=(await okbPool().query(`SELECT ${fields} FROM companies WHERE id=$1 AND bitrix_deleted_at IS NULL AND ($2::text[] IS NULL OR manager_id=ANY($2))`,[id,await clientScope(actor)])).rows[0];
 assert(company,404,'Компания не найдена в ОКБ.');
 return company;
}
export async function companyContacts(actor:User,id:string){
 await getCompany(actor,id);
 return (await okbPool().query('SELECT * FROM company_contacts WHERE company_id=$1 ORDER BY occurred_at DESC LIMIT 50',[id])).rows;
}
export async function recordCompanyContact(actor:User,id:string,input:unknown){
 const {note}=z.object({note:z.string().trim().min(3).max(2000)}).parse(input);
 const {rows}=await okbPool().query(`WITH updated AS (UPDATE companies SET last_contact_at=clock_timestamp(),
   updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND bitrix_deleted_at IS NULL AND ($5::text[] IS NULL OR manager_id=ANY($5)) RETURNING id,last_contact_at)
  INSERT INTO company_contacts(id,company_id,author_id,note,occurred_at)
   SELECT $2,id,$3,$4,last_contact_at FROM updated RETURNING *`,[id,randomUUID(),actor.id,note,await clientScope(actor)]);
 assert(rows.length,404,'Компания не найдена в ОКБ.');
 return rows[0];
}
