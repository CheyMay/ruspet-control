import {isDeepStrictEqual} from 'node:util';
import {safeBitrixData} from './bitrix-data.js';
import {randomUUID} from 'node:crypto';
import {pool,transaction} from './db.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {bitrixId,getRemote} from './bitrix-sync.js';
import {ensureBitrixUser} from './bitrix-users.js';
import {importBitrixTask} from './bitrix-import.js';

export type CommentTransport='chat'|'legacy';
export type RemoteComment={id:string;body:string;author:string|null;date:string;files:unknown};
const when=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export function parseRemoteComment(row:Record<string,unknown>,transport:CommentTransport):RemoteComment{
 const id=bitrixId(transport==='chat'?row.id:row.ID),date=when(transport==='chat'?row.date:row.POST_DATE);
 const body=transport==='chat'?row.text:row.POST_MESSAGE;
 if(!id||!date||typeof body!=='string')throw new BitrixError('Нет обязательных полей сообщения Битрикс24.');
 return {id,date,body,author:bitrixId(transport==='chat'?row.author_id:row.AUTHOR_ID),files:transport==='chat'?row.params??{}:row.UF_FORUM_MESSAGE_DOC??[]};
}
export function commentFiles(comment:RemoteComment,files:Record<string,unknown>[]=[]){
 const params=comment.files&&typeof comment.files==='object'&&!Array.isArray(comment.files)?comment.files as Record<string,unknown>:null;
 if(params){const ids=Array.isArray(params.FILE_ID)?params.FILE_ID.map(String):[];comment.files={...params,files:files.filter(f=>ids.includes(String(f.id))).map(f=>({id:f.id,name:f.name,size:f.size,type:f.type}))};}
 return comment;
}
export async function readRemoteComment(request:BitrixRequest,taskId:string,transport:CommentTransport,id:string,chatId?:string|null){
 if(transport==='legacy'){
  const records=await request<Record<string,unknown>[]>('task.commentitem.getlist',{TASKID:taskId,ORDER:{ID:'desc'},FILTER:{ID:id}});
  if(!Array.isArray(records)||records.some(row=>String(row.ID)!==id))throw new BitrixError('Неверный ответ чтения комментария.');
  return records.length?parseRemoteComment(records[0],transport):null;
 }
 if(!chatId)throw new BitrixError('Нет чата задачи.');
 const result=await request<{chat_id:unknown;messages:Record<string,unknown>[];files?:Record<string,unknown>[]}>('im.dialog.messages.get',{
  DIALOG_ID:'chat'+chatId,LAST_ID:String(BigInt(id)+1n),LIMIT:1});
 if(String(result.chat_id)!==chatId||!Array.isArray(result.messages)||result.messages.some(row=>!bitrixId(row.id)||BigInt(String(row.id))>BigInt(id)))throw new BitrixError('Нет подтверждённого ответа нужного чата.');
 const record=result.messages.find(row=>String(row.id)===id);
 return record&&(record.params as {IS_DELETED?:string}|undefined)?.IS_DELETED!=='Y'?commentFiles(parseRemoteComment(record,transport),result.files??[]):null;
}
export async function mirrorBitrixComment(request:BitrixRequest,taskId:string,transport:CommentTransport,id:string,remote:RemoteComment|null){
 const linked=(await pool.query('SELECT comment_id FROM bitrix_comment_links WHERE task_id=$1 AND transport=$2 AND external_id=$3',[taskId,transport,id])).rows[0];
 let author:string|null=null;
 if(remote&&!linked){
  if(remote.author)author=await ensureBitrixUser(request,remote.author);
  else{
   author='bitrix-system';
   await pool.query("INSERT INTO users(id,name,role,branch_id,position) VALUES($1,'Система Битрикс24','employee','Не указан','Системные события') ON CONFLICT DO NOTHING",[author]);
  }
 }
 return transaction(async db=>{
  await db.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[taskId]);
  await db.query("SELECT set_config('ruspet.bitrix_inbound','true',true)");
  const link=(await db.query('SELECT l.*,c.body,c.withdrawn_at FROM bitrix_comment_links l JOIN comments c ON c.id=l.comment_id WHERE l.task_id=$1 AND l.transport=$2 AND l.external_id=$3 FOR UPDATE OF c,l',[taskId,transport,id])).rows[0];
  if(!link){
   if(!remote)return {changed:false};
   if(!author)throw new BitrixError('Не подтверждён автор комментария.');
   const commentId=randomUUID();
   await db.query('INSERT INTO comments(id,task_id,author_id,body,kind,created_at,bitrix_origin) VALUES($1,$2,$3,$4,$5,$6,true)',[commentId,taskId,author,remote.body,'comment',remote.date]);
   await db.query('INSERT INTO bitrix_comment_links(comment_id,task_id,transport,external_id,remote_body,local_body) VALUES($1,$2,$3,$4,$5,$5)',[commentId,taskId,transport,id,remote.body]);
   await db.query('UPDATE bitrix_comment_links SET attachments=$2 WHERE comment_id=$1',[commentId,JSON.stringify(safeBitrixData(remote.files))]);
   await db.query('INSERT INTO bitrix_comment_revisions(comment_id,body,deleted) VALUES($1,$2,false)',[commentId,remote.body]);
   await db.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,'bitrix_comment_added','Получен комментарий из Битрикс24',$3)",[randomUUID(),taskId,JSON.stringify({commentId,externalId:id})]);
   return {changed:true};
  }
  if((!remote&&link.remote_deleted)||(remote&&remote.body===link.remote_body&&!link.remote_deleted&&isDeepStrictEqual(safeBitrixData(remote.files),link.attachments)))return {changed:false};
  const q=(await db.query('SELECT state FROM bitrix_comment_outbox WHERE comment_id=$1 FOR UPDATE',[link.comment_id])).rows[0];
  const body=remote?(link.prefix&&remote.body.startsWith(link.prefix)?remote.body.slice(link.prefix.length):remote.body):link.body;
  if(q&&q.state!=='sent'&&(body!==link.body||!remote!==!!link.withdrawn_at)){
   await db.query("UPDATE bitrix_comment_outbox SET state='conflict',last_error='Комментарий одновременно изменён в Битрикс24.' WHERE comment_id=$1",[link.comment_id]);
   return {changed:false,conflict:true};
  }
  await db.query('UPDATE comments SET body=$2,withdrawn_at=CASE WHEN $3 THEN coalesce(withdrawn_at,now()) ELSE NULL END,revision=revision+1 WHERE id=$1',[link.comment_id,body,!remote]);
  await db.query('UPDATE bitrix_comment_links SET remote_body=$2,local_body=$3,remote_deleted=$4,attachments=$5 WHERE comment_id=$1',[link.comment_id,remote?.body??link.remote_body,body,!remote,JSON.stringify(safeBitrixData(remote?.files??link.attachments))]);
  await db.query('INSERT INTO bitrix_comment_revisions(comment_id,body,deleted) VALUES($1,$2,$3)',[link.comment_id,body,!remote]);
  await db.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,$3,$4,$5)",[randomUUID(),taskId,remote?'bitrix_comment_updated':'bitrix_comment_deleted',remote?'Комментарий изменён в Битрикс24':'Комментарий удалён в Битрикс24',JSON.stringify({commentId:link.comment_id,externalId:id})]);
  return {changed:true};
 });
}

