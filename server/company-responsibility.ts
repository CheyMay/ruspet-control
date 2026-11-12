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
type Company={id:string;name:string;version:number;manager_id:string|null;manager_source:string|null;
 bitrix_manager_id:string|null;bitrix_deleted_at:string|null;xlsx_source?:{manager?:string}};
type WorkingClient={company_id:string|null;assignee_id:string;client:string|null};
type PeopleEvidence={people:Pick<User,'id'|'name'>[];work:WorkingClient[];bitrix:Map<string,string>};
const normalize=(name:unknown)=>typeof name==='string'?name.toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim().replace(/\s+/gu,' '):'';
const normalizePerson=(name:unknown)=>normalize(name).match(/[\p{L}-]+/gu)?.sort().join(' ')||'';
function clientName(value:unknown){
 const name=normalize(value);
 return typeof value==='string'&&name.length>=2&&!/^(?:[-–—]+|не указана?|без компании|нет)$/u.test(name)?value.trim():'';
}
const companyNameSql="regexp_replace(btrim(replace(replace(lower(translate(name,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯё','абвгдеежзийклмнопрстуфхцчшщъыьэюяе')),chr(160),' '),chr(8239),' ')), '[[:space:]]+', ' ', 'g')";

async function companyByName(name:string){
 if(!okbConfigured()||!name)return [];
 return (await okbPool().query<Company>('SELECT * FROM companies WHERE bitrix_deleted_at IS NULL AND '+companyNameSql+'=$1 LIMIT 2',[normalize(name)])).rows;
}
async function readEvidence(db:Db,taskId:string):Promise<PeopleEvidence>{
 const people=(await db.query<Pick<User,'id'|'name'>>("SELECT id,name FROM users WHERE role='employee'")).rows;
 const work=(await db.query<WorkingClient>(`SELECT t.company_id,t.assignee_id,t.source_fields->>'Компания' AS client
  FROM tasks t JOIN users u ON u.id=t.assignee_id
  WHERE t.id<>$1 AND t.status<>'completed' AND u.role='employee'
   AND (t.company_id IS NOT NULL OR nullif(t.source_fields->>'Компания','') IS NOT NULL)`,[taskId])).rows;
 const bitrix=(await db.query<{external_id:string;user_id:string}>('SELECT external_id,user_id FROM bitrix_user_links')).rows;
 return {people,work,bitrix:new Map(bitrix.map(row=>[String(row.external_id),row.user_id]))};
}
function managerForCompany(task:Task,company:Company|null,name:string,available:User[],evidence:PeopleEvidence,matchName:boolean):ResponsibilityHint{
 const result={...empty('У клиента не указан ответственный. Выберите менеджера вручную.'),companyId:company?.id??null,companyName:company?.name||name||null};
 if(company?.bitrix_deleted_at)return {...result,reason:'Компания удалена в Битрикс24. Проверьте связь с ОКБ.'};
 let managerId=company?.manager_id??null;
 let source:ResponsibilityHint['source']=company?.manager_source==='bitrix'?'bitrix':'okb';
 if(source==='bitrix'&&company?.bitrix_manager_id){
  managerId=evidence.bitrix.get(String(company.bitrix_manager_id))??null;
  if(!managerId)return {...result,source,reason:'Ответственный Битрикс24 ещё не сопоставлен с профилем РУСПЭТ. Выберите менеджера вручную.'};
 }
 const imported=company?.xlsx_source?.manager?.trim();
 if(!managerId&&imported){
  const exact=normalizePerson(imported);
  const matches=exact.split(' ').length>1?evidence.people.filter(person=>normalizePerson(person.name)===exact):[];
  if(matches.length===1){managerId=matches[0].id;source='excel';}
 }
 if(!managerId){
  const companyId=company?.id??task.company_id??null,label=normalize(name);
  const working=[...new Set(evidence.work.filter(row=>row.company_id?row.company_id===companyId:
   matchName&&!!label&&normalize(row.client)===label).map(row=>row.assignee_id))];
  if(working.length>1)return {...result,reason:'С клиентом работают несколько менеджеров. Выберите исполнителя вручную.'};
  if(working.length===1){managerId=working[0];source='tasks';}
  else if(imported)return {...result,reason:'В выгрузке ОКБ указан '+imported+'. Выберите его профиль или назначьте ответственного в ОКБ.'};
  else return result;
 }
 const person=available.find(p=>p.id===managerId);
 if(!person)return {...result,source,reason:'Менеджер клиента вне доступных подчинённых. Проверьте оргструктуру.'};
 const token=createHash('sha256').update(JSON.stringify({companyId:result.companyId,companyName:normalize(result.companyName),version:company?.version,managerId,source,bitrixManager:company?.bitrix_manager_id})).digest('hex');
 return {...result,source,managerId,managerName:person.name,token,reason:null};
}

