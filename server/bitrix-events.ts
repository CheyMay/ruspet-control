import {markBitrixTaskDeleted} from './bitrix-deleted.js';
import {importBitrixTask} from './bitrix-import.js';
import {createHash,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Express} from 'express';
import express from 'express';
import {pool} from './db.js';
import {bitrixId,syncLinkedTask,getRemote} from './bitrix-sync.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';

const commentEvents=new Set(['ONTASKCOMMENTADD','ONTASKCOMMENTUPDATE','ONTASKCOMMENTDELETE']);
const events=new Set(['ONTASKADD','ONTASKUPDATE','ONTASKDELETE']);
const digest=(s:string)=>createHash('sha256').update(s).digest();
export function mountBitrixEvents(app:Express){
 app.post('/integrations/bitrix/events',express.urlencoded({extended:true,limit:'32kb',parameterLimit:100}),async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(process.env.BITRIX_EVENTS_ENABLED!=='true')return res.sendStatus(404);
  let tokens:string[];
  try{tokens=(await readFile(process.env.BITRIX_EVENT_TOKEN_FILE||'','utf8')).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);}
  catch{return res.status(503).json({error:'Приём событий не настроен.'});}
  const auth=req.body?.auth;
  if(!tokens.length||typeof auth?.application_token!=='string'||!tokens.some(token=>timingSafeEqual(digest(token),digest(auth.application_token)))||
   typeof auth?.domain!=='string'||auth.domain.toLowerCase()!==process.env.BITRIX_PORTAL?.toLowerCase())return res.sendStatus(403);
  const event=String(req.body?.event||'').toUpperCase();
  if(commentEvents.has(event)){
   const before=req.body?.data?.FIELDS_BEFORE,after=req.body?.data?.FIELDS_AFTER;
   const taskId=bitrixId(after?.TASK_ID??before?.TASK_ID);
   const messageId=bitrixId(after?.MESSAGE_ID??before?.MESSAGE_ID);
   const commentId=messageId??bitrixId(after?.ID??before?.ID);
   if(!taskId||!commentId)return res.status(400).json({error:'Нет ID задачи или сообщения.'});
   await pool.query(`INSERT INTO bitrix_comment_events(task_external_id,transport,external_id,event) VALUES($1,$2,$3,$4)
    ON CONFLICT(task_external_id,transport,external_id) DO UPDATE SET event=excluded.event,
    revision=bitrix_comment_events.revision+1,processed_at=NULL,last_error=NULL`,[taskId,messageId?'chat':'legacy',commentId,event]);
   return res.status(202).json({queued:true});
  }
  if(!events.has(event))return res.status(200).json({ignored:true});
  const id=bitrixId(req.body?.data?.FIELDS_AFTER?.ID??req.body?.data?.FIELDS_BEFORE?.ID);
  if(!id)return res.status(400).json({error:'Нет ID задачи.'});
  // Persist before acknowledging. No REST calls or credentials in the queue.
  await pool.query(`INSERT INTO bitrix_event_queue(external_id,event) VALUES($1,$2)
   ON CONFLICT(external_id) DO UPDATE SET event=excluded.event,revision=bitrix_event_queue.revision+1,
    received_at=now(),processed_at=NULL,blocked=false,last_error=NULL,
    available_at=CASE WHEN bitrix_event_queue.processed_at IS NULL AND NOT bitrix_event_queue.blocked
     THEN bitrix_event_queue.available_at ELSE now()+interval '3 seconds' END`,[id,event]);
  return res.status(202).json({queued:true});
 });
}

export async function processBitrixEvent(request:BitrixRequest){
 const row=(await pool.query(`SELECT * FROM bitrix_event_queue WHERE processed_at IS NULL AND NOT blocked AND available_at<=now()
  ORDER BY available_at,external_id LIMIT 1`)).rows[0];
 if(!row)return false;
 const revision=String(row.revision),externalId=String(row.external_id);
 const finish=async(error:string|null,blocked=false)=>pool.query(`UPDATE bitrix_event_queue SET processed_at=now(),last_error=$3,blocked=$4
  WHERE external_id=$1 AND revision=$2`,[externalId,revision,error,blocked]);
 let link=(await pool.query('SELECT task_id FROM bitrix_task_links WHERE external_id=$1',[externalId])).rows[0];
 if(!link&&row.event==='ONTASKDELETE'){await finish('Удалена несвязанная задача.',true);return true;}
 if(!link&&process.env.BITRIX_IMPORT_NEW_ENABLED!=='true'){await finish('Задача ожидает привязки по выгрузке.',true);return true;}
 try{
  if(link&&row.event==='ONTASKDELETE'){
   try{
    const remote=await getRemote(request,externalId);
    const cached:BitrixRequest=async <T>()=>({task:remote} as T);
    await syncLinkedTask(cached,link.task_id,false);
    await finish(null); // A late delete signal must not archive a restored/existing task.
   }catch(e){
    if(!(e instanceof BitrixError)||e.message!=='ERROR_TASK_NOT_FOUND')throw e;
    await markBitrixTaskDeleted(link.task_id);
    await finish('Удаление подтверждено. Данные сохранены в архиве.',true);
   }
   return true;
  }
  if(!link)link={task_id:await importBitrixTask(request,externalId)};
  // Incoming signals never perform outbound writes; the local outbox owns them.
  const plan=await syncLinkedTask(request,link.task_id,false);
  await finish(plan.conflict.length||plan.outbound.length?'Требуется разрешение конфликта или отправка локальных изменений.':null);
 }catch(e){
  const reason=e instanceof BitrixError?e.message:'Ошибка сверки задачи.';
  await pool.query(`UPDATE bitrix_event_queue SET attempts=attempts+1,last_error=$3,
   available_at=now()+least(3600,30*power(2,least(attempts,7))) * interval '1 second'
   WHERE external_id=$1 AND revision=$2`,[externalId,revision,reason]);
 }
 return true;
}
