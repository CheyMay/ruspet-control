import {readRemoteComment} from './bitrix-comments.js';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {Response} from 'express';
import type {User} from '../shared/types.js';
import {assertTaskVisible} from './service.js';
import {assert,AppError} from './domain.js';
import {pool} from './db.js';
import {bitrixClient} from './bitrix-rest.js';
import {getRemote} from './bitrix-sync.js';
import {rawTask} from './bitrix-content.js';
export async function downloadBitrixFile(user:User,taskId:string,fileId:string,res:Response,commentId?:string){
 await assertTaskVisible(user,taskId);
 const external=(await pool.query('SELECT external_id FROM bitrix_task_links WHERE task_id=$1',[taskId])).rows[0];assert(external,404,'Задача не связана.');
 const request=await bitrixClient();const task=await getRemote(request,String(external.external_id));
 let diskId=fileId;
 if(commentId){
  const link=(await pool.query('SELECT l.* FROM bitrix_comment_links l JOIN comments c ON c.id=l.comment_id WHERE l.comment_id=$1 AND l.task_id=$2 AND c.withdrawn_at IS NULL',[commentId,taskId])).rows[0];assert(link,404,'Комментарий не найден.');
  const remote=await readRemoteComment(request,task.id,link.transport,String(link.external_id),task.chatId);assert(remote,404,'Комментарий удалён.');
  const ids=link.transport==='chat'?(remote.files as {FILE_ID?:unknown[]})?.FILE_ID:Array.isArray(remote.files)?remote.files:[];
  assert(Array.isArray(ids)&&ids.map(String).includes(fileId),404,'Файл не прикреплён к комментарию.');
  if(link.transport==='legacy'){
   if(fileId.startsWith('n'))diskId=fileId.slice(1);
   else{const attached=await request<{OBJECT_ID:unknown}>('disk.attachedObject.get',{id:fileId});diskId=String(attached.OBJECT_ID);}
  }
 }else{
  const files=(await pool.query("SELECT snapshot FROM bitrix_task_content WHERE task_id=$1 AND kind='files'",[taskId])).rows[0]?.snapshot as {fileId:string;attachedId:string}[]|undefined;
  const known=files?.find(file=>file.fileId===fileId);assert(known,404,'Файл не найден в задаче.');
  const raw=await rawTask(String(external.external_id));assert(Array.isArray(raw.ufTaskWebdavFiles)&&raw.ufTaskWebdavFiles.map(String).includes(known.attachedId),404,'Файл больше не прикреплён к задаче.');
  const attached=await request<{OBJECT_ID:unknown}>('disk.attachedObject.get',{id:known.attachedId});assert(String(attached.OBJECT_ID)===fileId,409,'Вложение изменилось.');
 }
 const file=await request<{ID:unknown;NAME:string;DOWNLOAD_URL:string}>('disk.file.get',{id:diskId});assert(String(file.ID)===diskId,502,'Не подтверждён файл.');
 let url:URL;try{url=new URL(file.DOWNLOAD_URL);}catch{throw new AppError(502,'Нет адреса загрузки файла.');}
 const allowed=new Set([process.env.BITRIX_PORTAL,...(process.env.BITRIX_FILE_HOSTS??'').split(',').map(host=>host.trim().toLowerCase()).filter(Boolean)]);
 let response:globalThis.Response|undefined;
 for(let redirects=0;redirects<4;redirects++){
  assert(url.protocol==='https:'&&allowed.has(url.hostname)&&!url.username&&!url.password&&!url.port,502,'Адрес файла требует настройки доверенного хранилища.');
  try{response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(60000)});}catch{throw new AppError(502,'Не удалось получить файл Битрикс24.');}
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');assert(location,502,'Неверное перенаправление файла.');
   try{url=new URL(location,url);}catch{throw new AppError(502,'Неверное перенаправление файла.');}
   continue;
  }
  break;
 }
 assert(response,502,'Файл недоступен.');
 assert(response.ok&&response.body,502,'Файл недоступен.');
 res.setHeader('Content-Type','application/octet-stream');res.setHeader('Cache-Control','private, no-store');
 res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.NAME||'file'));
 let bytes=0;
 const bounded=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;callback(bytes>64*1024*1024?new Error('File size limit'):null,chunk);}});
 try{await pipeline(Readable.fromWeb(response.body as any),bounded,res);}catch{res.destroy();}
}
