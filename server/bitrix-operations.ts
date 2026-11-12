import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {pool,transaction} from './db.js';
import {assert,canSee,canEdit,canRequest} from './domain.js';
import type {Task,User} from '../shared/types.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {bitrixId,getRemote} from './bitrix-sync.js';
import {rawTask,saveBitrixContent,refreshBitrixFiles,listBitrixResults} from './bitrix-content.js';

const id=z.string().regex(/^[1-9]\d{0,17}$/),title=z.string().trim().min(1).max(4000);
const checklistFields=z.object({TITLE:title.optional(),IS_COMPLETE:z.enum(['Y','N']).optional(),IS_IMPORTANT:z.enum(['Y','N']).optional(),PARENT_ID:z.union([id,z.literal('0')]).optional(),SORT_INDEX:z.number().int().nonnegative().optional()}).strict();
export const contentInput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('checklist.add'),fields:checklistFields.extend({TITLE:title}),expectedRevision:z.number().int().positive()}),
 z.object({kind:z.literal('checklist.update'),itemId:id,fields:checklistFields,expectedRevision:z.number().int().positive()}),
 z.object({kind:z.literal('checklist.delete'),itemId:id,expectedRevision:z.number().int().positive()}),
 z.object({kind:z.literal('fields'),fields:z.record(z.string(),z.unknown()),expectedRevision:z.number().int().positive()}),
 z.object({kind:z.literal('file.detach'),attachedId:id,expectedRevision:z.number().int().positive()}),
 z.object({kind:z.literal('result.pin'),commentId:z.uuid(),expectedRevision:z.number().int().positive()})
]);
export async function queueBitrixOperation(user:User,taskId:string,input:z.infer<typeof contentInput>){
 return transaction(async db=>{
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  assert(task&&canSee(user,task),404,'Задача недоступна.');
  assert(input.kind==='checklist.update'||input.kind==='result.pin'?canRequest(user,task)||!!task.accomplice_ids?.includes(user.id):canEdit(user,task),403,'Недостаточно прав для изменения.');
  const kind=input.kind.startsWith('checklist.')?'checklist':input.kind==='file.detach'?'files':input.kind==='result.pin'?'results':'fields';
  const snapshot=(await db.query('SELECT * FROM bitrix_task_content WHERE task_id=$1 AND kind=$2',[taskId,kind])).rows[0];
  assert(snapshot&&snapshot.revision===input.expectedRevision,409,'Данные Битрикс24 изменились или ещё не загружены. Обновите карточку.');
  if(input.kind==='fields'){
   const fields=(await db.query('SELECT fields FROM bitrix_metadata WHERE id=1')).rows[0]?.fields??{};
   const allowed=new Set(['ACCOMPLICES','AUDITORS','TAGS','GROUP_ID','PARENT_ID']);
   assert(Object.keys(input.fields).length>0&&Object.keys(input.fields).length<=40,400,'Выберите поля для изменения.');
   for(const [key,value] of Object.entries(input.fields)){
    const metadata=fields[key];
    assert(allowed.has(key)||/^UF_[A-Z0-9_]+$/.test(key)&&metadata&&!metadata.READ_ONLY&&!metadata.readOnly,400,'Поле недоступно для прямого изменения: '+key);
    if(['ACCOMPLICES','AUDITORS'].includes(key))assert(Array.isArray(value)&&value.length<=100&&value.every(v=>bitrixId(v)),400,'Неверный список участников.');
    if(key==='TAGS')assert(Array.isArray(value)&&value.length<=100&&value.every(v=>typeof v==='string'&&v.length<=255),400,'Неверные теги.');
    if(['GROUP_ID','PARENT_ID'].includes(key))assert(value==='0'||bitrixId(value),400,'Неверный ID.');
   }
  }
  if(input.kind==='result.pin')assert((await db.query('SELECT 1 FROM comments WHERE id=$1 AND task_id=$2 AND withdrawn_at IS NULL',[input.commentId,taskId])).rowCount,404,'Комментарий не найден.');
  const operationId=randomUUID();
  await db.query('INSERT INTO bitrix_content_ops(id,task_id,actor_id,kind,payload,baseline) VALUES($1,$2,$3,$4,$5,$6)',[operationId,taskId,user.id,input.kind,JSON.stringify(input),JSON.stringify(snapshot.snapshot)]);
  return {queued:true,operationId};
 });
}
export async function queueBitrixUpload(user:User,taskId:string,name:string,content:Buffer){
 assert(content.length>0&&content.length<=10*1024*1024,400,'Допустим файл до 10 МБ.');
 assert(name.length>0&&name.length<=255&&!/[\x00-\x1f/\\]/.test(name),400,'Неверное имя файла.');
 assert(bitrixId(process.env.BITRIX_UPLOAD_FOLDER_ID),503,'Настройте папку Диска для загрузки файлов.');
 return transaction(async db=>{
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  assert(task&&canSee(user,task),404,'Задача недоступна.');assert(canRequest(user,task),403,'Недостаточно прав для загрузки.');
  assert((await db.query('SELECT 1 FROM bitrix_task_links WHERE task_id=$1',[taskId])).rowCount,409,'Задача ещё не связана с Битрикс24.');
  const operationId=randomUUID();
  await db.query("INSERT INTO bitrix_content_ops(id,task_id,actor_id,kind,payload,baseline) VALUES($1,$2,$3,'file.upload',$4,'{}')",[operationId,taskId,user.id,JSON.stringify({name,folderId:process.env.BITRIX_UPLOAD_FOLDER_ID})]);
  await db.query('INSERT INTO bitrix_uploads(operation_id,content) VALUES($1,$2)',[operationId,content]);
  return {queued:true,operationId};
 });
}
const lookup=(record:Record<string,unknown>,field:string)=>record[Object.keys(record).find(k=>k.replace(/_/g,'').toLowerCase()===field.replace(/_/g,'').toLowerCase())??field];
function equalField(key:string,a:unknown,b:unknown,metadata:Record<string,any>){
 const empty=(v:unknown)=>v===null||v===undefined||v==='';
 if(empty(a)||empty(b))return empty(a)&&empty(b);
 if(Array.isArray(a)&&Array.isArray(b))return isDeepStrictEqual(a.map(String).sort(),b.map(String).sort());
 const type=metadata[key]?.type;
 if(['integer','double'].includes(type))return Number.isFinite(Number(a))&&Number(a)===Number(b);
 if(type==='datetime')return Number.isFinite(Date.parse(String(a)))&&Date.parse(String(a))===Date.parse(String(b));
 if(typeof a!=='object'&&typeof b!=='object')return String(a)===String(b);
 return isDeepStrictEqual(a,b);
}
export async function processBitrixContentOperation(request:BitrixRequest){
 if(process.env.BITRIX_WRITE_ENABLED!=='true')return false;
 const op=(await pool.query(`SELECT o.*,l.external_id AS task_external_id FROM bitrix_content_ops o JOIN bitrix_task_links l USING(task_id)
  WHERE o.state IN ('pending','failed') AND (o.retry_at IS NULL OR o.retry_at<=now())
  AND l.conflict IS DISTINCT FROM 'Задача удалена в Битрикс24. Требуется решение руководителя.' ORDER BY o.created_at LIMIT 1`)).rows[0];
 if(!op)return false;
 let nonIdempotent=false;
 const conflict=async()=>{await pool.query("UPDATE bitrix_content_ops SET state='conflict',last_error='Данные изменились в Битрикс24. Обновите карточку перед повторным действием.' WHERE id=$1",[op.id]);};
 try{
  const externalId=String(op.task_external_id),p=op.payload;
  const task=await getRemote(request,externalId);
  if(op.kind==='fields'){
   const current=await rawTask(externalId);
   const metadata=(await pool.query('SELECT fields FROM bitrix_metadata WHERE id=1')).rows[0]?.fields??{};
   for(const [key,value] of Object.entries(p.fields))if(!equalField(key,lookup(current,key),lookup(op.baseline,key),metadata)&&!equalField(key,lookup(current,key),value,metadata)){await conflict();return true;}
   await request('tasks.task.update',{taskId:externalId,fields:p.fields});
   await getRemote(request,externalId);const verified=await rawTask(externalId);
   if(Object.entries(p.fields).some(([key,value])=>!equalField(key,lookup(verified,key),value,metadata)))throw new BitrixError('Поля не подтверждены контрольным чтением.');
   await saveBitrixContent(op.task_id,'fields',verified);
  }else if(op.kind.startsWith('checklist.')){
   let list=await request<Record<string,unknown>[]>('task.checklistitem.getlist',{TASKID:externalId,ORDER:{SORT_INDEX:'asc'}});
   if(!Array.isArray(list))throw new BitrixError('Нет чек-листа в ответе.');
   if(op.kind!=='checklist.add'){
    const current=list.find(row=>String(row.ID)===p.itemId),before=(op.baseline as Record<string,unknown>[]).find(row=>String(row.ID)===p.itemId);
    if(!isDeepStrictEqual(current,before)){
     const alreadyApplied=op.kind==='checklist.delete'?!current:current&&Object.entries(p.fields).every(([key,value])=>String(current[key])===String(value));
     if(!alreadyApplied){await conflict();return true;}
    }
   }
   if(op.kind==='checklist.add'){
    if(!op.external_id){
     await pool.query("UPDATE bitrix_content_ops SET state='sending',attempts=attempts+1 WHERE id=$1",[op.id]);nonIdempotent=true;
     const added=await request<unknown>('task.checklistitem.add',{TASKID:externalId,FIELDS:p.fields});
     const id=bitrixId(added);if(!id)throw new BitrixError('Нет ID нового пункта.');
     await pool.query("UPDATE bitrix_content_ops SET external_id=$2,state='failed' WHERE id=$1",[op.id,id]);op.external_id=id;nonIdempotent=false;
    }
   }else if(op.kind==='checklist.update')await request('task.checklistitem.update',{TASKID:externalId,ITEMID:p.itemId,FIELDS:p.fields});
   else if(list.some(row=>String(row.ID)===p.itemId))await request('task.checklistitem.delete',{TASKID:externalId,ITEMID:p.itemId});
   list=await request<typeof list>('task.checklistitem.getlist',{TASKID:externalId,ORDER:{SORT_INDEX:'asc'}});
   if(!Array.isArray(list))throw new BitrixError('Нет контрольного чтения чек-листа.');
   const item=list.find(row=>String(row.ID)===String(op.external_id??p.itemId));
   if(op.kind==='checklist.delete'?!!item:!item||Object.entries(p.fields).some(([key,value])=>String(item[key])!==String(value)))throw new BitrixError('Пункт чек-листа не подтверждён чтением.');
   await saveBitrixContent(op.task_id,'checklist',list);
  }else if(op.kind==='result.pin'){
   const comment=(await pool.query('SELECT * FROM bitrix_comment_links WHERE comment_id=$1 AND task_id=$2',[p.commentId,op.task_id])).rows[0];
   if(!comment)throw new BitrixError('Результат ожидает отправки комментария.');
   const prior=await listBitrixResults(request,externalId,comment.transport==='chat');
   const exists=prior.some((r:any)=>String(r.commentId??r.messageId)===String(comment.external_id));
   if(!exists&&comment.transport==='chat')await request('tasks.task.result.addfromchatmessage',{fields:{messageId:Number(comment.external_id)}},{version:3,operationKey:op.id});
   else if(!exists)await request('tasks.task.result.addFromComment',{commentId:String(comment.external_id)});
   const results=await listBitrixResults(request,externalId,comment.transport==='chat');
   if(!Array.isArray(results)||!results.some((r:any)=>String(r.commentId??r.messageId)===String(comment.external_id)))throw new BitrixError('Результат не подтверждён чтением.');
   await saveBitrixContent(op.task_id,'results',results);
  }else if(op.kind==='file.upload'||op.kind==='file.detach'){
   if(op.kind==='file.upload'&&!op.external_id){
    const bytes=(await pool.query('SELECT content FROM bitrix_uploads WHERE operation_id=$1',[op.id])).rows[0]?.content as Buffer|undefined;
    if(!bytes)throw new BitrixError('Нет содержимого загружаемого файла.');
    await pool.query("UPDATE bitrix_content_ops SET state='sending',attempts=attempts+1 WHERE id=$1",[op.id]);nonIdempotent=true;
    const added=await request<{ID:unknown}>('disk.folder.uploadfile',{id:p.folderId,data:{NAME:p.name},fileContent:[p.name,bytes.toString('base64')],generateUniqueName:true});
    const id=bitrixId(added.ID);if(!id)throw new BitrixError('Нет ID загруженного файла.');
    await pool.query("UPDATE bitrix_content_ops SET external_id=$2,state='failed' WHERE id=$1",[op.id,id]);op.external_id=id;nonIdempotent=false;
   }
   const raw=await rawTask(externalId),current=raw.ufTaskWebdavFiles??[];
   if(!Array.isArray(current))throw new BitrixError('Неверный список вложений.');
   const previous=await refreshBitrixFiles(request,op.task_id,externalId);
   let attachments=current.map(String);
   if(op.kind==='file.upload'){
    if(!previous.some((file:{fileId:string;attachedId:string})=>file.fileId===String(op.external_id)))attachments.push('n'+String(op.external_id));
   }else attachments=attachments.filter(id=>id!==p.attachedId);
   await request('tasks.task.update',{taskId:externalId,fields:{UF_TASK_WEBDAV_FILES:attachments}});
   await getRemote(request,externalId);const verified=await refreshBitrixFiles(request,op.task_id,externalId);
   if(op.kind==='file.upload'?!verified.some((file:{fileId:string;attachedId:string})=>file.fileId===String(op.external_id)):verified.some((file:{fileId:string;attachedId:string})=>file.attachedId===p.attachedId))throw new BitrixError('Вложение не подтверждено чтением.');
   await pool.query('DELETE FROM bitrix_uploads WHERE operation_id=$1',[op.id]);
  }
  await pool.query("UPDATE bitrix_content_ops SET state='sent',last_error=NULL,retry_at=NULL WHERE id=$1",[op.id]);
 }catch(e){await pool.query("UPDATE bitrix_content_ops SET state=$2,attempts=attempts+1,last_error=$3,retry_at=now()+least(3600,30*power(2,least(attempts,7)))*interval '1 second' WHERE id=$1",[op.id,nonIdempotent?'uncertain':'failed',e instanceof BitrixError?e.message:'Ошибка изменения данных задачи.']);}
 return true;
}
