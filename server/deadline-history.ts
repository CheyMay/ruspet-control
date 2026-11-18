import {pool,transaction,type Db} from './db.js';
import {assert} from './domain.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {bitrixId,syncActivity} from './bitrix-sync.js';
import {matchTransferComments} from '../shared/transfer-comments.js';
import type {DeadlineTransfer,DeadlineTransferComment} from '../shared/types.js';

export const deadlineHistoryResource='task_inbound_deadlines';
export const deadlineCommentsResource='task_inbound_deadline_comments';
type RemoteEntry={id?:unknown;createdDate?:unknown;field?:string;value?:{from?:unknown;to?:unknown};user?:{name?:string;lastName?:string}};
function timestamp(value:unknown):string|null{
 if(value==null||value==='')return null;
 if(typeof value!=='string'&&typeof value!=='number')throw new Error('Invalid timestamp');
 const text=String(value),local=text.match(/^(\d\d)\.(\d\d)\.(\d{4})(?:[ T](\d\d:\d\d(?::\d\d)?))?$/);
 const parsed=/^\d{10}$/.test(text)?Number(text)*1000:/^\d{13}$/.test(text)?Number(text):
  Date.parse(local?`${local[3]}-${local[2]}-${local[1]}T${local[4]??'00:00'}+03:00`:text);
 if(!Number.isFinite(parsed))throw new Error('Invalid timestamp');
 return new Date(parsed).toISOString();
}
function fromBitrix(raw:RemoteEntry):DeadlineTransfer[] {
 if(raw.field!=='DEADLINE')return [];
 try{
  const id=bitrixId(raw.id),at=timestamp(raw.createdDate),from=timestamp(raw.value?.from),to=timestamp(raw.value?.to);
  if(!id||!at||from===to)return [];
  return [{id:'bitrix:'+id,occurredAt:at,from,to,author:[raw.user?.name,raw.user?.lastName].filter(Boolean).join(' ')||'Битрикс24',
   source:'bitrix',reason:null}];
 }catch{return [];}
}

export async function loadDeadlineHistories(db:Db,taskIds:string[]){
 const result:Record<string,DeadlineTransfer[]>={};
 if(!taskIds.length)return result;
 const local=await db.query<DeadlineTransfer&{task_id:string}>(`SELECT e.task_id,e.id::text,e.created_at AS "occurredAt",
  e.data->'before'->>'deadline' AS "from",e.data->'after'->>'deadline' AS "to",
  coalesce(u.name,CASE WHEN e.kind='bitrix_change' THEN 'Битрикс24' ELSE 'Система' END) AS author,
  CASE WHEN e.kind='bitrix_change' THEN 'bitrix' ELSE 'ruspet' END AS source,
  coalesce(nullif(e.data->>'reason',''),nullif(a.reason,'')) AS reason
  FROM task_events e LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN approvals a ON a.id::text=e.data->>'approvalId' AND a.task_id=e.task_id
  WHERE e.task_id=ANY($1) AND e.kind IN ('deadline_changed','bitrix_change','action_undone','source_refreshed')
  AND e.data ? 'before' AND e.data ? 'after'
  AND e.data->'before'->>'deadline' IS DISTINCT FROM e.data->'after'->>'deadline'
  AND NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id)`,[taskIds]);
 for(const {task_id,...item} of local.rows)(result[task_id]??=[]).push(item);
 const remote=await db.query<DeadlineTransfer&{task_id:string}>(`SELECT task_id,'bitrix:'||external_id AS id,occurred_at AS "occurredAt",
  from_deadline AS "from",to_deadline AS "to",author,'bitrix' AS source,NULL AS reason
  FROM bitrix_deadline_history WHERE task_id=ANY($1)`,[taskIds]);
 const archive=await db.query<{task_id:string;raw:RemoteEntry}>(`SELECT l.task_id,o.raw FROM bitrix_task_links l JOIN bitrix_rest_gate g ON g.id=1
  JOIN bitrix_archive_objects o ON o.portal=g.portal AND o.resource='task_history' AND o.parent_id=l.external_id::text
  WHERE l.task_id=ANY($1) AND o.raw->>'field'='DEADLINE' AND o.deleted_at IS NULL`,[taskIds]);
 const stored=remote.rows.concat(archive.rows.flatMap(({task_id,raw})=>fromBitrix(raw).map(row=>({task_id,...row}))));
 for(const {task_id,...item} of stored){
  const history=result[task_id]??=[];
  const duplicate=history.findIndex(old=>old.id===item.id||!old.id.startsWith('bitrix:')&&old.from===item.from&&old.to===item.to&&
   Math.abs(Date.parse(old.occurredAt)-Date.parse(item.occurredAt))<600000);
  if(duplicate<0)history.push(item);
  else if(history[duplicate].source==='bitrix'&&!history[duplicate].id.startsWith('bitrix:'))history[duplicate]=item;
 }
 const withHistory=Object.keys(result);
 if(!withHistory.length)return result;
 const {rows:comments}=await db.query<DeadlineTransferComment&{task_id:string}>(`SELECT task_id,'bitrix:'||external_id AS id,
  occurred_at AS "occurredAt",author,body AS text FROM bitrix_task_activity
  WHERE task_id=ANY($1) AND kind='comment' AND (author<>'Битрикс24' OR body ILIKE '%причина переноса:%')
  UNION ALL SELECT c.task_id,'ruspet:'||c.id::text,c.created_at,u.name,c.body
  FROM comments c JOIN users u ON u.id=c.author_id
  WHERE c.task_id=ANY($1) AND c.withdrawn_at IS NULL AND c.approval_id IS NULL AND c.kind IN ('comment','explanation')`,[withHistory]);
 const byTask=new Map<string,DeadlineTransferComment[]>();
 for(const {task_id,...comment} of comments){
  const taskComments=byTask.get(task_id)??[];
  taskComments.push(comment);byTask.set(task_id,taskComments);
 }
 for(const [taskId,list] of Object.entries(result)){
  list.sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt)||a.id.localeCompare(b.id));
  result[taskId]=matchTransferComments(list,byTask.get(taskId)??[]);
 }
 return result;
}

