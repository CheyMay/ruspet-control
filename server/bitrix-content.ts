import {pool} from './db.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {bitrixId,getRemote,syncLinkedTask} from './bitrix-sync.js';
import {mirrorBitrixComment,parseRemoteComment,readRemoteComment,commentFiles} from './bitrix-comments.js';
import {safeBitrixData} from './bitrix-data.js';

export async function saveBitrixContent(taskId:string,kind:string,snapshot:unknown){
 await pool.query(`INSERT INTO bitrix_task_content(task_id,kind,snapshot) VALUES($1,$2,$3)
  ON CONFLICT(task_id,kind) DO UPDATE SET snapshot=excluded.snapshot,fetched_at=now(),
  revision=bitrix_task_content.revision+CASE WHEN bitrix_task_content.snapshot IS DISTINCT FROM excluded.snapshot THEN 1 ELSE 0 END`,[taskId,kind,JSON.stringify(safeBitrixData(snapshot))]);
}
export async function rawTask(externalId:string){return (await pool.query('SELECT raw_snapshot FROM bitrix_task_snapshots WHERE external_id=$1',[externalId])).rows[0]?.raw_snapshot??{};}
export async function refreshBitrixMetadata(request:BitrixRequest){
 const result=await request<{fields:Record<string,unknown>}>('tasks.task.getFields',{});
 if(!result.fields||typeof result.fields!=='object')throw new BitrixError('Нет метаданных полей Битрикс24.');
 await pool.query('INSERT INTO bitrix_metadata(id,fields) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET fields=excluded.fields,fetched_at=now()',[JSON.stringify(safeBitrixData(result.fields))]);
 return result.fields;
}
export async function refreshBitrixFiles(request:BitrixRequest,taskId:string,externalId:string,limit=Infinity){
 const raw=await rawTask(externalId),ids=raw.ufTaskWebdavFiles??[];
 if(!Array.isArray(ids))throw new BitrixError('Неверный список файлов задачи.');
 const state=(await pool.query('SELECT files_cursor FROM bitrix_content_state WHERE task_id=$1',[taskId])).rows[0];
 const cursor=Number(state?.files_cursor??0)%Math.max(1,ids.length);
 const selected=Number.isFinite(limit)?[...ids.slice(cursor),...ids.slice(0,cursor)].slice(0,limit):ids;
 const cached=(await pool.query("SELECT snapshot FROM bitrix_task_content WHERE task_id=$1 AND kind='files'",[taskId])).rows[0]?.snapshot??[];
 const files=Number.isFinite(limit)?cached.filter((f:any)=>ids.map(String).includes(f.attachedId)&&!selected.map(String).includes(f.attachedId)):[];
 for(const value of selected){
  const id=bitrixId(typeof value==='object'?value?.id:value);
  if(!id)throw new BitrixError('Нет ID вложения задачи.');
  const attached=await request<{ID:unknown;OBJECT_ID:unknown}>('disk.attachedObject.get',{id});
  const fileId=bitrixId(attached.OBJECT_ID);
  if(String(attached.ID)!==id||!fileId)throw new BitrixError('Не подтверждена связь файла с задачей.');
  const file=await request<Record<string,unknown>>('disk.file.get',{id:fileId});
  if(String(file.ID)!==fileId)throw new BitrixError('Нет подтверждённого файла.');
  files.push({attachedId:id,fileId,...safeBitrixData(file) as object});
 }
 await saveBitrixContent(taskId,'files',files);
 if(Number.isFinite(limit))await pool.query('UPDATE bitrix_content_state SET files_cursor=$2 WHERE task_id=$1',[taskId,(cursor+selected.length)%Math.max(1,ids.length)]);
 return files;
}
export async function listBitrixResults(request:BitrixRequest,externalId:string,chat=false){
 if(!chat){const list=await request<unknown[]>('tasks.task.result.list',{taskId:externalId,params:{WITH_USER_INFO:'Y',WITH_FILE_INFO:'Y'}});if(!Array.isArray(list))throw new BitrixError('Нет результатов задачи.');return list;}
 const list:unknown[]=[];
 for(let page=0;page<20;page++){
  const result=await request<{items:unknown[]}>('tasks.task.result.list',{filter:[['taskId',Number(externalId)]],select:['id','taskId','text','authorId','createdAt','status','messageId','fileIds'],pagination:{limit:50,offset:page*50}},{version:3});
  if(!Array.isArray(result.items))throw new BitrixError('Нет результатов новой карточки.');
  list.push(...result.items);if(result.items.length<50)return list;
 }
 throw new BitrixError('Результатов больше 1000; нужна дополнительная пагинация.');
}
export async function refreshDiscussion(request:BitrixRequest,taskId:string,externalId:string,cursor:string|null,latest='0'){
 const task=await getRemote(request,externalId);
 if(!task.chatId){
  if(process.env.BITRIX_LEGACY_COMMENTS!=='true')throw new BitrixError('Для старой карточки включите BITRIX_LEGACY_COMMENTS после проверки.');
  const rows=await request<Record<string,unknown>[]>('task.commentitem.getlist',{TASKID:externalId,ORDER:{ID:'desc'},FILTER:{}});
  if(!Array.isArray(rows))throw new BitrixError('Нет списка комментариев.');
  for(const row of rows){const comment=parseRemoteComment(row,'legacy');await mirrorBitrixComment(request,taskId,'legacy',comment.id,comment);}
 }else{
  const page=await request<{chat_id:unknown;messages:Record<string,unknown>[];files?:Record<string,unknown>[]}>('im.dialog.messages.get',{
   DIALOG_ID:'chat'+task.chatId,LIMIT:50,...(cursor==='0'?{FIRST_ID:latest}:cursor?{LAST_ID:cursor}:{})});
  if(String(page.chat_id)!==task.chatId||!Array.isArray(page.messages))throw new BitrixError('Нет подтверждённой истории чата задачи.');
  for(const row of page.messages){const id=bitrixId(row.id);if(!id)throw new BitrixError('Нет ID сообщения.');const comment=(row.params as any)?.IS_DELETED==='Y'?null:commentFiles(parseRemoteComment(row,'chat'),page.files??[]);await mirrorBitrixComment(request,taskId,'chat',id,comment);}
  const newest=page.messages.map(row=>bitrixId(row.id)!).reduce<string>((a,b)=>BigInt(b)>BigInt(a)?b:a,'0');
  await pool.query('UPDATE bitrix_content_state SET chat_latest=greatest(chat_latest,$2::bigint) WHERE task_id=$1',[taskId,newest]);
  // Backfill one page per visit. Once complete, refresh recent messages and audit old linked messages.
  if(cursor!=='0'){
   const oldest=page.messages.map(row=>bitrixId(row.id)!).reduce<string|null>((a,b)=>!a||BigInt(b)<BigInt(a)?b:a,null);
   if(oldest&&cursor&&BigInt(oldest)>=BigInt(cursor))throw new BitrixError('История чата не продвигается по страницам.');
   await pool.query('UPDATE bitrix_content_state SET chat_cursor=$2 WHERE task_id=$1',[taskId,oldest??'0']);
  }
 }
 const tracked=(await pool.query('SELECT * FROM bitrix_comment_links WHERE task_id=$1 AND NOT remote_deleted ORDER BY checked_at NULLS FIRST,external_id LIMIT 2',[taskId])).rows;
 for(const link of tracked){
  const remote=await readRemoteComment(request,externalId,link.transport,String(link.external_id),task.chatId);
  await mirrorBitrixComment(request,taskId,link.transport,String(link.external_id),remote);
  await pool.query('UPDATE bitrix_comment_links SET checked_at=now() WHERE comment_id=$1',[link.comment_id]);
 }
}
let nextContentPoll=0;
/** Each visit refreshes one section; REST limiter remains shared with writes and events. */
export async function processBitrixContent(request:BitrixRequest){
 if(process.env.BITRIX_CONTENT_ENABLED!=='true'||Date.now()<nextContentPoll)return false;
 nextContentPoll=Date.now()+15000;
 await pool.query('INSERT INTO bitrix_content_state(task_id) SELECT task_id FROM bitrix_task_links ON CONFLICT DO NOTHING');
 const row=(await pool.query(`SELECT s.*,l.external_id FROM bitrix_content_state s JOIN bitrix_task_links l USING(task_id)
  WHERE (s.retry_at IS NULL OR s.retry_at<=now())
  AND l.conflict IS DISTINCT FROM 'Задача удалена в Битрикс24. Требуется решение руководителя.'
  ORDER BY s.requested_at NULLS LAST,s.checked_at NULLS FIRST,s.task_id LIMIT 1`)).rows[0];
 if(!row)return false;
 try{
  const externalId=String(row.external_id);
  switch(row.phase){
   case 0:{await syncLinkedTask(request,row.task_id,false);await saveBitrixContent(row.task_id,'fields',await rawTask(externalId));break;}
   case 1:{const list=await request<unknown>('task.checklistitem.getlist',{TASKID:externalId,ORDER:{SORT_INDEX:'asc'}});if(!Array.isArray(list))throw new BitrixError('Нет списка чек-листов.');await saveBitrixContent(row.task_id,'checklist',list);break;}
   case 2:{const raw=await rawTask(externalId);const result=await listBitrixResults(request,externalId,!!bitrixId(raw.chatId));await saveBitrixContent(row.task_id,'results',result);break;}
   case 3:{const history=await request<{list:unknown[]}>('tasks.task.history.list',{taskId:externalId});if(!Array.isArray(history.list))throw new BitrixError('Нет истории задачи.');await saveBitrixContent(row.task_id,'history',history.list);break;}
   case 4:{await refreshDiscussion(request,row.task_id,externalId,row.chat_cursor==null?null:String(row.chat_cursor),String(row.chat_latest));break;}
   case 5:{await refreshBitrixFiles(request,row.task_id,externalId,3);break;}
  }
  await pool.query("UPDATE bitrix_content_state SET checked_at=now(),phase=(phase+1)%6,retry_at=now()+CASE WHEN requested_at IS NULL THEN interval '2 minutes' ELSE interval '15 seconds' END,last_error=NULL,errors=errors-$2::text,requested_at=CASE WHEN phase=5 THEN NULL ELSE requested_at END WHERE task_id=$1",[row.task_id,String(row.phase)]);
 }catch(e){
  // An unavailable optional section must not prevent other sections from refreshing.
  await pool.query("UPDATE bitrix_content_state SET checked_at=now(),phase=(phase+1)%6,retry_at=now()+CASE WHEN requested_at IS NULL THEN interval '2 minutes' ELSE interval '15 seconds' END,last_error=$2,errors=jsonb_set(errors,ARRAY[$3::text],to_jsonb($2::text)),requested_at=CASE WHEN phase=5 THEN NULL ELSE requested_at END WHERE task_id=$1",[row.task_id,e instanceof BitrixError?e.message:'Ошибка сверки содержимого задачи.',String(row.phase)]);
 }
 return true;
}
