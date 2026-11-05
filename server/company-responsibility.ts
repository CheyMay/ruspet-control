import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,type Db} from './db.js';
import {okbPool,okbConfigured,requireOkbAccess,getCompany} from './okb.js';
import {assert} from './domain.js';
import {fieldValue} from './bitrix-fields.js';
import {bitrixId} from './bitrix-sync.js';
import type {BitrixRequest} from './bitrix-rest.js';
import type {User,Task} from '../shared/types.js';
import type {ResponsibilityHint} from '../shared/company-responsibility.js';
const empty=(reason:string):ResponsibilityHint=>({managerId:null,managerName:null,source:null,companyId:null,companyName:null,token:null,reason});
export async function resolveCompanyResponsibility(task:Task,available:User[],db:Db=pool):Promise<ResponsibilityHint>{
 if(!okbConfigured())return empty('ОКБ не подключена. Выберите исполнителя вручную.');
 try{
  let company:any=null;
  if(task.company_id)company=(await okbPool().query('SELECT * FROM companies WHERE id=$1',[task.company_id])).rows[0];
  else{
   const snapshot=(await db.query('SELECT s.raw,g.portal FROM bitrix_task_links l JOIN bitrix_task_snapshots s ON s.external_id=l.external_id CROSS JOIN bitrix_rest_gate g WHERE l.task_id=$1 AND g.id=1',[task.id])).rows[0];
   const references=snapshot?.raw?fieldValue(snapshot.raw,'UF_CRM_TASK'):null;
   const values=Array.isArray(references)?references:typeof references==='string'?[references]:[];
   const companies=[...new Set(values.map(String).filter(v=>/^CO_[1-9]\d*$/.test(v)).map(v=>v.slice(3)))];
   if(companies.length>1)return empty('В задаче несколько компаний. Укажите нужную компанию или выберите менеджера вручную.');
   if(companies.length===1)company=(await okbPool().query('SELECT * FROM companies WHERE bitrix_portal=$1 AND bitrix_id=$2',[snapshot.portal||process.env.BITRIX_PORTAL,companies[0]])).rows[0];
  }
  if(!company)return empty('Компания не связана с ОКБ или ещё не загружена из Битрикс24. Выберите менеджера вручную.');
  let managerId=company.manager_id;
  if(company.manager_source==='bitrix'&&company.bitrix_manager_id){const link=(await db.query('SELECT user_id FROM bitrix_user_links WHERE external_id=$1',[company.bitrix_manager_id])).rows[0];managerId=link?.user_id||null;}
  const result:ResponsibilityHint={...empty('У компании не указан ответственный менеджер. Выберите его вручную.'),companyId:company.id,companyName:company.name,source:company.manager_source==='bitrix'?'bitrix':'okb'};
  if(!managerId){result.reason=company.manager_source==='bitrix'&&company.bitrix_manager_id?'Ответственный Битрикс24 ещё не сопоставлен с профилем РУСПЭТ. Выберите менеджера вручную.':result.reason;return result;}
  const person=available.find(p=>p.id===managerId);
  if(!person){result.reason='Ответственный компании вне доступных подчинённых. Проверьте оргструктуру или выберите исполнителя вручную.';return result;}
  return {...result,managerId:person.id,managerName:person.name,reason:null,token:createHash('sha256').update(JSON.stringify({companyId:company.id,version:company.version,managerId:person.id,source:company.manager_source,bitrixManager:company.bitrix_manager_id})).digest('hex')};
 }catch(error){
  if(error instanceof Error&&'status' in error)throw error;
  return empty('Не удалось прочитать ОКБ. Ответственный не определён; выберите менеджера вручную.');
 }
}
export async function companyResponsibility(actor:User,id:string){
 const company=await getCompany(actor,id);
 const local=company.manager_source==='bitrix'&&company.bitrix_manager_id?(await pool.query('SELECT user_id FROM bitrix_user_links WHERE external_id=$1',[company.bitrix_manager_id])).rows[0]?.user_id:company.manager_id;
 const manager=local?(await pool.query('SELECT id,name,role FROM users WHERE id=$1',[local])).rows[0]:null;
 return {companyId:id,version:company.version,manager:manager||null,source:company.manager_source||null,externalManagerId:company.bitrix_manager_id?String(company.bitrix_manager_id):null,syncedAt:company.bitrix_synced_at};
}
const incomingCompany=z.object({externalId:z.string().regex(/^[1-9]\d{0,17}$/),name:z.string().trim().min(1).max(250),externalManagerId:z.string().regex(/^[1-9]\d{0,17}$/).nullable(),raw:z.record(z.string(),z.unknown())}).refine(item=>
 bitrixId(item.raw.ID)===item.externalId&&typeof item.raw.TITLE==='string'&&item.raw.TITLE.trim()===item.name&&bitrixId(item.raw.ASSIGNED_BY_ID)===item.externalManagerId,
 'Поля компании не совпадают с исходным снимком Битрикс24.');