export async function queueDeadlineHistories(db:Db,ids:string[]){
 if(!ids.length||process.env.BITRIX_INBOUND_TASKS==='false')return;
 await db.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id)
  SELECT c.portal,$2,l.external_id::text FROM bitrix_task_links l JOIN bitrix_event_capture c
   ON c.id=1 AND c.enabled AND c.mode='online' AND c.verified_at IS NOT NULL AND c.portal IS NOT NULL
  WHERE l.task_id=ANY($1) AND NOT l.live_enabled
  ON CONFLICT(portal,resource,external_id) DO UPDATE SET generation=bitrix_refresh_queue.generation+1,
   state='pending',retry_at=NULL,error=NULL,updated_at=now()
  WHERE bitrix_refresh_queue.state='done' AND bitrix_refresh_queue.updated_at<now()-interval '30 minutes'`,[ids,deadlineHistoryResource]);
 await queuePastComments(db,ids);
}

export async function refreshDeadlineHistory(request:BitrixRequest,externalId:string){
 const link=(await pool.query<{task_id:string}>('SELECT task_id FROM bitrix_task_links WHERE external_id=$1 AND NOT live_enabled',[externalId])).rows[0];
 if(!link)return {ignored:'Связь с задачей снята.'};
 const result=await request<{list:RemoteEntry[]}>('tasks.task.history.list',{taskId:externalId,filter:{FIELD:'DEADLINE'}});
 if(!Array.isArray(result?.list))throw new BitrixError('Битрикс24 не вернул историю сроков.');
 const rows=result.list.flatMap(fromBitrix).map(row=>({external_id:row.id.slice(7),occurred_at:row.occurredAt,
  from_deadline:row.from,to_deadline:row.to,author:row.author}));
 await transaction(async db=>{
  const current=await db.query('SELECT 1 FROM bitrix_task_links WHERE task_id=$1 AND external_id=$2 FOR SHARE',[link.task_id,externalId]);
  assert(current.rowCount,409,'Связь с задачей изменилась во время чтения истории.');
  await db.query(`INSERT INTO bitrix_deadline_history(task_id,external_id,occurred_at,from_deadline,to_deadline,author)
   SELECT $1,external_id,occurred_at,from_deadline,to_deadline,author
   FROM jsonb_to_recordset($2::jsonb) AS x(external_id bigint,occurred_at timestamptz,from_deadline timestamptz,to_deadline timestamptz,author text)
   ON CONFLICT DO NOTHING`,[link.task_id,JSON.stringify(rows)]);
 });
 if(rows.length)await queuePastComments(pool,[link.task_id]);
 return {deadlineChanges:rows.length};
}

async function queuePastComments(db:Db,ids:string[]){
 await db.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id)
  SELECT c.portal,$2,l.external_id::text FROM bitrix_task_links l JOIN bitrix_event_capture c
   ON c.id=1 AND c.enabled AND c.mode='online' AND c.verified_at IS NOT NULL AND c.portal IS NOT NULL
  WHERE l.task_id=ANY($1) AND NOT l.live_enabled
  AND EXISTS(SELECT 1 FROM bitrix_deadline_history h WHERE h.task_id=l.task_id)
  ON CONFLICT DO NOTHING`,[ids,deadlineCommentsResource]);
}

export async function refreshPastDeadlineComments(request:BitrixRequest,externalId:string){
 const {rows:[source]}=await pool.query(`SELECT l.task_id,s.snapshot,min(h.occurred_at) AS earliest
  FROM bitrix_task_links l JOIN bitrix_task_snapshots s USING(external_id)
  JOIN bitrix_deadline_history h USING(task_id) WHERE l.external_id=$1 AND NOT l.live_enabled
  GROUP BY l.task_id,s.snapshot`,[externalId]);
 if(!source||!source.snapshot?.chatId)return {comments:0};
 const {rows:[oldest]}=await pool.query<{id:string;at:string}>(`SELECT external_id::text AS id,occurred_at AS at FROM bitrix_task_activity
  WHERE task_id=$1 AND kind='comment' ORDER BY external_id LIMIT 1`,[source.task_id]);
 const since=Date.parse(source.earliest)-30*60000;
 if(oldest&&Date.parse(oldest.at)<=since)return {comments:0};
 const page=await syncActivity(request,source.task_id,oldest?.id,{task:source.snapshot,commentsOnly:true});
 if(page.messages>=50&&page.olderThan&&(!oldest||BigInt(page.olderThan)<BigInt(oldest.id))){
  await pool.query(`UPDATE bitrix_refresh_queue SET generation=generation+1,updated_at=now()
   WHERE portal=$1 AND resource=$2 AND external_id=$3`,[request.portal,deadlineCommentsResource,externalId]);
 }
 return {comments:page.messages};
}
