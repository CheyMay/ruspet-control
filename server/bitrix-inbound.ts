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
import {unassignedBranch} from '../shared/branches.js';
import type {Task,User} from '../shared/types.js';

const statuses:Record<string,Task['status']>={'2':'active','3':'active','4':'review','5':'completed'};
const properties=['title','description','deadline','status','assignee_id','creator_id','planned_start','planned_end','completed_at','price'] as const;
type Property=typeof properties[number];
type Values=Pick<Task,Property>;
type Person={ID:string;NAME?:string;LAST_NAME?:string;SECOND_NAME?:string};
type QueueRow={resource:string;external_id:string;generation:string;delete_hint:boolean};
const taskResource='task_inbound',newTaskResource='task_inbound_new',commentsResource='task_inbound_comments';
const readFields=['ID','TITLE','DESCRIPTION','STATUS','RESPONSIBLE_ID','CREATED_BY','DEADLINE','START_DATE_PLAN',
 'END_DATE_PLAN','CLOSED_DATE','CHAT_ID','CREATED_DATE','CHANGED_DATE'];
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
async function applyTask(request:BitrixRequest,raw:Record<string,unknown>,adopt=false){
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
  assert(task?(link?String(link.external_id)===remote.id&&!link.live_enabled:String(task.source_fields?.ID)===id):adopt&&!link,
   409,'Связь задачи с исходной выгрузкой не подтверждена.');
  const sourceDate=readDate(raw,'CREATED_DATE');
  assert(task?(link||sourceDate===task.created_at):sourceDate,409,'Дата создания задачи отсутствует или расходится с выгрузкой.');
  for(const [external,local] of people){
   await db.query('INSERT INTO bitrix_user_links(user_id,external_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[local,external]);
   const match=(await db.query('SELECT 1 FROM bitrix_user_links WHERE user_id=$1 AND external_id=$2',[local,external])).rowCount;
   assert(match,409,'ID сотрудника уже сопоставлен с другим профилем.');
  }
  if(!task){
   const owner=(await db.query<User>('SELECT * FROM users WHERE id=$1',[people.get(remote.responsibleId!)])).rows[0];
   const differentBranch=await db.query(`SELECT 1 FROM tasks WHERE assignee_id=$1 AND branch_id<>$2
    AND source_fields->>'ID'=id LIMIT 1`,[owner.id,owner.branch_id]);
   const branch=differentBranch.rowCount?unassignedBranch:owner.branch_id;
   const created=(await db.query<Task>(`INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,deadline,
    original_deadline,planned_start,planned_end,status,priority,code,created_at,updated_at,completed_at,price,source_fields,source_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,'normal',$11,$12,coalesce($13::timestamptz,$12),$14,$15,jsonb_build_object('ID',$1::text),$16)
    RETURNING *`,[id,remote.title,remote.description,branch,owner.id,people.get(remote.createdBy!),remote.deadline,
     readDate(raw,'START_DATE_PLAN'),readDate(raw,'END_DATE_PLAN'),state,remote.title.trim().split(/\s/)[0],sourceDate,readDate(raw,'CHANGED_DATE'),
     state==='completed'?readDate(raw,'CLOSED_DATE'):null,price,remote.status])).rows[0];
   await db.query('INSERT INTO mock_provider_tasks(id,snapshot,revision) VALUES($1,$2,$3)',[id,JSON.stringify(created),created.version]);
   const baseline=localValues(created);
   await stage(remote,db,raw);
   await db.query('INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version,checked_at) VALUES($1,$2,$3,$4,now())',
    [id,remote.id,JSON.stringify({...baseline,inbound:baseline}),created.version]);
   await event(db,id,null,'imported','Новая задача получена из Битрикс24',{source:'bitrix24',initialSnapshot:created});
   await refreshTaskFindings(db,created,owner);
   return {changed:true,conflict:false,created:true};
  }
  const baselineEvent=link?null:(await db.query(`SELECT CASE kind WHEN 'source_refreshed' THEN data->'after' ELSE data->'initialSnapshot' END AS snapshot
   FROM task_events WHERE task_id=$1 AND kind IN ('source_refreshed','imported') ORDER BY created_at DESC,id DESC LIMIT 1`,[id])).rows[0]?.snapshot as Task|undefined;
  assert(link?.baseline?.inbound||baselineEvent,409,'Нет исходного снимка задачи для безопасной сверки.');
  const local=localValues(task);
  const base:Values=link?.baseline?.inbound??localValues(baselineEvent!);
  const authoritative=process.env.BITRIX_INBOUND_AUTHORITATIVE==='true';
  const next:Values={title:remote.title,description:remote.description,deadline:remote.deadline,status:state,
   assignee_id:people.get(remote.responsibleId!)!,creator_id:people.get(remote.createdBy!)!,
   planned_start:fieldValue(raw,'START_DATE_PLAN')===undefined?local.planned_start:readDate(raw,'START_DATE_PLAN'),
   planned_end:fieldValue(raw,'END_DATE_PLAN')===undefined?local.planned_end:readDate(raw,'END_DATE_PLAN'),
   completed_at:state==='completed'?readDate(raw,'CLOSED_DATE'):null,price:field?price:local.price};
  const workflowFields:Property[]=['status','assignee_id','creator_id','completed_at'];
  const permissionConflict=!authoritative&&workflowFields.some(key=>!equal(local[key],base[key])&&!equal(local[key],next[key]));
  const changed=properties.filter(key=>!equal(next[key],local[key])&&
   (authoritative||equal(local[key],base[key])&&!(permissionConflict&&workflowFields.includes(key))));
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
    task.branch_id,changed.includes('status')?remote.status:task.source_status,
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

export async function enqueueInboundSnapshot(portal:string,id?:string,comments=false){
 if(id)assert(bitrixId(id),400,'Нужен числовой ID задачи.');
 const result=await pool.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id)
  SELECT $1,$2,coalesce(l.external_id::text,t.id) FROM tasks t LEFT JOIN bitrix_task_links l ON l.task_id=t.id
  WHERE t.source_fields->>'ID'=t.id AND t.id ~ '^[1-9][0-9]{0,17}$' AND ($3::text IS NULL OR t.id=$3)
  AND NOT coalesce(l.live_enabled,false) AND (NOT $4 OR l.external_id IS NOT NULL AND ($3::text IS NOT NULL OR t.status<>'completed'))
  ON CONFLICT(portal,resource,external_id) DO UPDATE SET generation=bitrix_refresh_queue.generation+1,
  state='pending',retry_at=NULL,error=NULL,updated_at=now()`,[portal,comments?commentsResource:taskResource,id??null,comments]);
 return result.rowCount;
}

export async function reconcileInboundTasks(request:BitrixRequest){
 const portal=request.portal;
 assert(request.mode==='webhook'&&portal,409,'Нужен входящий вебхук Битрикс24.');
 const tracked=(await pool.query<{id:string;raw:Record<string,unknown>|null}>(`SELECT coalesce(l.external_id::text,t.id) id,s.raw FROM tasks t
  LEFT JOIN bitrix_task_links l ON l.task_id=t.id
  LEFT JOIN bitrix_task_snapshots s ON s.external_id=l.external_id
  WHERE t.id ~ '^[1-9][0-9]{0,17}$' AND t.source_fields->>'ID'=t.id AND NOT coalesce(l.live_enabled,false)
  ORDER BY t.id`)).rows;
 let queued=0;
 for(let offset=0;offset<tracked.length;offset+=40){
  const batch=tracked.slice(offset,offset+40),ids=batch.map(task=>task.id);
  const result=await request<{tasks:Record<string,unknown>[]}>('tasks.task.list',{
   filter:{ID:ids},select:['ID','CHANGED_DATE'],order:{ID:'asc'}
  });
  assert(Array.isArray(result.tasks),502,'Битрикс24 не вернул список задач для сверки.');
  const seen=new Map<string,string|null>();
  for(const remote of result.tasks){
   const id=bitrixId(fieldValue(remote,'ID'));
   assert(id&&ids.includes(id)&&!seen.has(id),502,'Битрикс24 вернул неожиданный ID при сверке.');
   seen.set(id,readDate(remote,'CHANGED_DATE'));
  }
  const changed=batch.filter(task=>!task.raw||!seen.get(task.id)||seen.get(task.id)!==readDate(task.raw,'CHANGED_DATE')).map(task=>task.id);
  if(!changed.length)continue;
  queued+=(await pool.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id)
   SELECT $1,$2,id FROM unnest($3::text[]) AS x(id)
   ON CONFLICT(portal,resource,external_id) DO UPDATE SET generation=bitrix_refresh_queue.generation+1,
    state='pending',error=NULL,retry_at=NULL,updated_at=now()
   WHERE bitrix_refresh_queue.state IN ('done','blocked')`,[portal,taskResource,changed])).rowCount??0;
 }
 return {tracked:tracked.length,queued};
}

