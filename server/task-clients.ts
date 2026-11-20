import type {Task} from '../shared/types.js';
import type {Db} from './db.js';
import {okbConfigured,okbPool} from './okb.js';

export function importedTaskClient(value:unknown){
 if(typeof value!=='string')return '';
 const name=value.trim();
 return name.length>=2&&!/^(?:[-–—]+|не указана?|без компании|нет)$/iu.test(name)?name:'';
}

export function bitrixCompanyIds(value:unknown){
 const references=Array.isArray(value)?value:[value];
 return [...new Set(references.flatMap(ref=>{
  const match=typeof ref==='string'?/^CO_([1-9]\d{0,17})$/.exec(ref):null;
  return match?[match[1]]:[];
 }))];
}

type Binding={task_id:string;portal:string|null;refs:unknown};
type Client={id:string;name:string;bitrix_portal:string|null;bitrix_id:string|null;bitrix_deleted_at:string|null};
const crmKey=(portal:string,id:string)=>portal+'/'+id;

export async function withTaskClients(tasks:Task[],db:Db):Promise<Task[]>{
 if(!tasks.length)return tasks;
 const explicitIds=[...new Set(tasks.flatMap(task=>task.company_id?[task.company_id]:[]))];
 const bindings=new Map<string,{portal:string;ids:string[]}>();
 const refs=new Map<string,Set<string>>();
 const hasOkb=okbConfigured();
 if(hasOkb){
  const {rows}=await db.query<Binding>(`
   SELECT l.task_id,g.portal,COALESCE(s.raw->'UF_CRM_TASK',s.raw->'ufCrmTask',s.raw->'uf_crm_task') AS refs
   FROM bitrix_task_links l JOIN bitrix_task_snapshots s USING(external_id)
   CROSS JOIN bitrix_rest_gate g
   WHERE g.id=1 AND l.task_id=ANY($1::text[])
  `,[tasks.map(task=>task.id)]);
  for(const row of rows){
   const portal=row.portal||process.env.BITRIX_PORTAL;
   if(!portal)continue;
   const ids=bitrixCompanyIds(row.refs);
   if(!ids.length)continue;
   bindings.set(row.task_id,{portal,ids});
   const wanted=refs.get(portal)??new Set<string>();
   ids.forEach(id=>wanted.add(id));
   refs.set(portal,wanted);
  }
 }
 const clients:Client[]=[];
 if(hasOkb&&(explicitIds.length||refs.size)){
  const links=[...refs].flatMap(([portal,ids])=>[...ids].map(id=>({portal,id})));
  try{
   clients.push(...(await okbPool().query<Client>(`
    SELECT c.id,c.name,c.bitrix_portal,c.bitrix_id::text,c.bitrix_deleted_at
    FROM companies c
    WHERE c.id=ANY($1::uuid[]) OR (
     c.bitrix_deleted_at IS NULL AND (c.bitrix_portal,c.bitrix_id) IN
      (SELECT requested.portal,requested.id FROM jsonb_to_recordset($2::jsonb) requested(portal text,id bigint))
    )
   `,[explicitIds,JSON.stringify(links)])).rows);
  }catch{
   // Company data is optional when the separate OKB database is unavailable.
  }
 }
 const byId=new Map(clients.map(client=>[client.id,client.name]));
 const byBitrix=new Map(clients.flatMap(client=>
  client.bitrix_portal&&client.bitrix_id&&!client.bitrix_deleted_at?[[crmKey(client.bitrix_portal,client.bitrix_id),client.name] as const]:[]));
 return tasks.map(task=>{
  const selected=task.company_id?byId.get(task.company_id):undefined;
  const binding=bindings.get(task.id);
  const linked=(binding?binding.ids.map(id=>byBitrix.get(crmKey(binding.portal,id))):[]).filter((name):name is string=>!!name);
  const imported=importedTaskClient(task.source_fields?.['Компания']);
  const names=selected?[selected]:linked.length?[...new Set(linked)]:imported?[imported]:[];
  return names.length?{...task,client_names:names}:task;
 });
}