export async function resolveCompanyResponsibility(task:Task,available:User[],db:Db=pool,selectedCompanyId?:string):Promise<ResponsibilityHint>{
 assert(!selectedCompanyId||!task.company_id||selectedCompanyId===task.company_id,409,'У задачи уже указан другой клиент. Измените связь в карточке задачи.');
 assert(!selectedCompanyId||okbConfigured(),503,'ОКБ недоступна. Выберите исполнителя или попробуйте позже.');
 try{
  let company:Company|null=null;
  const name=clientName(task.source_fields?.['Компания']),explicitId=selectedCompanyId||task.company_id;
  if(explicitId&&okbConfigured()){
   company=(await okbPool().query<Company>('SELECT * FROM companies WHERE id=$1',[explicitId])).rows[0]??null;
   if(selectedCompanyId)assert(company,404,'Компания не найдена в ОКБ.');
  }
  if(!explicitId){
   const snapshot=(await db.query('SELECT s.raw,g.portal FROM bitrix_task_links l JOIN bitrix_task_snapshots s ON s.external_id=l.external_id CROSS JOIN bitrix_rest_gate g WHERE l.task_id=$1 AND g.id=1',[task.id])).rows[0];
   const references=snapshot?.raw?fieldValue(snapshot.raw,'UF_CRM_TASK'):null;
   const values=Array.isArray(references)?references:typeof references==='string'?[references]:[];
   const companies=[...new Set(values.map(String).filter(v=>/^CO_[1-9]\d*$/.test(v)).map(v=>v.slice(3)))];
   if(companies.length>1)return empty('В задаче несколько компаний. Выберите нужного клиента.');
   if(companies.length===1){
    if(okbConfigured())company=(await okbPool().query<Company>('SELECT * FROM companies WHERE bitrix_portal=$1 AND bitrix_id=$2',[snapshot.portal||process.env.BITRIX_PORTAL,companies[0]])).rows[0]??null;
    if(!company)return empty('Компания из Битрикс24 ещё не найдена в ОКБ. Выберите клиента или исполнителя.');
   }
  }
  const label=company?.name||name,matches=await companyByName(label);
  if(!company&&!explicitId){
   if(matches.length>1)return {...empty('В ОКБ несколько компаний с таким названием. Выберите нужного клиента.'),companyName:label};
   company=matches[0]??null;
  }
  if(!company&&!label&&!task.company_id)return empty(okbConfigured()?'Клиент не указан. Выберите компанию или исполнителя.':'Клиент не указан. ОКБ недоступна; выберите исполнителя.');
  return managerForCompany(task,company,label,available,await readEvidence(db,task.id),matches.length<=1);
 }catch(error){
  if(error instanceof Error&&'status' in error)throw error;
  assert(!selectedCompanyId,503,'Не удалось проверить клиента в ОКБ. Выберите исполнителя или попробуйте позже.');
  return empty('Не удалось определить менеджера клиента. Выберите исполнителя вручную.');
 }
}

