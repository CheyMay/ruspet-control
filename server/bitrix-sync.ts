import {randomUUID} from 'node:crypto';
import type {Task} from '../shared/types.js';
import {pool,transaction,type Db} from './db.js';
import {MockTaskProvider} from './providers.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {fullSelection} from './bitrix-fields.js';

type Values={title:string;description:string;deadline:string|null};
type Remote=Values&{id:string;status:string|null;responsibleId:string|null;createdBy:string|null;chatId:string|null};
export const taskFields=['ID','TITLE','DESCRIPTION','DEADLINE','STATUS','RESPONSIBLE_ID','CREATED_BY'];
const keys=['title','description','deadline'] as const;
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export function bitrixId(value:unknown){
 const id=String(value??'');
 return /^[1-9]\d{0,17}$/.test(id)?id:null;
}
export function remoteTask(value:Record<string,unknown>):Remote{
 const id=bitrixId(value.id),deadline=date(value.deadline);
 if(!id||typeof value.title!=='string'||!value.title.trim()||typeof value.description!=='string'||!Object.hasOwn(value,'deadline')||(value.deadline&&!deadline)){
  throw new BitrixError('Ответ Битрикс24 не содержит обязательных полей задачи.');
 }
 return {id,title:value.title,description:value.description,deadline,status:value.status==null?null:String(value.status),
  responsibleId:bitrixId(value.responsibleId),createdBy:bitrixId(value.createdBy),chatId:bitrixId(value.chatId)};
}
export function planFields(base:Values,local:Values,remote:Values){
 const conflict=keys.filter(k=>local[k]!==base[k]&&remote[k]!==base[k]&&local[k]!==remote[k]);
 const outbound=keys.filter(k=>local[k]!==base[k]&&local[k]!==remote[k]);
 const inbound=keys.filter(k=>remote[k]!==base[k]&&local[k]===base[k]);
 return {conflict,outbound,inbound};
}
async function stage(task:Remote,db:Db=pool,raw:Record<string,unknown>|null=null){
 await db.query(`INSERT INTO bitrix_task_snapshots(external_id,snapshot,raw) VALUES($1,$2,$3)
 ON CONFLICT(external_id) DO UPDATE SET snapshot=excluded.snapshot,raw=coalesce(excluded.raw,bitrix_task_snapshots.raw),fetched_at=now()`,[task.id,JSON.stringify(task),raw?JSON.stringify(raw):null]);
}
export async function scanProject(request:BitrixRequest,groupId:string,after:string,maxPages:number){
 let cursor=after,total=0;
 for(let page=0;page<maxPages;page++){
  const result=await request<{tasks:Record<string,unknown>[]}>('tasks.task.list',{order:{ID:'asc'},filter:{GROUP_ID:groupId,'>ID':cursor},select:await fullSelection()});
  if(!Array.isArray(result.tasks))throw new BitrixError('Нет списка задач в ответе REST.');
  if(!result.tasks.length)return {total,cursor,complete:true};
  for(const row of result.tasks){
   const task=remoteTask(row);
   if(BigInt(task.id)<=BigInt(cursor))throw new BitrixError('Битрикс24 вернул задачи вне ожидаемого порядка.');
   await stage(task,pool,row);cursor=task.id;total++;
  }
 }
 return {total,cursor,complete:false};
}
async function getRemote(request:BitrixRequest,id:string,db:Db=pool){
 const result=await request<{task:Record<string,unknown>}>('tasks.task.get',{taskId:id,select:await fullSelection(db)});
 const task=remoteTask(result.task??{});
 if(task.id!==id)throw new BitrixError('Битрикс24 вернул другой ID задачи.');
 await stage(task,db,result.task);
 return task;
}
export async function linkTask(request:BitrixRequest,taskId:string,externalId:string,acceptBitrix=false){
 const remote=await getRemote(request,externalId);
 return transaction(async db=>{
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  if(!task)throw new BitrixError('Локальная задача не найдена.');
  const differences=keys.filter(k=>task[k]!==remote[k]);
  if(differences.length&&!acceptBitrix)return {linked:false,differences};
  await db.query('INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO NOTHING',[taskId,externalId,JSON.stringify({title:task.title,description:task.description,deadline:task.deadline}),task.version]);
  const link=(await db.query('SELECT external_id FROM bitrix_task_links WHERE task_id=$1',[taskId])).rows[0];
  return {linked:String(link.external_id)===externalId,differences};
 });
}
export async function syncLinkedTask(request:BitrixRequest,taskId:string,allowWrite:boolean){
 const link=(await pool.query('SELECT * FROM bitrix_task_links WHERE task_id=$1',[taskId])).rows[0];
 if(!link)throw new BitrixError('Задача не связана с Битрикс24.');
 if(link.live_enabled)throw new BitrixError('Эта задача использует очередь пилота. Запустите scripts/bitrix-pilot.ts watch.');
 let remote=await getRemote(request,String(link.external_id));
 return transaction(async db=>{
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  const current=(await db.query('SELECT baseline FROM bitrix_task_links WHERE task_id=$1 FOR UPDATE',[taskId])).rows[0];
  let plan=planFields(current.baseline,task,remote);
  if(plan.conflict.length||(!allowWrite&&plan.outbound.length)){
   const reason=plan.conflict.length?'Различаются правки полей: '+plan.conflict.join(', '):'Локальные изменения ожидают включения записи.';
   await db.query('UPDATE bitrix_task_links SET conflict=$2,checked_at=now() WHERE task_id=$1',[taskId,reason]);
   return plan;
  }
  if(plan.outbound.length){
   const fields=Object.fromEntries(plan.outbound.map(k=>[k.toUpperCase(),task[k]]));
   if(fields.DEADLINE===null)throw new BitrixError('Снятие крайнего срока требует отдельной проверки на пилоте.');
   await pool.query(`UPDATE task_sync_queue SET attempts=attempts+1 WHERE task_id=$1
    AND task_version>$2 AND task_version<=$3 AND state IN ('pending','failed')
    AND payload->>'kind' IN ('task_edited','deadline_changed','action_undone')`,[taskId,link.linked_version,task.version]);
   await request('tasks.task.update',{taskId:remote.id,fields});
   remote=await getRemote(request,remote.id,db);
   if(plan.outbound.some(k=>task[k]!==remote[k]))throw new BitrixError('Запись в Битрикс24 не подтвердилась контрольным чтением.');
   plan={...plan,inbound:planFields(current.baseline,task,remote).inbound};
  }
  if(plan.inbound.length){
   const next={...task,...Object.fromEntries(plan.inbound.map(k=>[k,remote[k]]))};
   const updated=(await db.query<Task>(`UPDATE tasks SET title=$2,description=$3,deadline=$4,code=$5,
     version=version+1,updated_at=now(),transfer_count=transfer_count+CASE WHEN deadline IS DISTINCT FROM $4::timestamptz THEN 1 ELSE 0 END
     WHERE id=$1 RETURNING *`,[taskId,next.title,next.description,next.deadline,next.title.split(/\s/)[0]])).rows[0];
   await new MockTaskProvider().applyApprovedChange(db,updated,task.version);
   await db.query("UPDATE approvals SET state='stale' WHERE task_id=$1 AND state='pending'",[taskId]);
   await db.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,'bitrix_change','Поля обновлены из Битрикс24',$3)",[randomUUID(),taskId,JSON.stringify({before:task,after:updated})]);
  }
  await db.query(`UPDATE task_sync_queue SET state='sent',retry_at=NULL WHERE task_id=$1 AND task_version>$2 AND task_version<=$3
   AND state IN ('pending','failed') AND payload->>'kind' IN ('task_edited','deadline_changed','action_undone')
   AND attempts>0`,[taskId,link.linked_version,task.version]);
  await db.query('UPDATE bitrix_task_links SET baseline=$2,conflict=NULL,checked_at=now() WHERE task_id=$1',[taskId,JSON.stringify(remote)]);
  return plan;
 });
}
export async function syncActivity(request:BitrixRequest,taskId:string,olderThan?:string){
 const link=(await pool.query('SELECT external_id FROM bitrix_task_links WHERE task_id=$1',[taskId])).rows[0];
 if(!link)throw new BitrixError('Задача не связана с Битрикс24.');
 const task=await getRemote(request,String(link.external_id));
 if(!task.chatId&&process.env.BITRIX_LEGACY_COMMENTS!=='true')throw new BitrixError('Чат задачи не доступен. Проверьте версию карточки и права вебхука.');
 const result:{messages:Record<string,unknown>[];users:{id:number;name:string}[]}=task.chatId?
  await request<{messages:Record<string,unknown>[];users:{id:number;name:string}[]}>('im.dialog.messages.get',{DIALOG_ID:'chat'+task.chatId,LIMIT:50,...(olderThan?{LAST_ID:olderThan}:{})}):
  {messages:(await request<Record<string,unknown>[]>('task.commentitem.getlist',{TASKID:task.id,ORDER:{POST_DATE:'desc'},FILTER:{}}))
    .map(row=>({id:row.ID,date:row.POST_DATE,text:row.POST_MESSAGE,author:row.AUTHOR_NAME})),users:[]};
 const history=await request<{list:Record<string,unknown>[]}>('tasks.task.history.list',{taskId:task.id});
 if(!Array.isArray(result.messages)||!Array.isArray(history.list))throw new BitrixError('Не удалось прочитать обсуждение или историю.');
 await transaction(async db=>{
  for(const [kind,records] of [['comment',result.messages],['history',history.list]] as const){
   for(const record of records){
    const id=bitrixId(record.id),when=date(kind==='comment'?record.date:record.createdDate);
    if(!id||!when)continue;
    const person=record.user as {name?:string;lastName?:string}|undefined;
    const author=kind==='comment'?(result.users||[]).find(u=>String(u.id)===String(record.author_id))?.name||String(record.author??''):[person?.name,person?.lastName].filter(Boolean).join(' ');
    const value=record.value as {from?:unknown;to?:unknown}|undefined;
    const body=kind==='comment'?String(record.text??''):[record.field,value?.from,value?.to].filter(v=>v!=null).map(v=>typeof v==='object'?JSON.stringify(v):String(v)).join(' · ');
    await db.query(`INSERT INTO bitrix_task_activity(task_id,kind,external_id,occurred_at,author,body) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(task_id,kind,external_id) DO UPDATE SET occurred_at=excluded.occurred_at,author=excluded.author,body=excluded.body`,[taskId,kind,id,when,author||'Битрикс24',body]);
   }
  }
 });
 const oldest=result.messages.map(m=>bitrixId(m.id)).filter((id):id is string=>!!id).reduce<string|null>((min,id)=>!min||BigInt(id)<BigInt(min)?id:min,null);
 return {messages:result.messages.length,history:history.list.length,olderThan:oldest};
}