export async function processBitrixCommentEvent(request:BitrixRequest){
 const row=(await pool.query('SELECT * FROM bitrix_comment_events WHERE processed_at IS NULL AND available_at<=now() ORDER BY available_at LIMIT 1')).rows[0];
 if(!row)return false;
 try{
  let taskId=(await pool.query('SELECT task_id FROM bitrix_task_links WHERE external_id=$1',[row.task_external_id])).rows[0]?.task_id;
  if(!taskId){
   if(process.env.BITRIX_IMPORT_NEW_ENABLED!=='true')throw new BitrixError('Комментарий ожидает привязки задачи.');
   taskId=await importBitrixTask(request,String(row.task_external_id));
  }
  const task=await getRemote(request,String(row.task_external_id));
  const remote=await readRemoteComment(request,task.id,row.transport,String(row.external_id),task.chatId);
  if(!remote&&row.event==='ONTASKCOMMENTADD')throw new BitrixError('Добавленный комментарий ещё не подтверждён чтением.');
  await mirrorBitrixComment(request,taskId,row.transport,String(row.external_id),remote);
  await pool.query('UPDATE bitrix_comment_events SET processed_at=now(),last_error=NULL WHERE task_external_id=$1 AND transport=$2 AND external_id=$3 AND revision=$4',[row.task_external_id,row.transport,row.external_id,row.revision]);
 }catch(e){
  await pool.query("UPDATE bitrix_comment_events SET attempts=attempts+1,last_error=$4,available_at=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second' WHERE task_external_id=$1 AND transport=$2 AND external_id=$3 AND revision=$5",
   [row.task_external_id,row.transport,row.external_id,e instanceof BitrixError?e.message:'Ошибка чтения комментария.',row.revision]);
 }
 return true;
}