export async function findDelegationClients(task:Task,available:User[],query:string,wideAccess:boolean,db:Db){
 if(!okbConfigured())return [];
 const needle=normalize(query);
 if(needle.length<2)return [];
 const rows=(await okbPool().query<Company&{same_name:number}>(
  'SELECT *,count(*) OVER(PARTITION BY '+companyNameSql+')::int AS same_name FROM companies WHERE bitrix_deleted_at IS NULL AND (strpos('+companyNameSql+', $1)>0 OR tax_id=$1) ORDER BY name,id LIMIT 30',[needle])).rows;
 if(wideAccess)return rows.slice(0,12).map(({id,name})=>({id,name}));
 const evidence=await readEvidence(db,task.id);
 return rows.filter(company=>managerForCompany(task,company,company.name,available,evidence,company.same_name===1).managerId)
  .slice(0,12).map(({id,name})=>({id,name}));
}
export async function companyResponsibility(actor:User,id:string){
 const company=await getCompany(actor,id);
 const local=company.manager_source==='bitrix'&&company.bitrix_manager_id?(await pool.query('SELECT user_id FROM bitrix_user_links WHERE external_id=$1',[company.bitrix_manager_id])).rows[0]?.user_id:company.manager_id;
 const manager=local?(await pool.query('SELECT id,name,role FROM users WHERE id=$1',[local])).rows[0]:null;
 return {companyId:id,version:company.version,deletedInBitrix:!!company.bitrix_deleted_at,manager:manager||null,source:company.manager_source||null,externalManagerId:company.bitrix_manager_id?String(company.bitrix_manager_id):null,syncedAt:company.bitrix_synced_at};
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
   const responsibilityChanged=!previous||!!previous.bitrix_deleted_at||previous.manager_id!==manager||String(previous.bitrix_manager_id||'')!==(item.externalManagerId||'')||previous.manager_source!=='bitrix';
   const id=previous?.id||randomUUID();result.push({externalId:item.externalId,companyId:previous?.id||null,action:previous?'update':'create',managerMapped:!!manager});
   if(value.dryRun)continue;
   const company=(await database.query(previous?`UPDATE companies SET name=$2,manager_id=$3,manager_source='bitrix',bitrix_portal=$4,bitrix_id=$5,bitrix_manager_id=$6,bitrix_snapshot=$7,bitrix_synced_at=now(),bitrix_deleted_at=NULL,
    version=version+CASE WHEN name IS DISTINCT FROM $2 OR manager_id IS DISTINCT FROM $3 OR bitrix_manager_id IS DISTINCT FROM $6::bigint OR manager_source IS DISTINCT FROM 'bitrix' OR bitrix_deleted_at IS NOT NULL THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 RETURNING *`:
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
 const result=await request<Record<string,unknown>[]>('crm.company.list',{order:{ID:'ASC'},filter:{'>ID':after},select:['*','UF_*'],start:-1});
 assert(Array.isArray(result)&&result.length<=50,502,'Ожидалась одна страница компаний Битрикс24.');
 let cursor=after;
 const companies=result.map(raw=>{const id=bitrixId(raw.ID);assert(id&&BigInt(id)>BigInt(cursor),502,'Нарушен порядок ID компаний.');cursor=id;assert(typeof raw.TITLE==='string'&&raw.TITLE.trim(),502,'У компании нет названия.');const manager=bitrixId(raw.ASSIGNED_BY_ID);assert(raw.ASSIGNED_BY_ID==null||raw.ASSIGNED_BY_ID===''||raw.ASSIGNED_BY_ID==='0'||raw.ASSIGNED_BY_ID===0||manager,502,'Некорректный ID ответственного компании.');return {externalId:id,name:raw.TITLE,externalManagerId:manager,raw};});
 return {companies,cursor,complete:result.length<50};
}
