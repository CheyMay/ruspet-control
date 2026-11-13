import {isDeepStrictEqual as equal} from 'node:util';
import {pool,transaction,type Db} from './db.js';
import {assert,AppError} from './domain.js';
import {lockDelegationChain,requireAcceptedDelegations} from './delegation-lock.js';
import {MockTaskProvider} from './providers.js';
import {event,refreshTaskFindings} from './service.js';
import {fieldValue} from './bitrix-fields.js';
import {bitrixId,remoteTask,stage,syncActivity} from './bitrix-sync.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {namesMatch} from './staff-import.js';
import {parsePrice,taskPrice} from '../shared/pricing.js';
import type {Task,User} from '../shared/types.js';

const statuses:Record<string,Task['status']>={'2':'active','3':'active','4':'review','5':'completed'};
const properties=['title','description','deadline','status','assignee_id','creator_id','planned_start','planned_end','completed_at','price'] as const;
type Property=typeof properties[number];
type Values=Pick<Task,Property>;
type Person={ID:string;NAME?:string;LAST_NAME?:string;SECOND_NAME?:string};
type QueueRow={resource:string;external_id:string;generation:string;delete_hint:boolean};
const taskResource='task_inbound',commentsResource='task_inbound_comments';
const readFields=['ID','TITLE','DESCRIPTION','STATUS','RESPONSIBLE_ID','CREATED_BY','DEADLINE','START_DATE_PLAN',
 'END_DATE_PLAN','CLOSED_DATE','CHAT_ID','CREATED_DATE'];
const selection=()=>[...readFields,...(process.env.BITRIX_INBOUND_PRICE_FIELD?[process.env.BITRIX_INBOUND_PRICE_FIELD]:[])];

