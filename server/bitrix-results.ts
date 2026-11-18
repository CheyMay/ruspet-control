import {pool,transaction} from './db.js';
import {assert} from './domain.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {bitrixId} from './bitrix-sync.js';
import type {BitrixResult,BitrixResults} from '../shared/types.js';

export const resultsResource='task_inbound_results';
const stamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;

export async function refreshBitrixResults(request:BitrixRequest,externalId:string){
 const link=(await pool.query<{task_id:string}>('SELECT task_id FROM bitrix_task_links WHERE external_id=$1',[externalId])).rows[0];
 if(!link)return {ignored:'Связь с задачей снята.'};
 const data=await request<Record<string,unknown>[]>('tasks.task.result.list',{
  taskId:externalId,params:{WITH_USER_INFO:'Y',WITH_FILE_INFO:'Y'}
 });
 if(!Array.isArray(data))throw new BitrixError('Битрикс24 не вернул список результатов.');
 const results:BitrixResult[]=data.map(record=>{
  const id=bitrixId(record?.id);
  if(!id||bitrixId(record?.taskId)!==externalId||typeof record.text!=='string')throw new BitrixError('Битрикс24 вернул результат с неполными данными или другим ID задачи.');
  const userId=bitrixId(record.createdBy);
  const users=record.userInfo as Record<string,{formattedName?:string;name?:string;lastName?:string}>|undefined;
  const person=userId?users?.[userId]:undefined;
  const files=record.fileInfo as Record<string,{name?:unknown;NAME?:unknown}>|undefined;
  return {external_id:id,comment_id:bitrixId(record.commentId),occurred_at:stamp(record.createdAt)??stamp(record.updatedAt),
   author:person?.formattedName||[person?.name,person?.lastName].filter(Boolean).join(' ')||'Битрикс24',
   body:record.text,files:(Array.isArray(record.files)?record.files:[]).flatMap(value=>{
    const id=bitrixId(value);
    const name=id?(files?.[id]?.name??files?.[id]?.NAME):null;
    return id?[{id,name:typeof name==='string'?name:null}]:[];
   })};
 });
 if(new Set(results.map(row=>row.external_id)).size!==results.length)throw new BitrixError('Битрикс24 вернул повторяющиеся ID результатов.');
 await transaction(async db=>{
  const current=await db.query('SELECT 1 FROM bitrix_task_links WHERE task_id=$1 AND external_id=$2 FOR SHARE',[link.task_id,externalId]);
  assert(current.rowCount,409,'Связь с задачей изменилась во время чтения результата.');
  await db.query('DELETE FROM bitrix_task_results WHERE task_id=$1 AND NOT(external_id=ANY($2::bigint[]))',[link.task_id,results.map(row=>row.external_id)]);
  await db.query(`INSERT INTO bitrix_task_results(task_id,external_id,comment_id,occurred_at,author,body,files)
   SELECT $1,external_id,comment_id,occurred_at,author,body,files
   FROM jsonb_to_recordset($2::jsonb) AS x(external_id bigint,comment_id bigint,occurred_at timestamptz,author text,body text,files jsonb)
   ON CONFLICT(task_id,external_id) DO UPDATE SET comment_id=excluded.comment_id,occurred_at=excluded.occurred_at,
   author=excluded.author,body=excluded.body,files=excluded.files`,[link.task_id,JSON.stringify(results)]);
 });
 return {results:results.length};
}

export async function loadBitrixResults(taskId:string,allowQueue:boolean):Promise<BitrixResults>{
 const [stored,links]=await Promise.all([
  pool.query<BitrixResult>(`SELECT external_id,comment_id,occurred_at,author,body,files FROM bitrix_task_results
   WHERE task_id=$1 ORDER BY occurred_at DESC NULLS LAST,external_id DESC`,[taskId]),
  pool.query<{external_id:string;portal:string|null;capture_enabled:boolean;state:string|null;due:boolean}>(`SELECT l.external_id::text,
   coalesce($2,c.portal) AS portal,c.portal IS NOT NULL AS capture_enabled,q.state,q.updated_at<now()-interval '5 minutes' AS due
   FROM bitrix_task_links l LEFT JOIN bitrix_event_capture c ON c.id=1 AND c.enabled AND c.mode='online'
   LEFT JOIN bitrix_refresh_queue q ON q.portal=coalesce($2,c.portal) AND q.resource=$3 AND q.external_id=l.external_id::text
   WHERE l.task_id=$1`,[taskId,process.env.BITRIX_PORTAL??null,resultsResource])
 ]);
 const link=links.rows[0];
 const portal=link?.portal;
 const origin=portal&&/^[a-z0-9.-]+$/i.test(portal)?'https://'+portal:null;
 const inbound=process.env.BITRIX_INBOUND_TASKS;
 const canQueue=allowQueue&&(inbound==='true'||inbound===undefined&&link?.capture_enabled);
 let state:BitrixResults['state']='ready';
 if(link?.state==='blocked')state='unavailable';
 else if(link?.state==='pending'||link?.state==='failed'||link?.state==='processing')state='pending';
 else if(link&&canQueue&&portal&&(!link.state||link.state==='done'&&link.due)){
  const queued=await pool.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id) VALUES($1,$2,$3)
   ON CONFLICT(portal,resource,external_id) DO UPDATE SET generation=bitrix_refresh_queue.generation+1,
   state='pending',retry_at=NULL,error=NULL,updated_at=now()
   WHERE bitrix_refresh_queue.state='done' AND bitrix_refresh_queue.updated_at<now()-interval '5 minutes'`,
  [portal,resultsResource,link.external_id]);
  if(queued.rowCount||!link.state)state='pending';
 }
 return {state,origin,items:stored.rows};
}