export async function discoverInboundTasks(request:BitrixRequest,since:string){
 const portal=request.portal;
 assert(request.mode==='webhook'&&portal&&Number.isFinite(Date.parse(since)),400,'Укажите дату начала сверки и входящий вебхук.');
 const people=(await pool.query<{id:string}>(`SELECT external_id::text id FROM bitrix_user_links
  UNION SELECT bitrix_id id FROM staff_directory WHERE enabled AND user_id IS NOT NULL AND bitrix_id ~ '^[1-9][0-9]{0,17}$'
  ORDER BY id`)).rows.map(person=>person.id);
 let queued=0;
 for(let offset=0;offset<people.length;offset+=40){
  const owners=people.slice(offset,offset+40);
  let cursor='0',complete=false;
  for(let page=0;page<20;page++){
   const result=await request<{tasks:Record<string,unknown>[]}>('tasks.task.list',{
    filter:{RESPONSIBLE_ID:owners,'>=CREATED_DATE':since,'>ID':cursor},select:['ID','RESPONSIBLE_ID','CREATED_DATE'],order:{ID:'asc'},start:0
   });
   assert(Array.isArray(result.tasks)&&result.tasks.length<=50,502,'Битрикс24 не вернул страницу новых задач.');
   const ids=result.tasks.map(task=>{
    const id=bitrixId(fieldValue(task,'ID')),owner=bitrixId(fieldValue(task,'RESPONSIBLE_ID')),created=readDate(task,'CREATED_DATE');
    assert(id&&BigInt(id)>BigInt(cursor)&&owner&&owners.includes(owner)&&created&&Date.parse(created)>=Date.parse(since),502,
     'Битрикс24 вернул задачу вне заданного периода или состава сотрудников.');
    cursor=id;
    return id;
   });
   if(ids.length)queued+=(await pool.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id)
    SELECT $1,$2,x.id FROM unnest($3::text[]) x(id)
    WHERE NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=x.id) AND
     NOT EXISTS(SELECT 1 FROM bitrix_task_links l WHERE l.external_id=x.id::bigint)
    ON CONFLICT DO NOTHING`,[portal,newTaskResource,ids])).rowCount??0;
   if(ids.length<50){complete=true;break;}
  }
  assert(complete,409,'Достигнут предел страниц для поиска новых задач. Сузьте период.');
 }
 return {owners:people.length,queued};
}

async function refreshTask(request:BitrixRequest,item:QueueRow){
 const id=item.external_id;
 try{
  const result=await request<{task:Record<string,unknown>}>('tasks.task.get',{taskId:id,select:selection()});
  assert(bitrixId(result.task?.id)===id,409,'Битрикс24 вернул другой ID задачи.');
  return await applyTask(request,result.task,item.resource===newTaskResource);
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
   ORDER BY (resource=$4),updated_at,external_id LIMIT 1`,[portal,[taskResource,newTaskResource,commentsResource],id??null,commentsResource])).rows[0];
  if(!item)return null;
  const args=[portal,item.resource,item.external_id,item.generation];
  try{
   const result=item.resource===commentsResource?await refreshComments(request,item.external_id):await refreshTask(request,item);
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
