import {z} from 'zod';
import {pool} from './db.js';
import {assert} from './domain.js';
import {clientScope,crmTeamIds,getCompany,okbConfigured,okbPool,requireOkbAccess} from './okb.js';
import {loadAnalyticsScope} from './analytics-scope.js';
import type {User} from '../shared/types.js';

const contactInput=z.object({
 name:z.string().trim().min(2).max(180),position:z.string().trim().max(100).default(''),
 phone:z.string().trim().max(80).default(''),email:z.string().trim().max(254).default(''),
 notes:z.string().trim().max(2000).default('')
});
export async function clientPeople(actor:User,id:string){
 await getCompany(actor,id);
 return (await okbPool().query('SELECT * FROM company_people WHERE company_id=$1 AND archived_at IS NULL ORDER BY name,id',[id])).rows;
}
export async function saveClientPerson(actor:User,id:string,input:unknown,personId?:string){
 const value=contactInput.parse(input),scope=await clientScope(actor);
 const args=[id,scope,value.name,value.position,value.phone,value.email,value.notes];
 const result=await okbPool().query(personId?`UPDATE company_people p SET name=$3,position=$4,phone=$5,email=$6,notes=$7,updated_at=now()
  FROM companies c WHERE p.id=$8 AND p.company_id=c.id AND c.id=$1 AND c.bitrix_deleted_at IS NULL AND ($2::text[] IS NULL OR c.manager_id=ANY($2))
   AND p.archived_at IS NULL RETURNING p.*`:`INSERT INTO company_people(company_id,name,position,phone,email,notes)
  SELECT id,$3,$4,$5,$6,$7 FROM companies WHERE id=$1 AND bitrix_deleted_at IS NULL AND ($2::text[] IS NULL OR manager_id=ANY($2)) RETURNING *`,
  personId?[...args,personId]:args);
 assert(result.rowCount,404,'Компания или контакт недоступны.');
 return result.rows[0];
}
export async function archiveClientPerson(actor:User,id:string,personId:string){
 const result=await okbPool().query(`UPDATE company_people p SET archived_at=now() FROM companies c
  WHERE p.id=$3 AND p.company_id=c.id AND c.id=$1 AND c.bitrix_deleted_at IS NULL AND ($2::text[] IS NULL OR c.manager_id=ANY($2)) AND p.archived_at IS NULL`,
  [id,await clientScope(actor),personId]);
 assert(result.rowCount,404,'Компания или контакт недоступны.');
 return {ok:true};
}

const productInput=z.object({sku:z.string().trim().min(1).max(100),name:z.string().trim().min(2).max(250),
 category:z.enum(['preform','cap','other']),specs:z.string().trim().max(3000).default(''),active:z.boolean().default(true),
 version:z.number().int().positive().optional()});
export async function listProducts(actor:User,query:string,includeArchived=false){
 if(includeArchived)requireOkbAccess(actor);
 return (await okbPool().query(`SELECT * FROM product_catalog WHERE ($2 OR active) AND
  ($1='' OR strpos(lower(name),lower($1))>0 OR strpos(lower(sku),lower($1))>0 OR strpos(lower(specs),lower($1))>0)
  ORDER BY active DESC,name,id LIMIT 200`,[query.slice(0,250),includeArchived])).rows;
}
export async function saveProduct(actor:User,input:unknown,id?:string){
 requireOkbAccess(actor);
 const v=productInput.parse(input);
 const args=[v.sku,v.name,v.category,v.specs,v.active];
 try{
  const result=await okbPool().query(id?`UPDATE product_catalog SET sku=$1,name=$2,category=$3,specs=$4,active=$5,
   updated_at=now(),version=version+1 WHERE id=$6 AND version=$7 RETURNING *`:
   'INSERT INTO product_catalog(sku,name,category,specs,active) VALUES($1,$2,$3,$4,$5) RETURNING *',id?[...args,id,v.version]:args);
  assert(result.rowCount,409,'Позиция изменилась. Обновите каталог.');
  return result.rows[0];
 }catch(error){
  assert((error as {code?:string}).code!=='23505',409,'Позиция с таким артикулом уже есть.');
  throw error;
 }
}

export async function portfolioOverview(actor:User){
 const scope=await loadAnalyticsScope(actor,pool);
 assert(okbConfigured(),503,'Данные ОКБ недоступны.');
 const ids=scope.access==='sales'?[...scope.salesIds]:scope.access==='team'?[actor.id,...await crmTeamIds(actor)]:null;
 return (await okbPool().query(`SELECT count(*)::int total,
  count(*) FILTER(WHERE status='active')::int active,
  count(*) FILTER(WHERE status='prospect')::int prospects,
  count(*) FILTER(WHERE status='active' AND last_contact_at>=now()-interval '30 days')::int contacted,
  count(*) FILTER(WHERE status='active' AND (last_contact_at IS NULL OR last_contact_at<now()-interval '30 days'))::int quiet
  FROM companies WHERE bitrix_deleted_at IS NULL AND ($1::text[] IS NULL OR manager_id=ANY($1))`,[ids])).rows[0];
}