function localValues(task:Task):Values{
 const {title,description,deadline,status,assignee_id,creator_id,planned_start,planned_end,completed_at}=task;
 return {title,description,deadline,status,assignee_id,creator_id,planned_start:planned_start??null,planned_end,completed_at,price:taskPrice(task)};
}
function readDate(raw:Record<string,unknown>,key:string){
 const value=fieldValue(raw,key);
 if(value==null||value==='')return null;
 assert(typeof value==='string'&&Number.isFinite(Date.parse(value)),409,'Битрикс24 вернул некорректную дату.');
 return new Date(value).toISOString();
}
async function peopleFor(request:BitrixRequest,raw:Record<string,unknown>,db:Db=pool){
 const task=remoteTask(raw),ids=[...new Set([task.responsibleId,task.createdBy])];
 assert(ids.every(id=>id!==null),409,'В Битрикс24 не указан исполнитель или постановщик.');
 const linked=(await db.query('SELECT external_id::text,user_id FROM bitrix_user_links WHERE external_id=ANY($1::bigint[])',[ids])).rows;
 const known=new Map<string,string>(linked.map(row=>[row.external_id,row.user_id]));
 const missing=ids.filter(id=>!known.has(id!));
 if(!missing.length)return known;
 const candidates=(await db.query(`SELECT DISTINCT s.bitrix_id::text,s.user_id,u.name FROM staff_directory s
  JOIN users u ON u.id=s.user_id WHERE s.enabled AND NOT u.root_access AND s.bitrix_id=ANY($1::text[])
  AND NOT EXISTS(SELECT 1 FROM bitrix_user_links b WHERE b.user_id=s.user_id)`,[missing])).rows;
 for(const id of missing)assert(candidates.filter(row=>row.bitrix_id===id).length===1,409,`Сопоставьте сотрудника Битрикс24 #${id} со справочником РУСПЭТ.`);
 const people=await request<Person[]>('user.get',{FILTER:{ID:missing},select:['ID','NAME','LAST_NAME','SECOND_NAME']});
 assert(Array.isArray(people),409,'Битрикс24 не вернул профили участников задачи.');
 for(const id of missing){
  const matches=people.filter(person=>bitrixId(person.ID)===id);
  const local=candidates.find(row=>row.bitrix_id===id);
  assert(matches.length===1&&namesMatch(local.name,[matches[0].LAST_NAME,matches[0].NAME,matches[0].SECOND_NAME].filter(Boolean).join(' ')),
   409,'Профиль Битрикс24 не совпал с сотрудником в справочнике.');
  known.set(id!,local.user_id);
 }
 assert(new Set(known.values()).size===known.size,409,'В справочнике один сотрудник связан с несколькими ID Битрикс24.');
 return known;
}
async function applyTask(request:BitrixRequest,raw:Record<string,unknown>){
 const remote=remoteTask(raw);
 const state=statuses[remote.status??''];
 assert(state,409,'Статус задачи Битрикс24 требует отдельного сопоставления.');
 const people=await peopleFor(request,raw);
 const field=process.env.BITRIX_INBOUND_PRICE_FIELD;
 const amount=field?fieldValue(raw,field):undefined;
 assert(!field||amount!==undefined,409,'Поле цены не вернулось из Битрикс24.');
 const number=typeof amount==='string'&&amount.endsWith('|RUB')?amount.slice(0,-4):amount;
 const price=parsePrice(number);
 assert(amount==null||amount===''||price!==null,409,'Поле цены в Битрикс24 требует проверки.');
 return transaction(async db=>{
  const linked=(await db.query('SELECT task_id FROM bitrix_task_links WHERE external_id=$1',[remote.id])).rows[0];
  const id=linked?.task_id??remote.id;
  await lockDelegationChain(db,id);
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const link=(await db.query('SELECT * FROM bitrix_task_links WHERE task_id=$1 FOR UPDATE',[id])).rows[0];
  assert(task&&(link?String(link.external_id)===remote.id&&!link.live_enabled:String(task.source_fields?.ID)===id),409,'Связь задачи с исходной выгрузкой не подтверждена.');
  const sourceDate=readDate(raw,'CREATED_DATE');
  assert(link||sourceDate===task.created_at,409,'Дата создания задачи расходится с выгрузкой. Проверьте ID и портал.');
  for(const [external,local] of people){
   await db.query('INSERT INTO bitrix_user_links(user_id,external_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[local,external]);
   const match=(await db.query('SELECT 1 FROM bitrix_user_links WHERE user_id=$1 AND external_id=$2',[local,external])).rowCount;
   assert(match,409,'ID сотрудника уже сопоставлен с другим профилем.');
  }
  const baselineEvent=link?null:(await db.query(`SELECT CASE kind WHEN 'source_refreshed' THEN data->'after' ELSE data->'initialSnapshot' END AS snapshot
   FROM task_events WHERE task_id=$1 AND kind IN ('source_refreshed','imported') ORDER BY created_at DESC,id DESC LIMIT 1`,[id])).rows[0]?.snapshot as Task|undefined;
  assert(link?.baseline?.inbound||baselineEvent,409,'Нет исходного снимка задачи для безопасной сверки.');
  const local=localValues(task);
  const base:Values=link?.baseline?.inbound??localValues(baselineEvent!);
  const next:Values={title:remote.title,description:remote.description,deadline:remote.deadline,status:state,
   assignee_id:people.get(remote.responsibleId!)!,creator_id:people.get(remote.createdBy!)!,
   planned_start:fieldValue(raw,'START_DATE_PLAN')===undefined?base.planned_start:readDate(raw,'START_DATE_PLAN'),
   planned_end:fieldValue(raw,'END_DATE_PLAN')===undefined?base.planned_end:readDate(raw,'END_DATE_PLAN'),
   completed_at:state==='completed'?readDate(raw,'CLOSED_DATE'):null,price:field?price:base.price};
  const workflowFields:Property[]=['status','assignee_id','creator_id','completed_at'];
  const permissionConflict=workflowFields.some(key=>!equal(local[key],base[key])&&!equal(local[key],next[key]));
  const changed=properties.filter(key=>!equal(next[key],local[key])&&equal(local[key],base[key])&&!(permissionConflict&&workflowFields.includes(key)));
  const conflicts=properties.filter(key=>!equal(next[key],local[key])&&!equal(next[key],base[key])&&!changed.includes(key));
  const merged={...local,...Object.fromEntries(changed.map(key=>[key,next[key]]))};
  const owner=(await db.query<User>('SELECT * FROM users WHERE id=$1',[merged.assignee_id])).rows[0];
  if(changed.length){
   if(changed.includes('status')&&merged.status!=='active')await requireAcceptedDelegations(db,id);
   const updated=(await db.query<Task>(`UPDATE tasks SET title=$2,description=$3,deadline=$4,status=$5,assignee_id=$6,
    creator_id=$7,planned_start=$8,planned_end=$9,completed_at=$10,price=$11,code=$12,branch_id=$13,
    source_status=$14,version=version+1,updated_at=now(),
    source_fields=CASE WHEN $15 THEN source_fields-'Цена задачи' ELSE source_fields END,
    transfer_count=transfer_count+CASE WHEN $16 AND deadline IS DISTINCT FROM $4::timestamptz THEN 1 ELSE 0 END
    WHERE id=$1 RETURNING *`,[id,merged.title,merged.description,merged.deadline,merged.status,merged.assignee_id,merged.creator_id,
    merged.planned_start,merged.planned_end,merged.completed_at,merged.price,merged.title.trim().split(/\s/)[0],
    task.assignee_id===merged.assignee_id?task.branch_id:owner.branch_id,changed.includes('status')?remote.status:task.source_status,
    changed.includes('price')&&merged.price===null,!!link])).rows[0];
   await new MockTaskProvider().applyApprovedChange(db,updated,task.version);
   await db.query("UPDATE approvals SET state='stale',deferred_until=NULL WHERE task_id=$1 AND state='pending'",[id]);
   if(changed.includes('status')&&updated.status!=='review')await db.query(`UPDATE task_submissions SET state=$2,
    remark='Статус получен из Битрикс24',decided_at=now() WHERE task_id=$1 AND state='review' AND withdrawn_at IS NULL`,
    [id,updated.status==='completed'?'accepted':'returned']);
   if(updated.status==='completed'||changed.includes('assignee_id'))await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[id]);
   await event(db,id,null,'bitrix_change','Обновлено из Битрикс24',{before:task,after:updated,fields:changed});
   await refreshTaskFindings(db,updated,owner);
  }
  const carriedBase={...base,...Object.fromEntries(properties.filter(key=>equal(local[key],next[key])||changed.includes(key)).map(key=>[key,next[key]]))};
  await stage(remote,db,raw);
  const reason=conflicts.length?'Есть локальные изменения и расхождение с Битрикс24: '+conflicts.join(', '):null;
  await db.query(`INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version,checked_at,conflict)
   VALUES($1,$2,$3,$4,now(),$5) ON CONFLICT(task_id) DO UPDATE SET baseline=excluded.baseline,checked_at=now(),conflict=excluded.conflict`,
   [id,remote.id,JSON.stringify({...carriedBase,inbound:carriedBase}),task.version,reason]);
  return {changed:changed.length>0,conflict:!!reason};
 });
}

