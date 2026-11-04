import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assert,globalAccess} from './domain.js';
import type {User} from '../shared/types.js';

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
 status:z.enum(['prospect','active','former']),contact:z.string().trim().max(500),notes:z.string().trim().max(4000)});
export type CompanyInput=z.infer<typeof companyInput>;
export function requireOkbAccess(actor:User){assert(globalAccess(actor),403,'ОКБ доступна руководству.');}
export async function listCompanies(actor:User,query:string){
 requireOkbAccess(actor);
 return (await okbPool().query(`SELECT * FROM companies
  WHERE strpos(lower(name),lower($1))>0 OR strpos(coalesce(tax_id,''),$1)>0 OR $1=''
  ORDER BY lower(name),id LIMIT 100`,[query.slice(0,250)])).rows;
}
export async function saveCompany(actor:User,input:unknown,id?:string){
 requireOkbAccess(actor);
 const value=companyInput.parse(input);
 const version=id?z.object({version:z.number().int().positive()}).parse(input).version:0;
 const db=await okbPool().connect();
 try{
  await db.query('BEGIN');
  // Serialize event writers so a committed event ID is always safe as a reader cursor.
  await db.query('SELECT pg_advisory_xact_lock(431031)');
  const previous=id?(await db.query('SELECT * FROM companies WHERE id=$1 FOR UPDATE',[id])).rows[0]:null;
  if(id)assert(previous,404,'Компания не найдена.');
  if(id)assert(previous.version===version,409,'Карточка изменилась. Обновите список.');
  const args=[id??randomUUID(),value.name,value.taxId,value.status,value.contact,value.notes];
  const company=(await db.query(id?`UPDATE companies SET name=$2,tax_id=$3,status=$4,contact=$5,notes=$6,
   version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`:
   'INSERT INTO companies(id,name,tax_id,status,contact,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',args)).rows[0];
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
 requireOkbAccess(actor);
 const company=(await okbPool().query('SELECT * FROM companies WHERE id=$1',[id])).rows[0];
 assert(company,404,'Компания не найдена в ОКБ.');
 return company;
}
export async function companyContacts(actor:User,id:string){
 await getCompany(actor,id);
 return (await okbPool().query('SELECT * FROM company_contacts WHERE company_id=$1 ORDER BY occurred_at DESC LIMIT 50',[id])).rows;
}
export async function recordCompanyContact(actor:User,id:string,input:unknown){
 requireOkbAccess(actor);
 const {note}=z.object({note:z.string().trim().min(3).max(2000)}).parse(input);
 const {rows}=await okbPool().query(`WITH updated AS (UPDATE companies SET last_contact_at=clock_timestamp(),
   updated_at=clock_timestamp(),version=version+1 WHERE id=$1 RETURNING id,last_contact_at)
  INSERT INTO company_contacts(id,company_id,author_id,note,occurred_at)
   SELECT $2,id,$3,$4,last_contact_at FROM updated RETURNING *`,[id,randomUUID(),actor.id,note]);
 assert(rows.length,404,'Компания не найдена в ОКБ.');
 return rows[0];
}