export async function processBitrixCommentOutbound(request:BitrixRequest){
 if(process.env.BITRIX_WRITE_ENABLED!=='true')return false;
 const row=(await pool.query(`SELECT q.*,c.task_id,c.body,c.withdrawn_at,c.kind,c.author_id,u.name,l.external_id AS task_external_id
  FROM bitrix_comment_outbox q JOIN comments c ON c.id=q.comment_id JOIN users u ON u.id=c.author_id JOIN bitrix_task_links l ON l.task_id=c.task_id
  WHERE q.state IN ('pending','failed') AND (q.retry_at IS NULL OR q.retry_at<=now())
  AND l.conflict IS DISTINCT FROM 'Задача удалена в Битрикс24. Требуется решение руководителя.' ORDER BY q.created_at LIMIT 1`)).rows[0];
 if(!row)return false;
 let link=(await pool.query('SELECT * FROM bitrix_comment_links WHERE comment_id=$1',[row.comment_id])).rows[0];
 let adding=false;
 const acknowledge=async()=>pool.query("UPDATE bitrix_comment_outbox SET state=CASE WHEN revision=$2 THEN 'sent' ELSE 'pending' END,retry_at=NULL,last_error=NULL WHERE comment_id=$1",[row.comment_id,row.revision]);
 try{
  if(!link&&row.withdrawn_at){await acknowledge();return true;}
  const task=await getRemote(request,String(row.task_external_id));
  const transport:CommentTransport=link?.transport??(task.chatId?'chat':'legacy');
  if(transport==='legacy'&&process.env.BITRIX_LEGACY_COMMENTS!=='true')throw new BitrixError('Проверьте старую карточку и включите BITRIX_LEGACY_COMMENTS.');
  const prefix=link?.prefix??(row.name+' · РУСПЭТ\n');
  const body=prefix+row.body;
  if(!link){
   await pool.query("UPDATE bitrix_comment_outbox SET state='sending',attempts=attempts+1,attempted_body=$2,attempted_revision=$3,attempted_local_body=$4,attempted_prefix=$5 WHERE comment_id=$1",[row.comment_id,body,row.revision,row.body,prefix]);
   adding=true;
   const result=transport==='chat'?await request<unknown>('im.message.add',{DIALOG_ID:'chat'+task.chatId,MESSAGE:body,URL_PREVIEW:'N'}):
    await request<unknown>('task.commentitem.add',{TASKID:task.id,FIELDS:{POST_MESSAGE:body}});
   const externalId=bitrixId(result);
   if(!externalId)throw new BitrixError('Нет ID отправленного комментария.');
   link=(await pool.query('INSERT INTO bitrix_comment_links(comment_id,task_id,transport,external_id,remote_body,local_body,prefix) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[row.comment_id,row.task_id,transport,externalId,body,row.body,prefix])).rows[0];
   adding=false;
  }else{
   const remote=await readRemoteComment(request,task.id,transport,String(link.external_id),task.chatId);
   if(!remote&&row.withdrawn_at){await acknowledge();return true;}
   if(!remote||remote.body!==link.remote_body&&remote.body!==body){
    await pool.query("UPDATE bitrix_comment_outbox SET state='conflict',last_error='Комментарий изменён или удалён в Битрикс24.' WHERE comment_id=$1",[row.comment_id]);return true;
   }
   if(row.withdrawn_at||remote.body!==body){
    await pool.query('UPDATE bitrix_comment_outbox SET attempts=attempts+1 WHERE comment_id=$1',[row.comment_id]);
    if(row.withdrawn_at){
     if(transport==='chat')await request('im.message.delete',{MESSAGE_ID:String(link.external_id)});
     else await request('task.commentitem.delete',{TASKID:task.id,ITEMID:String(link.external_id)});
    }else if(transport==='chat')await request('im.message.update',{MESSAGE_ID:String(link.external_id),MESSAGE:body});
    else await request('task.commentitem.update',{TASKID:task.id,ITEMID:String(link.external_id),FIELDS:{POST_MESSAGE:body}});
   }
  }
  const verified=await readRemoteComment(request,task.id,transport,String(link.external_id),task.chatId);
  if(row.withdrawn_at?verified!==null:verified?.body!==body)throw new BitrixError('Изменение комментария не подтверждено чтением.');
  await pool.query('UPDATE bitrix_comment_links SET remote_body=$2,local_body=$3,remote_deleted=$4 WHERE comment_id=$1',[row.comment_id,body,row.body,!!row.withdrawn_at]);
  if(row.kind==='review'&&!row.withdrawn_at&&(await pool.query('SELECT 1 FROM task_submissions WHERE task_id=$1 AND author_id=$2 AND result=$3',[row.task_id,row.author_id,row.body])).rowCount){
   await pool.query("INSERT INTO bitrix_content_ops(id,task_id,actor_id,kind,payload,baseline,dedupe_key) VALUES($1,$2,$3,'result.pin',$4,'{}',$5) ON CONFLICT(dedupe_key) DO NOTHING",
    [randomUUID(),row.task_id,row.author_id,JSON.stringify({commentId:row.comment_id}),'result:'+row.comment_id]);
  }
  await acknowledge();
 }catch(e){
  await pool.query("UPDATE bitrix_comment_outbox SET state=$2,last_error=$3,retry_at=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second' WHERE comment_id=$1",[row.comment_id,adding?'uncertain':'failed',e instanceof BitrixError?e.message:'Ошибка отправки комментария.']);
 }
 return true;
}
