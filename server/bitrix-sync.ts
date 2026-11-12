import {customFieldMappings,encodeCustomField,decodeCustomField} from './bitrix-custom-fields.js';
import {parsePrice} from '../shared/pricing.js';
import {safeBitrixData} from './bitrix-data.js';
import {ensureBitrixUser} from './bitrix-users.js';
import {randomUUID} from 'node:crypto';
import type {Task} from '../shared/types.js';
import {pool,transaction,type Db} from './db.js';
import {MockTaskProvider} from './providers.js';
import {BitrixError,bitrixControl,type BitrixRequest} from './bitrix-rest.js';

type Values={custom_fields?:{label:string;value:string}[];title:string;description:string;deadline:string|null;status?:Task['status'];assignee_id?:string;creator_id?:string;price?:number|string|null;accomplice_ids?:string[];auditor_ids?:string[];important?:boolean|null;customer_risk?:boolean|null;planned_start?:string|null;planned_end?:string|null;priority?:'normal'|'high'};
type Remote=Omit<Values,'status'>&{id:string;status:string|null;responsibleId:string|null;createdBy:string|null;chatId:string|null;closedDate:string|null;xmlId:string|null;extras:Record<string,unknown>};
export const taskFields=['ID','TITLE','DESCRIPTION','DEADLINE','STATUS','RESPONSIBLE_ID','CREATED_BY','CLOSED_DATE','XML_ID','START_DATE_PLAN','END_DATE_PLAN','PRIORITY','ACCOMPLICES','AUDITORS','UF_*'];
const keys=['title','description','deadline','status','assignee_id','creator_id','planned_start','planned_end','priority','price','important','customer_risk','accomplice_ids','auditor_ids','custom_fields'] as const;
const fieldNames={title:'TITLE',description:'DESCRIPTION',deadline:'DEADLINE',status:'STATUS',assignee_id:'RESPONSIBLE_ID',creator_id:'CREATED_BY',planned_start:'START_DATE_PLAN',planned_end:'END_DATE_PLAN',priority:'PRIORITY',price:'@price',important:'@important',customer_risk:'@customer_risk',accomplice_ids:'ACCOMPLICES',auditor_ids:'AUDITORS',custom_fields:'@custom_fields'} as const;
export function localBitrixStatus(status:string):Task['status']{
 if(['1','2','3','6'].includes(status))return 'active';
 if(status==='4')return 'review';
 if(status==='5')return 'completed';
 throw new BitrixError('Неизвестный статус задачи Битрикс24.');
}
export async function remoteValues(remote:Remote,db:Db=pool,task?:Task,previousCustom?:Task['custom_fields']):Promise<Values>{
 const values:Values={title:remote.title,description:remote.description,deadline:remote.deadline};
 if(remote.status!==null)values.status=localBitrixStatus(remote.status);
 for(const [external,key] of [[remote.responsibleId,'assignee_id'],[remote.createdBy,'creator_id']] as const){
  if(!external)continue;
  const person=(await db.query('SELECT user_id FROM bitrix_user_links WHERE external_id=$1',[external])).rows[0];
  if(!person)throw new BitrixError('Нет привязки сотрудника Битрикс24 #'+external+'. Выполните map-user.');
  values[key]=person.user_id;
 }
 for(const [key,field] of [['planned_start','startDatePlan'],['planned_end','endDatePlan']] as const)if(Object.hasOwn(remote.extras,field)){
  const raw=remote.extras[field];if(raw&&!date(raw))throw new BitrixError('Неверная плановая дата Битрикс24.');values[key]=date(raw);
 }
 if(Object.hasOwn(remote.extras,'priority'))values.priority=String(remote.extras.priority)==='2'?'high':'normal';
 const mapping=(await db.query('SELECT * FROM bitrix_field_map')).rows;
 for(const entry of mapping){
  const field=Object.keys(remote.extras).find(k=>k.replace(/_/g,'').toLowerCase()===entry.external_code.replace(/_/g,'').toLowerCase());
  if(!field)continue;
  const raw=remote.extras[field];
  if(entry.local_key==='price'){
   const price=parsePrice(raw);if(raw!==null&&raw!==''&&price===null)throw new BitrixError('Неверная цена в поле Битрикс24.');values.price=price;
  }else{
   if(![null,'',true,false,0,1,'0','1','Y','N'].includes(raw as any))throw new BitrixError('Неверное логическое поле Битрикс24.');
   values[entry.local_key as 'important'|'customer_risk']=raw===null||raw===''?null:[true,1,'1','Y'].includes(raw as any);
  }
 }
 for(const [key,field] of [['accomplice_ids','accomplices'],['auditor_ids','auditors']] as const){
  if(!Object.hasOwn(remote.extras,field))continue;
  const list=remote.extras[field];if(!Array.isArray(list)||list.some(id=>!bitrixId(id)))throw new BitrixError('Неверный список участников задачи.');
  const members=(await db.query('SELECT user_id,external_id FROM bitrix_user_links WHERE external_id=ANY($1::bigint[])',[list.map(String)])).rows;
  if(members.length!==new Set(list.map(String)).size)throw new BitrixError('Не все участники задачи сопоставлены.');
  values[key]=members.map(row=>row.user_id).sort();
 }
 if(task?.custom_fields?.length){
  const custom=await customFieldMappings(task.custom_fields,db);
  const fields=custom.map(entry=>({entry,key:Object.keys(remote.extras).find(k=>k.replace(/_/g,'').toLowerCase()===entry.code.replace(/_/g,'').toLowerCase())}));
  if(fields.every(field=>field.key))values.custom_fields=fields.map(({entry,key})=>{
   const raw=remote.extras[key!];
   const canonical=(value:unknown)=>JSON.stringify(encodeCustomField(decodeCustomField(value,entry.metadata),entry.metadata));
   const actual=canonical(raw),local=canonical(encodeCustomField(entry.local.value,entry.metadata));
   const previous=previousCustom?.find(field=>field.label===entry.local.label);
   const value=actual===local?entry.local.value:previous&&actual===canonical(encodeCustomField(previous.value,entry.metadata))?previous.value:decodeCustomField(raw,entry.metadata);
   return {label:entry.local.label,value};
  });
 }
 return values;
}
export const localValues=(task:Task,remote:Values):Values=>Object.fromEntries(keys.filter(k=>Object.hasOwn(remote,k)).map(k=>[k,task[k]])) as Values;
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
  responsibleId:bitrixId(value.responsibleId),createdBy:bitrixId(value.createdBy),chatId:bitrixId(value.chatId),closedDate:date(value.closedDate),xmlId:typeof value.xmlId==='string'?value.xmlId:null,extras:value.extras&&typeof value.extras==='object'?value.extras as Record<string,unknown>:value};
}
const same=(key:typeof keys[number],a:unknown,b:unknown)=>key==='price'?parsePrice(a)===parsePrice(b):key==='custom_fields'?JSON.stringify([...(a as {label:string;value:string}[]??[])].sort((x,y)=>x.label.localeCompare(y.label)))===JSON.stringify([...(b as {label:string;value:string}[]??[])].sort((x,y)=>x.label.localeCompare(y.label))):key==='accomplice_ids'||key==='auditor_ids'?JSON.stringify([...(a as string[]??[])].sort())===JSON.stringify([...(b as string[]??[])].sort()):a===b;
export function planFields(base:Values,local:Values,remote:Values){
 const selected=keys.filter(k=>Object.hasOwn(base,k)&&Object.hasOwn(remote,k));
 const conflict=selected.filter(k=>!same(k,local[k],base[k])&&!same(k,remote[k],base[k])&&!same(k,local[k],remote[k]));
 const outbound=selected.filter(k=>!same(k,local[k],base[k])&&!same(k,local[k],remote[k]));
 const inbound=selected.filter(k=>!same(k,remote[k],base[k])&&same(k,local[k],base[k]));
 return {conflict,outbound,inbound};
}
export async function stage(task:Remote,db:Db=pool){
 await db.query(`INSERT INTO bitrix_task_snapshots(external_id,snapshot) VALUES($1,$2)
 ON CONFLICT(external_id) DO UPDATE SET snapshot=excluded.snapshot,fetched_at=now()`,[task.id,JSON.stringify({...task,extras:safeBitrixData(task.extras)})]);
}
export async function scanProject(request:BitrixRequest,groupId:string,after:string,maxPages:number){
 let cursor=after,total=0;
 for(let page=0;page<maxPages;page++){
  const result=await request<{tasks:Record<string,unknown>[]}>('tasks.task.list',{order:{ID:'asc'},filter:{GROUP_ID:groupId,'>ID':cursor},select:taskFields});
  if(!Array.isArray(result.tasks))throw new BitrixError('Нет списка задач в ответе REST.');
  if(!result.tasks.length)return {total,cursor,complete:true};
  for(const row of result.tasks){
   const task=remoteTask(row);
   if(BigInt(task.id)<=BigInt(cursor))throw new BitrixError('Битрикс24 вернул задачи вне ожидаемого порядка.');
   await stage(task);cursor=task.id;total++;
  }
 }
 return {total,cursor,complete:false};
}
export async function getRemote(request:BitrixRequest,id:string,db:Db=pool){
 const result=await request<{task:Record<string,unknown>}>('tasks.task.get',{taskId:id,select:['*','UF_*','CHAT_ID']});
 const task=remoteTask(result.task??{});
 if(task.id!==id)throw new BitrixError('Битрикс24 вернул другой ID задачи.');
 await stage(task,db);
 await db.query('UPDATE bitrix_task_snapshots SET raw_snapshot=$2::jsonb WHERE external_id=$1',[id,JSON.stringify(safeBitrixData(result.task))]);
 return task;
}
export async function ensureBitrixPeople(request:BitrixRequest,remote:Remote){
 for(const id of new Set([remote.responsibleId,remote.createdBy,...(Array.isArray(remote.extras.accomplices)?remote.extras.accomplices.map(bitrixId):[]),...(Array.isArray(remote.extras.auditors)?remote.extras.auditors.map(bitrixId):[])]))if(id)await ensureBitrixUser(request,id);
}
export async function linkTask(request:BitrixRequest,taskId:string,externalId:string,acceptBitrix=false){
 const remote=await getRemote(request,externalId);
 await ensureBitrixPeople(request,remote);
 return transaction(async db=>{
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  if(!task)throw new BitrixError('Локальная задача не найдена.');
  const values=await remoteValues(remote,db,task);
  const differences=keys.filter(k=>Object.hasOwn(values,k)&&!same(k,task[k],values[k]));
  if(differences.length&&!acceptBitrix)return {linked:false,differences};
  await db.query('INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO NOTHING',[taskId,externalId,JSON.stringify(localValues(task,values)),task.version]);
  const link=(await db.query('SELECT external_id FROM bitrix_task_links WHERE task_id=$1',[taskId])).rows[0];
  return {linked:String(link.external_id)===externalId,differences};
 });
}
export async function syncLinkedTask(request:BitrixRequest,taskId:string,allowWrite:boolean,requireFullFields=false){
 const link=(await pool.query('SELECT * FROM bitrix_task_links WHERE task_id=$1',[taskId])).rows[0];
 if(!link)throw new BitrixError('Задача не связана с Битрикс24.');
 let remote=await getRemote(request,String(link.external_id));
 if(requireFullFields&&(!remote.status||!remote.responsibleId||!remote.createdBy))throw new BitrixError('Нет обязательных полей статуса и сотрудников в ответе Битрикс24.');
 await ensureBitrixPeople(request,remote);
 return transaction(async db=>{
  let task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  if(task.bitrix_deleted_at){
   const previous=task;
   task=(await db.query<Task>('UPDATE tasks SET bitrix_deleted_at=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[taskId])).rows[0];
   await new MockTaskProvider().applyApprovedChange(db,task,previous.version);
   await db.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,'bitrix_task_restored','Доступность задачи в Битрикс24 восстановлена',$3)",[randomUUID(),taskId,JSON.stringify({before:previous,after:task})]);
  }
  const current=(await db.query('SELECT baseline FROM bitrix_task_links WHERE task_id=$1 FOR UPDATE',[taskId])).rows[0];
  let values=await remoteValues(remote,db,task,current.baseline.custom_fields);
  if(keys.some(k=>Object.hasOwn(current.baseline,k)&&!Object.hasOwn(values,k)))throw new BitrixError('Ответ Битрикс24 не содержит ранее связанных полей.');
  // Older pilot baselines contained only three fields. Adopt additional fields on first reconciliation.
  if(task.version>link.linked_version&&keys.some(k=>Object.hasOwn(values,k)&&!Object.hasOwn(current.baseline,k)&&!same(k,task[k],values[k])))throw new BitrixError('Старая привязка не отслеживала изменённое поле. Нужна ручная сверка исходной точки.');
  const baseline={...localValues(task,values),...current.baseline};
  if(allowWrite){
   const mappings=new Set((await db.query('SELECT local_key FROM bitrix_field_map')).rows.map(row=>row.local_key));
   const changes=(await db.query(`SELECT e.data FROM task_events e JOIN task_sync_queue q ON q.task_id=e.task_id
    AND q.task_version=(e.data->'after'->>'version')::int WHERE e.task_id=$1 AND q.state IN ('pending','failed')
    AND q.task_version>$2 AND q.task_version<=$3 AND e.data ? 'before' AND e.data ? 'after'`,[taskId,link.linked_version,task.version])).rows;
   for(const {data} of changes){
    for(const key of ['price','important','customer_risk'] as const)if(!same(key,data.before[key],data.after[key])&&!mappings.has(key))throw new BitrixError('Изменённое поле '+key+' не сопоставлено с Битрикс24. Выполните field-map.');
    if(!same('custom_fields',data.before.custom_fields,data.after.custom_fields)&&!values.custom_fields)throw new BitrixError('Дополнительные поля не подтверждены метаданными и ответом Битрикс24.');
   }
  }
  let plan=planFields(baseline,task,values);
  if(plan.conflict.length||(!allowWrite&&plan.outbound.length)){
   const reason=plan.conflict.length?'Различаются правки полей: '+plan.conflict.join(', '):'Локальные изменения ожидают включения записи.';
   await db.query('UPDATE bitrix_task_links SET conflict=$2,checked_at=now() WHERE task_id=$1',[taskId,reason]);
   return {...plan,syncedVersion:task.version};
  }
  if(plan.outbound.length){
   const fields:Record<string,unknown>={};
   for(const key of plan.outbound){
    if(key==='custom_fields'){for(const field of await customFieldMappings(task.custom_fields,db))fields[field.code]=encodeCustomField(field.local.value,field.metadata);continue;}
    let value:unknown=task[key];
    if(key==='status')value={active:2,review:4,completed:5}[task.status];
    if(key==='assignee_id'||key==='creator_id'){
     const person=(await db.query('SELECT external_id FROM bitrix_user_links WHERE user_id=$1',[task[key]])).rows[0];
     if(!person)throw new BitrixError('Нет привязки локального сотрудника. Выполните map-user.');
     value=String(person.external_id);
    }
    let externalField:string=fieldNames[key];
    if(externalField.startsWith('@')){
     const mapping=(await db.query('SELECT external_code FROM bitrix_field_map WHERE local_key=$1',[key])).rows[0];
     if(!mapping)throw new BitrixError('Нет сопоставления пользовательского поля Битрикс24.');
     externalField=mapping.external_code;
     if(key!=='price')value=value===null?'':value?'1':'0';
    }
    if(key==='accomplice_ids'||key==='auditor_ids'){
     const people=(await db.query('SELECT external_id FROM bitrix_user_links WHERE user_id=ANY($1)',[task[key]??[]])).rows;
     if(people.length!==(task[key]??[]).length)throw new BitrixError('Не все участники сопоставлены.');
     value=people.map(row=>String(row.external_id));
    }
    if(key==='priority')value=value==='high'?2:1;
    fields[externalField]=value===null?'':value;
   }
   if('START_DATE_PLAN' in fields||'END_DATE_PLAN' in fields){
    fields.START_DATE_PLAN=(plan.outbound.includes('planned_start')?task.planned_start:values.planned_start)??'';
    fields.END_DATE_PLAN=(plan.outbound.includes('planned_end')?task.planned_end:values.planned_end)??'';
   }
   const latest=await getRemote(request,remote.id,db);
   const latestValues=await remoteValues(latest,db,task,current.baseline.custom_fields);
   if(keys.some(k=>Object.hasOwn(values,k)&&!same(k,latestValues[k],values[k])))throw new BitrixError('Задача Битрикс24 изменилась перед записью. Повторная сверка отложена.');
   await bitrixControl.query(`UPDATE task_sync_queue SET attempts=attempts+1 WHERE task_id=$1
    AND task_version>$2 AND task_version<=$3 AND state IN ('pending','failed')
    AND payload->>'kind' IN ('task_edited','deadline_changed','action_undone','review_submitted','review_returned','task_completed')`,[taskId,link.linked_version,task.version]);
   await request('tasks.task.update',{taskId:remote.id,fields});
   remote=await getRemote(request,remote.id,db);
   values=await remoteValues(remote,db,task,current.baseline.custom_fields);
   if(plan.outbound.some(k=>!same(k,task[k],values[k])))throw new BitrixError('Запись в Битрикс24 не подтвердилась контрольным чтением.');
   plan={...plan,inbound:planFields(baseline,task,values).inbound};
  }
  if(plan.inbound.length){
   const next={...task,...Object.fromEntries(plan.inbound.map(k=>[k,values[k]]))};
   const updated=(await db.query<Task>(`UPDATE tasks SET title=$2,description=$3,deadline=$4,code=$5,
     status=$6,assignee_id=$7,creator_id=$8,price=$10,important=$11,customer_risk=$12,planned_start=$13,planned_end=$14,priority=$15,accomplice_ids=$16,auditor_ids=$17,custom_fields=$18,
     completed_at=CASE WHEN $6='completed' THEN coalesce($9::timestamptz,completed_at) ELSE NULL END,
     branch_id=(SELECT branch_id FROM users WHERE id=$7),
     version=version+1,updated_at=now(),transfer_count=transfer_count+CASE WHEN deadline IS DISTINCT FROM $4::timestamptz THEN 1 ELSE 0 END
     WHERE id=$1 RETURNING *`,[taskId,next.title,next.description,next.deadline,next.title.split(/\s/)[0],next.status,next.assignee_id,next.creator_id,remote.closedDate,next.price??null,next.important,next.customer_risk,next.planned_start??null,next.planned_end,next.priority,next.accomplice_ids??[],next.auditor_ids??[],JSON.stringify(next.custom_fields??[])])).rows[0];
   await new MockTaskProvider().applyApprovedChange(db,updated,task.version);
   await db.query("UPDATE approvals SET state='stale' WHERE task_id=$1 AND state='pending'",[taskId]);
   await db.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,'bitrix_change','Поля обновлены из Битрикс24',$3)",[randomUUID(),taskId,JSON.stringify({before:task,after:updated})]);
  }
  await db.query(`UPDATE task_sync_queue SET state='sent',retry_at=NULL WHERE task_id=$1 AND task_version>$2 AND task_version<=$3
   AND state IN ('pending','failed') AND payload->>'kind' IN ('task_edited','deadline_changed','action_undone','review_submitted','review_returned','task_completed')
   AND attempts>0`,[taskId,link.linked_version,task.version]);
  await db.query('UPDATE bitrix_task_links SET baseline=$2,conflict=NULL,checked_at=now() WHERE task_id=$1',[taskId,JSON.stringify(values)]);
  return {...plan,syncedVersion:task.version};
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
