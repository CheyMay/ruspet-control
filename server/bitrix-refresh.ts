import {pool,transaction} from './db.js';
import {assert,AppError} from './domain.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {canonicalResource,runArchiveJob} from './bitrix-archive.js';
import {tickLiveSync} from './bitrix-live.js';
import {queueRefresh} from './bitrix-events.js';
import {bitrixId} from './bitrix-sync.js';
import type {User} from '../shared/types.js';
import {syncCompanySnapshots} from './company-responsibility.js';
import {okbConfigured,okbPool} from './okb.js';

export async function reconcileKnownTask(actor:User,portal:string,id:string){
 assert(actor.role==='admin'&&bitrixId(id),403,'Сверку конкретной задачи запускает администратор.');
 await transaction(async db=>{await queueRefresh(db,portal,'task',id);await queueRefresh(db,portal,'task_comments',id);});
}
export async function tickEventRefresh(request:BitrixRequest,maxRequests=1,actor?:User){
 assert(Number.isSafeInteger(maxRequests)&&maxRequests>=1&&maxRequests<=100,400,'Один шаг обновления: 1–100 запросов.');
 const lock=await pool.connect();let acquired=false;
 try{
  acquired=(await lock.query('SELECT pg_try_advisory_lock(431043) ok')).rows[0].ok;if(!acquired)return {processed:0,busy:true};
  const capture=(await pool.query('SELECT * FROM bitrix_event_capture WHERE id=1')).rows[0];if(!capture.enabled)return {processed:0,paused:true};
  assert(!request.portal||request.portal===capture.portal,409,'Другой портал клиента.');
  // Wait until every reserved offline batch is durably saved AND acknowledged.
  if((await pool.query("SELECT 1 FROM bitrix_offline_batches WHERE portal=$1 AND state<>'acked' LIMIT 1",[capture.portal])).rowCount)return {processed:0,awaitingAck:true};
  const run=(await pool.query("SELECT * FROM bitrix_archive_runs WHERE portal=$1 ORDER BY created_at DESC LIMIT 1",[capture.portal])).rows[0];
  if(!run||run.state==='paused'||run.state==='running')return {processed:0,awaitingInitial:true};
  await pool.query("UPDATE bitrix_refresh_queue SET state='pending' WHERE portal=$1 AND state='processing'",[run.portal]);
  let processed=0;
  for(;processed<maxRequests;processed++){
   const item=(await pool.query("SELECT * FROM bitrix_refresh_queue WHERE portal=$1 AND resource NOT IN ('task_inbound','task_inbound_comments') AND generation>done_generation AND state IN ('pending','failed') AND (retry_at IS NULL OR retry_at<=now()) ORDER BY CASE resource WHEN 'task' THEN 0 WHEN 'task_comments' THEN 2 ELSE 1 END,updated_at LIMIT 1",[run.portal])).rows[0];
   if(!item)break;
   // Jobs and their cursors survive a process restart and a long chat history.
   let job=(await pool.query('SELECT * FROM bitrix_archive_jobs WHERE run_id=$1 AND resource=$2 AND external_id=$3',[run.id,item.resource,item.external_id])).rows[0];
   if(!job?.cursor?.refreshGeneration||job.cursor.refreshGeneration!==String(item.generation)){
    const cursor:Record<string,any>={refreshGeneration:String(item.generation),started:new Date().toISOString()};
    if(item.resource==='task_comments'){
     const raw=(await pool.query("SELECT raw FROM bitrix_archive_objects WHERE portal=$1 AND resource='tasks' AND external_id=$2 AND parent_id='0'",[run.portal,item.external_id])).rows[0]?.raw;
     cursor.chatId=raw?.chatId||raw?.CHAT_ID;
    }
    job=(await pool.query("INSERT INTO bitrix_archive_jobs(run_id,resource,external_id,cursor) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,resource,external_id) DO UPDATE SET state='pending',cursor=excluded.cursor,error=NULL,retry_at=NULL RETURNING *",[run.id,item.resource,item.external_id,JSON.stringify(cursor)])).rows[0];
   }
   await pool.query("UPDATE bitrix_refresh_queue SET state='processing' WHERE portal=$1 AND resource=$2 AND external_id=$3",[run.portal,item.resource,item.external_id]);
   try{
    await runArchiveJob(request,run,job);
    const done=(await pool.query('SELECT state FROM bitrix_archive_jobs WHERE id=$1',[job.id])).rows[0].state==='done';
    if(done&&item.resource==='task'){
     const link=(await pool.query('SELECT task_id FROM bitrix_task_links WHERE external_id=$1 AND live_enabled',[item.external_id])).rows[0];
     if(link)await tickLiveSync(request,{taskIds:[link.task_id],poll:false});
    }
    if(done&&item.resource==='company_one'&&capture.project_companies){
     assert(actor?.role==='admin'&&okbConfigured(),409,'Для обновления ОКБ нужны профиль администратора и настроенная отдельная БД.');
     const raw=(await pool.query("SELECT raw FROM bitrix_archive_objects WHERE portal=$1 AND resource='company' AND external_id=$2 AND parent_id='0'",[run.portal,item.external_id])).rows[0].raw;
     await syncCompanySnapshots(actor,{portal:run.portal,dryRun:false,companies:[{externalId:item.external_id,name:raw.TITLE,externalManagerId:bitrixId(raw.ASSIGNED_BY_ID),raw}]});
    }
    await pool.query("UPDATE bitrix_refresh_queue SET done_generation=CASE WHEN $4 THEN $5 ELSE done_generation END,state=CASE WHEN $4 AND generation=$5 THEN 'done' ELSE 'pending' END,error=NULL,retry_at=NULL WHERE portal=$1 AND resource=$2 AND external_id=$3",[run.portal,item.resource,item.external_id,done,item.generation]);
   }catch(error){
    // A permission failure must never masquerade as deletion.
    const deleted=item.delete_hint&&error instanceof BitrixError&&['ERROR_TASK_NOT_FOUND','ERROR_NOT_FOUND','NOT_FOUND'].includes(error.code||'')&&(item.resource==='task'||item.resource.endsWith('_one')||item.resource.startsWith('smart_one:'));
    if(deleted){
     if(item.resource==='company_one'&&capture.project_companies&&okbConfigured())await okbPool().query("UPDATE companies SET bitrix_deleted_at=now(),bitrix_synced_at=now(),version=version+CASE WHEN bitrix_deleted_at IS NULL THEN 1 ELSE 0 END WHERE bitrix_portal=$1 AND bitrix_id=$2",[run.portal,item.external_id]);
     await transaction(async db=>{
      await db.query('UPDATE bitrix_archive_objects SET deleted_at=now() WHERE portal=$1 AND resource=$2 AND external_id=$3',[run.portal,canonicalResource(item.resource),item.external_id]);
      if(item.resource==='task'){
       await db.query("UPDATE bitrix_archive_jobs SET state='done',error=NULL WHERE run_id=$1 AND external_id=$2 AND resource LIKE 'task_%'",[run.id,item.external_id]);
       await db.query("UPDATE bitrix_refresh_queue SET state='done',done_generation=generation,error=NULL WHERE portal=$1 AND external_id=$2 AND resource LIKE 'task_%'",[run.portal,item.external_id]);
       await db.query("UPDATE bitrix_task_links SET conflict='Источник подтвердил удаление задачи. Автоматическая запись остановлена.',live_enabled=false WHERE external_id=$1",[item.external_id]);}
      await db.query("UPDATE bitrix_archive_jobs SET state='done',error=NULL WHERE id=$1",[job.id]);
      await db.query("UPDATE bitrix_refresh_queue SET done_generation=$4,state=CASE WHEN generation=$4 THEN 'done' ELSE 'pending' END,error=NULL WHERE portal=$1 AND resource=$2 AND external_id=$3",[run.portal,item.resource,item.external_id,item.generation]);
     });continue;
    }
    const transient=error instanceof BitrixError&&(!error.code||['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT','OVERLOAD_LIMIT'].includes(error.code));
    await pool.query('UPDATE bitrix_refresh_queue SET state=$4,error=$5,retry_at=now()+interval \'1 minute\' WHERE portal=$1 AND resource=$2 AND external_id=$3',[run.portal,item.resource,item.external_id,transient?'failed':'blocked',error instanceof BitrixError||error instanceof AppError?error.message:'Не удалось обновить объект. Проверьте формат и доступ.']);
    await pool.query("UPDATE bitrix_archive_jobs SET state='blocked',error='Обновление источника не подтверждено.' WHERE id=$1",[job.id]);
    if(transient)break;
   }
  }
  await pool.query(`UPDATE bitrix_archive_runs SET state='ready' WHERE id=$1 AND state='captured' AND capture_started_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM bitrix_event_capture WHERE id=1 AND enabled AND mode='offline' AND verified_at IS NOT NULL AND portal=$2)
   AND NOT EXISTS(SELECT 1 FROM bitrix_archive_jobs WHERE run_id=$1 AND state<>'done')
   AND NOT EXISTS(SELECT 1 FROM bitrix_refresh_queue WHERE portal=$2 AND (generation>done_generation OR state<>'done'))`,[run.id,run.portal]);
  return {processed};
 }finally{if(acquired)await lock.query('SELECT pg_advisory_unlock(431043)');lock.release();}
}