export async function enqueueInboundSnapshot(portal:string,id?:string){
 if(id)assert(bitrixId(id),400,'Нужен числовой ID задачи.');
 const result=await pool.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id)
  SELECT $1,$2,id FROM tasks WHERE source_fields->>'ID'=id AND id ~ '^[1-9][0-9]{0,17}$' AND ($3::text IS NULL OR id=$3)
  ON CONFLICT(portal,resource,external_id) DO UPDATE SET generation=bitrix_refresh_queue.generation+1,
  state='pending',retry_at=NULL,error=NULL,updated_at=now()`,[portal,taskResource,id??null]);
 return result.rowCount;
}

async function refreshTask(request:BitrixRequest,item:QueueRow){
 const id=item.external_id;
 try{
  const result=await request<{task:Record<string,unknown>}>('tasks.task.get',{taskId:id,select:selection()});
  assert(bitrixId(result.task?.id)===id,409,'Битрикс24 вернул другой ID задачи.');
  return await applyTask(request,result.task);
 }catch(error){
  if(!item.delete_hint||!(error instanceof BitrixError)||error.code!=='ERROR_TASK_NOT_FOUND')throw error;
  await pool.query(`UPDATE bitrix_task_links SET conflict='Битрикс24 сообщил об удалении. Локальная задача сохранена.',checked_at=now()
   WHERE external_id=$1 AND NOT live_enabled`,[id]);
  return {changed:false,conflict:false,deleted:true};
 }
}
async function refreshComments(request:BitrixRequest,id:string){
 const result=(await pool.query(`SELECT l.task_id,s.snapshot FROM bitrix_task_links l JOIN bitrix_task_snapshots s USING(external_id)
  WHERE l.external_id=$1 AND NOT l.live_enabled`,[id])).rows[0];
 assert(result,409,'Сначала нужно подтвердить связь задачи с Битрикс24.');
 return syncActivity(request,result.task_id,undefined,{task:result.snapshot,commentsOnly:true});
}
export async function tickInboundTasks(request:BitrixRequest,id?:string){
 const portal=request.portal;
 assert(request.mode==='webhook'&&portal,409,'Нужен входящий вебхук Битрикс24.');
 const lock=await pool.connect();
 let acquired=false;
 try{
  acquired=(await lock.query('SELECT pg_try_advisory_lock(431043) ok')).rows[0].ok;
  if(!acquired)return null;
  const item=(await pool.query<QueueRow>(`SELECT resource,external_id,generation,delete_hint FROM bitrix_refresh_queue
   WHERE portal=$1 AND resource=ANY($2) AND state IN ('pending','failed') AND generation>done_generation
   AND (retry_at IS NULL OR retry_at<=now()) AND ($3::text IS NULL OR external_id=$3)
   ORDER BY CASE WHEN resource=$4 THEN 0 ELSE 1 END,updated_at,external_id LIMIT 1`,[portal,[taskResource,commentsResource],id??null,taskResource])).rows[0];
  if(!item)return null;
  const args=[portal,item.resource,item.external_id,item.generation];
  try{
   const result=item.resource===taskResource?await refreshTask(request,item):await refreshComments(request,item.external_id);
   await pool.query(`UPDATE bitrix_refresh_queue SET done_generation=$4,state=CASE WHEN generation=$4 THEN 'done' ELSE 'pending' END,
    error=NULL,retry_at=NULL WHERE portal=$1 AND resource=$2 AND external_id=$3`,args);
   return {resource:item.resource,id:item.external_id,result};
  }catch(error){
   const transient=!(error instanceof AppError)&&(!(error instanceof BitrixError)||
    error.disposition==='uncertain'||['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT','OVERLOAD_LIMIT'].includes(error.code??''));
   const message=error instanceof BitrixError||error instanceof AppError?error.message:'Ошибка локальной сверки задачи.';
   await pool.query(`UPDATE bitrix_refresh_queue SET state=$5,error=$6,retry_at=now()+interval '2 minutes'
    WHERE portal=$1 AND resource=$2 AND external_id=$3 AND generation=$4`,[...args,transient?'failed':'blocked',message]);
   return {resource:item.resource,id:item.external_id,error:message,transient};
  }
 }finally{
  if(acquired)await lock.query('SELECT pg_advisory_unlock(431043)');
  lock.release();
 }
}