export const companySyncInput=z.object({portal:z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+$/).max(250),dryRun:z.boolean().default(true),companies:z.array(incomingCompany).min(1).max(50).refine(a=>new Set(a.map(c=>c.externalId)).size===a.length,'В пакете повторяются компании.')});
export async function syncCompanySnapshots(actor:User,input:unknown){
 requireOkbAccess(actor);assert(actor.role==='admin',403,'Импорт компаний выполняет администратор.');
 const value=companySyncInput.parse(input),configured=(await pool.query('SELECT portal FROM bitrix_rest_gate WHERE id=1')).rows[0]?.portal||process.env.BITRIX_PORTAL;
 assert(configured&&configured===value.portal,409,'Портал не совпадает с подтверждённым порталом интеграции.');
 const database=await okbPool().connect();
 try{
  await database.query('BEGIN');await database.query('SELECT pg_advisory_xact_lock(431031)');
  const result:{externalId:string;companyId:string|null;action:string;managerMapped:boolean}[]=[];
  for(const item of value.companies){
   const previous=(await database.query('SELECT * FROM companies WHERE bitrix_portal=$1 AND bitrix_id=$2 FOR UPDATE',[value.portal,item.externalId])).rows[0];
   const manager=item.externalManagerId?(await pool.query('SELECT user_id FROM bitrix_user_links WHERE external_id=$1',[item.externalManagerId])).rows[0]?.user_id||null:null;
   const responsibilityChanged=!previous||previous.manager_id!==manager||String(previous.bitrix_manager_id||'')!==(item.externalManagerId||'')||previous.manager_source!=='bitrix';
   const id=previous?.id||randomUUID();result.push({externalId:item.externalId,companyId:previous?.id||null,action:previous?'update':'create',managerMapped:!!manager});
   if(value.dryRun)continue;
   const company=(await database.query(previous?`UPDATE companies SET name=$2,manager_id=$3,manager_source='bitrix',bitrix_portal=$4,bitrix_id=$5,bitrix_manager_id=$6,bitrix_snapshot=$7,bitrix_synced_at=now(),
    version=version+CASE WHEN name IS DISTINCT FROM $2 OR manager_id IS DISTINCT FROM $3 OR bitrix_manager_id IS DISTINCT FROM $6::bigint OR manager_source IS DISTINCT FROM 'bitrix' THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 RETURNING *`:
    `INSERT INTO companies(id,name,manager_id,manager_source,bitrix_portal,bitrix_id,bitrix_manager_id,bitrix_snapshot,bitrix_synced_at,status,contact,notes) VALUES($1,$2,$3,'bitrix',$4,$5,$6,$7,now(),'unclassified','','') RETURNING *`,[id,item.name,manager,value.portal,item.externalId,item.externalManagerId,JSON.stringify(item.raw)])).rows[0];
   result[result.length-1].companyId=company.id;
   if(responsibilityChanged)await database.query('INSERT INTO company_responsibility_events(id,company_id,actor_id,source,before_value,after_value) VALUES($1,$2,$3,\'bitrix\',$4,$5)',[randomUUID(),company.id,actor.id,previous?JSON.stringify({managerId:previous.manager_id,externalManagerId:previous.bitrix_manager_id}):null,JSON.stringify({managerId:manager,externalManagerId:item.externalManagerId})]);
   if(!previous)await database.query('INSERT INTO company_status_events(event_id,company_id,snapshot) VALUES($1,$2,$3)',[randomUUID(),company.id,JSON.stringify({id:company.id,name:company.name,status:'unclassified',previousStatus:null})]);
  }
  await database.query(value.dryRun?'ROLLBACK':'COMMIT');return {dryRun:value.dryRun,companies:result};
 }catch(error){await database.query('ROLLBACK');throw error;}finally{database.release();}
}
export async function fetchBitrixCompanies(request:BitrixRequest,after='0'){
 assert(after==='0'||bitrixId(after),400,'Некорректный курсор компаний.');
 const result=await request<Record<string,unknown>[]>('crm.company.list',{order:{ID:'ASC'},filter:{'>ID':after},select:['*','UF_*'],start:0});
 assert(Array.isArray(result)&&result.length<=50,502,'Ожидалась одна страница компаний Битрикс24.');
 let cursor=after;
 const companies=result.map(raw=>{const id=bitrixId(raw.ID);assert(id&&BigInt(id)>BigInt(cursor),502,'Нарушен порядок ID компаний.');cursor=id;assert(typeof raw.TITLE==='string'&&raw.TITLE.trim(),502,'У компании нет названия.');const manager=bitrixId(raw.ASSIGNED_BY_ID);assert(raw.ASSIGNED_BY_ID==null||raw.ASSIGNED_BY_ID===''||raw.ASSIGNED_BY_ID==='0'||raw.ASSIGNED_BY_ID===0||manager,502,'Некорректный ID ответственного компании.');return {externalId:id,name:raw.TITLE,externalManagerId:manager,raw};});
 return {companies,cursor,complete:result.length<50};
}
