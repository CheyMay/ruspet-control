import {createHash,randomUUID} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {assert,AppError} from './domain.js';
import {bitrixId} from './bitrix-sync.js';
import {fieldValue} from './bitrix-fields.js';
import {BitrixError,reservePortalRequest,type BitrixRequest,type BitrixMeta} from './bitrix-rest.js';
import {archiveCall,initialResources,taskParts} from './bitrix-archive-plan.js';
import {archiveFile} from './bitrix-file-archive.js';
export const canonicalResource=(resource:string)=>['task','task_detail'].includes(resource)?'tasks':resource==='user_one'?'users':resource==='project_one'?'projects':resource.startsWith('smart_one:')?resource.replace('smart_one:','smart:'):resource.replace(/_one$/,'');
import type {User} from '../shared/types.js';
export const requireArchiveAdmin=(actor:User)=>assert(actor.role==='admin',403,'Импорт и архив интеграции доступны администратору.');
type Job={id:string;run_id:string;resource:string;external_id:string;cursor:Record<string,any>;attempts:number};
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function enqueue(db:Db,run:string,resource:string,id='0',cursor:object={},refresh=false){
 await db.query("INSERT INTO bitrix_archive_jobs(run_id,resource,external_id,cursor) VALUES($1,$2,$3,$4) ON CONFLICT(run_id,resource,external_id) DO UPDATE SET state='pending',cursor=excluded.cursor,error=NULL,retry_at=NULL WHERE $5::boolean AND bitrix_archive_jobs.state IN ('done','blocked')",[run,resource,id,JSON.stringify(cursor),refresh]);
}
export async function startInitialArchive(actor:User,portal:string,files=true){
 requireArchiveAdmin(actor);assert(portal===process.env.BITRIX_PORTAL,409,'Портал должен совпадать с настройкой интеграции.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431040)');
  assert(!(await db.query("SELECT 1 FROM bitrix_archive_runs WHERE portal=$1 AND state IN ('running','paused')",[portal])).rowCount,409,'Первоначальная загрузка уже создана. Продолжите её.');
  const capture=(await db.query('SELECT * FROM bitrix_event_capture WHERE id=1')).rows[0],id=randomUUID();
  await db.query('INSERT INTO bitrix_archive_runs(id,portal,scope,capture_started_at) VALUES($1,$2,$3,$4)',[id,portal,JSON.stringify({resources:initialResources,files:files?'binary':'metadata',scope:'all_accessible',includesClosed:true}),capture.enabled&&capture.verified_at&&capture.portal===portal?capture.started_at:null]);
  for(const resource of initialResources)await enqueue(db,id,resource);
  return {id,eventsCaptured:!!(capture.enabled&&capture.verified_at&&capture.portal===portal)};
 });
}
export async function archiveStatus(actor:User,id?:string){
 requireArchiveAdmin(actor);
 const run=(await pool.query('SELECT * FROM bitrix_archive_runs WHERE ($1::uuid IS NULL OR id=$1) ORDER BY created_at DESC LIMIT 1',[id||null])).rows[0];
 if(!run)return {run:null,sections:[],issues:[]};
 const sections=(await pool.query('SELECT resource,state,count(*)::int count FROM bitrix_archive_jobs WHERE run_id=$1 GROUP BY resource,state ORDER BY resource,state',[run.id])).rows;
 const issues=(await pool.query("SELECT id,resource,external_id,state,error FROM bitrix_archive_jobs WHERE run_id=$1 AND state IN ('blocked','failed') ORDER BY id LIMIT 100",[run.id])).rows;
 issues.push(...(await pool.query("SELECT 'event:'||resource||':'||external_id id,resource,external_id,state,error FROM bitrix_refresh_queue WHERE portal=$1 AND state IN ('blocked','failed') ORDER BY updated_at LIMIT 100",[run.portal])).rows);
 const objects=(await pool.query('SELECT resource,count(*)::int count FROM bitrix_archive_objects WHERE portal=$1 AND run_id=$2 GROUP BY resource',[run.portal,run.id])).rows;
 const pending=(await pool.query("SELECT count(*)::int count FROM bitrix_refresh_queue WHERE portal=$1 AND (generation>done_generation OR state<>'done')",[run.portal])).rows[0].count;
 const capture=(await pool.query('SELECT enabled,mode,verified_at,coverage FROM bitrix_event_capture WHERE id=1')).rows[0];
 return {run,sections,issues,objects,pending,capture,complete:run.state==='ready',limitations:[...(capture?.mode==='online'?['Онлайн-события не повторяются при сбое. Для надёжного перехода нужна подтверждаемая офлайн-очередь.']:[]),'Объём ограничен правами учётной записи Битрикс24.','Изменение и удаление сообщений новой карточки задач требуют отдельной сверки.','Архив сохраняет источник; рабочая проекция включается отдельно после сопоставления людей и полей.']};
}
export async function resumeArchive(actor:User,id:string){requireArchiveAdmin(actor);const run=(await pool.query('SELECT portal FROM bitrix_archive_runs WHERE id=$1',[id])).rows[0];assert(run,404,'Загрузка не найдена.');await pool.query("UPDATE bitrix_refresh_queue SET state='pending',retry_at=NULL,error=NULL WHERE portal=$1 AND state IN ('blocked','failed')",[run.portal]);await pool.query("UPDATE bitrix_archive_jobs SET state='pending',retry_at=NULL,error=NULL WHERE run_id=$1 AND state IN ('failed','blocked')",[id]);await pool.query("UPDATE bitrix_archive_runs SET state='running' WHERE id=$1 AND state<>'ready'",[id]);}
export async function pauseArchive(actor:User,id:string){requireArchiveAdmin(actor);await pool.query("UPDATE bitrix_archive_runs SET state='paused' WHERE id=$1 AND state='running'",[id]);}
async function save(db:Db,run:any,resource:string,id:string,raw:unknown,parent='0'){
 await db.query(`INSERT INTO bitrix_archive_objects(portal,resource,external_id,parent_id,raw,run_id) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(portal,resource,external_id,parent_id) DO UPDATE SET raw=excluded.raw,run_id=excluded.run_id,fetched_at=clock_timestamp(),deleted_at=NULL`,[run.portal,resource,id,parent,JSON.stringify(raw),run.id]);
}
async function embeddedFiles(db:Db,run:any,resource:string,owner:string,raw:unknown,path='',depth=0):Promise<void>{
 if(['file','attached_file'].includes(resource)||!raw||typeof raw!=='object'||depth>10)return;
 const value=raw as Record<string,any>,url=value.DOWNLOAD_URL||value.downloadUrl||value.urlDownload;
 if(typeof url==='string'){
  const id='embedded:'+fingerprint({resource,owner,path}),metadata={...value,DOWNLOAD_URL:url,SIZE:value.SIZE??value.size};
  await save(db,run,'file',id,metadata);
  if(run.scope.files==='binary')await enqueue(db,run.id,'file_blob',id);
  return;
 }
 for(const [key,child] of Object.entries(value))await embeddedFiles(db,run,resource,owner,child,path+'/'+key,depth+1);
}
async function related(db:Db,run:any,resource:string,id:string,raw:Record<string,any>,refresh=false){
 const extra=refresh?{refreshRequested:true}:{};
 if(resource==='tasks'){await enqueue(db,run.id,'task_detail',id);return;}
 if(resource==='task'){
  for(const part of taskParts){
   if(part==='task_comments'&&process.env.BITRIX_LEGACY_COMMENTS==='true')await enqueue(db,run.id,'task_legacy_comments',id,extra,refresh);
   else await enqueue(db,run.id,part,id,part==='task_comments'?{...extra,chatId:bitrixId(fieldValue(raw,'CHAT_ID'))}:extra,refresh);
  }
  const attachments=fieldValue(raw,'UF_TASK_WEBDAV_FILES');
  if(Array.isArray(attachments))for(const attachment of attachments){const attached=bitrixId(attachment);if(attached)await enqueue(db,run.id,'attached_file',attached,extra,refresh);else await enqueue(db,run.id,'unresolved_file',fingerprint(attachment));}
 }
 if(['company','contact','deal','lead'].includes(resource)){
  await enqueue(db,run.id,resource+'_timeline',id,extra,refresh);await enqueue(db,run.id,resource+'_activities',id,extra,refresh);
  if(['company','deal','lead'].includes(resource))await enqueue(db,run.id,resource+'_contacts',id,extra,refresh);
  if(['deal','lead'].includes(resource))await enqueue(db,run.id,resource+'_products',id,extra,refresh);
 }
 if(resource==='projects')await enqueue(db,run.id,'project_members',id,extra,refresh);
 if(resource==='crm_types'){
  const entityType=bitrixId(raw.entityTypeId);assert(entityType,502,'Смарт-процесс не содержит тип сущности.');
  await enqueue(db,run.id,'smart_fields:'+entityType);await enqueue(db,run.id,'smart:'+entityType);
 }
 if(resource==='attached_file'){const file=bitrixId(raw.OBJECT_ID);assert(file,502,'В прикреплённом файле нет OBJECT_ID.');await enqueue(db,run.id,'file',file,extra,refresh);}
 if(resource==='file'&&run.scope.files==='binary')await enqueue(db,run.id,'file_blob',id,extra,refresh);
}
export async function runArchiveJob(request:BitrixRequest,run:any,job:Job){
 if(job.resource==='unresolved_file')throw new AppError(409,'Привязка файла требует отдельного адаптера. Раздел не считается полностью загруженным.');
 if(job.resource==='file_blob'){
  let raw=(await pool.query("SELECT raw FROM bitrix_archive_objects WHERE portal=$1 AND resource='file' AND external_id=$2",[run.portal,job.external_id])).rows[0]?.raw;
  if(bitrixId(job.external_id)){
   raw=await request('disk.file.get',{id:job.external_id});
   assert(raw&&String(raw.ID)===job.external_id,502,'Источник вернул другой файл.');
   await transaction(db=>save(db,run,'file',job.external_id,raw));
  }
  assert(raw,409,'Метаданные файла ещё не загружены.');const blob=await archiveFile(run.portal,raw,{beforeFetch:()=>reservePortalRequest(run.portal),onThrottle:async()=>{await pool.query("UPDATE bitrix_rest_gate SET next_at=now()+interval '1 minute' WHERE id=1");}});
  await transaction(async db=>{await db.query('INSERT INTO bitrix_archive_blobs(portal,external_id,sha256,path,bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT(portal,external_id) DO UPDATE SET sha256=excluded.sha256,path=excluded.path,bytes=excluded.bytes,fetched_at=now()',[run.portal,job.external_id,blob.sha256,blob.path,blob.bytes]);await db.query("UPDATE bitrix_archive_jobs SET state='done',error=NULL,updated_at=now() WHERE id=$1",[job.id]);});return;
 }
 const fieldResource=['tasks','task','task_detail'].includes(job.resource)?'task_fields':job.resource+'_fields';
 const catalog=(await pool.query('SELECT raw FROM bitrix_archive_objects WHERE portal=$1 AND resource=$2 AND external_id=\'catalog\'',[run.portal,fieldResource])).rows[0]?.raw;
 const selection=Object.keys(catalog?.fields||catalog||{}).filter(k=>/^[A-Z][A-Z0-9_]*$/.test(k));
 const call=archiveCall(job.resource,job.external_id,job.cursor,selection);let metadata:BitrixMeta={};
 const response=await request<any>(call.method,call.params,value=>{metadata=value;});
 const data=call.path?response?.[call.path]:response;
 const rows=['all','fields'].includes(call.mode)?null:data;
 if(rows!==null)assert(Array.isArray(rows),502,'Список загрузки не соответствует документированному формату.');
 let cursor={...job.cursor},done=rows===null;
 if(rows!==null){
  assert(rows.every((r:any)=>r&&typeof r==='object'&&!Array.isArray(r)),502,'В списке загрузки неверный объект.');
  if(call.mode==='keyset'){
   let previous=String(cursor.after||'0');for(const row of rows){const id=bitrixId(row[call.idKey!]);assert(id&&BigInt(id)>BigInt(previous),502,'Порядок страницы нарушен. Курсор сохранён без изменений.');previous=id;}
   cursor.after=previous;done=rows.length<50;
  }else if(call.mode==='messages'){
   const ids=rows.map((r:any)=>bitrixId(r.id));assert(ids.every(Boolean),502,'У сообщения нет ID.');
   const oldest=ids.reduce((min:string|null,id:string|null)=>!min||BigInt(id!)<BigInt(min)?id:min,null);
   if(rows.length)assert(!cursor.before||BigInt(oldest!)<BigInt(cursor.before),502,'Курсор истории чата не продвигается.');
   if(cursor.forward){const newest=ids.reduce((max:string,id:string|null)=>BigInt(id!)>BigInt(max)?id!:max,String(cursor.afterMessage||'0'));if(rows.length)assert(BigInt(newest)>BigInt(cursor.afterMessage||'0'),502,'Курсор новых сообщений не продвигается.');cursor.afterMessage=newest;}
   else cursor.before=oldest;
   done=rows.length===0; // IM may return more than LIMIT for unread messages.
  }else{
   const next=metadata.next;if(next!==undefined)assert(Number.isSafeInteger(next)&&next>Number(cursor.start||0),502,'Неверная следующая страница.');
   const pageHash=fingerprint(rows);assert(!rows.length||cursor.pageHash!==pageHash,502,'Сервер повторяет страницу; загрузка остановлена без пропусков.');cursor.pageHash=pageHash;
   cursor.start=next??Number(cursor.start||0)+50;done=next===undefined&&rows.length<50;
  }
 }
 await transaction(async db=>{
  const current=(await db.query('SELECT state FROM bitrix_archive_runs WHERE id=$1 FOR UPDATE',[run.id])).rows[0];assert(current,404,'Загрузка не найдена.');
  if(rows===null){
   if(job.resource==='task_fields'&&data?.fields)for(const [code,description] of Object.entries(data.fields))if(/^[A-Z][A-Z0-9_]*$/.test(code))await db.query('INSERT INTO bitrix_field_catalog(code,description) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET description=excluded.description,fetched_at=now()',[code,JSON.stringify(description)]);
   assert(data!==undefined&&data!==null,502,'Пустой ответ загрузки.');
   const canonical=canonicalResource(job.resource);
   await save(db,run,canonical,call.mode==='fields'?'catalog':job.external_id,['user_one','project_one'].includes(job.resource)&&Array.isArray(data)?data[0]:data);
   if(['user_one','project_one'].includes(job.resource))assert(Array.isArray(data)&&data.length===1&&String(data[0].ID)===job.external_id,502,'Нет запрошенного объекта.');
   if(['task','task_detail'].includes(job.resource))assert(String(data.id)===job.external_id,502,'Получена другая задача.');
   if(data&&typeof data==='object'&&!Array.isArray(data))await related(db,run,['task','task_detail'].includes(job.resource)?'task':canonical,job.external_id,data,!!(job.cursor.refreshGeneration||job.cursor.refreshRequested));
   if(run.scope.files==='binary'){
    await embeddedFiles(db,run,canonical,job.external_id,data);
    if(job.resource==='task_results'&&Array.isArray(data))for(const result of data)for(const file of result.files||[]){const info=result.fileInfo?.[String(file)];if(!info||!(info.DOWNLOAD_URL||info.downloadUrl||info.urlDownload))await enqueue(db,run.id,'unresolved_file',fingerprint({source:'result',task:job.external_id,result:result.id,file}));}
   }
  }else{
   for(const row of rows){
    const id=call.idKey?bitrixId(row[call.idKey]):fingerprint(row);assert(id,502,'Нет ID загружаемого объекта.');
    await save(db,run,job.resource,id,row,job.external_id);if(job.resource==='tasks')await save(db,run,'task_list',id,row);await related(db,run,job.resource,id,row);
    if(run.scope.files==='binary')await embeddedFiles(db,run,job.resource,id,row);
    if(run.scope.files==='binary')for(const [code,description] of Object.entries(catalog?.fields||catalog||{})){
     const type=(description as any)?.type||(description as any)?.USER_TYPE_ID,value=fieldValue(row,code);
     if(type==='file'&&code!=='UF_TASK_WEBDAV_FILES'&&value!==null&&value!==undefined&&value!==''&&(!Array.isArray(value)||value.length)){
      const values=Array.isArray(value)?value:[value];
      if(values.some(v=>!v||typeof v!=='object'||!((v as any).DOWNLOAD_URL||(v as any).downloadUrl)))await enqueue(db,run.id,'unresolved_file',fingerprint({resource:job.resource,id,code}),{source:job.resource,owner:id,field:code});
     }
    }
   }
   // Preserve auxiliary users and file metadata from IM responses too.
   if(call.mode==='messages'){
    await save(db,run,'chat_page',job.external_id+':'+String(job.cursor.before||'latest'),response,job.external_id);
    const files=response.files,rows=Array.isArray(files)?files:files&&typeof files==='object'?Object.values(files):[];
    if(run.scope.files==='binary')await embeddedFiles(db,run,'chat_page',job.external_id+':'+String(job.cursor.before||'latest'),response);
    for(const file of rows){
     const id=bitrixId((file as any).viewerAttrs?.objectId);
     if(id)await enqueue(db,run.id,'file',id);
     else if(run.scope.files==='binary'&&!((file as any).urlDownload||(file as any).DOWNLOAD_URL||(file as any).downloadUrl))await enqueue(db,run.id,'unresolved_file',fingerprint({source:'chat',task:job.external_id,file}));
    }
   }
  }
  await db.query('UPDATE bitrix_archive_jobs SET cursor=$2,state=$3,error=NULL,retry_at=NULL,updated_at=now() WHERE id=$1',[job.id,JSON.stringify(cursor),done?'done':'pending']);
 });
}
export async function tickInitialArchive(request:BitrixRequest,id:string,maxRequests=1){
 assert(Number.isSafeInteger(maxRequests)&&maxRequests>=1&&maxRequests<=100,400,'Один шаг загрузки: 1–100 запросов.');
 const lock=await pool.connect();let acquired=false;
 try{
  acquired=(await lock.query('SELECT pg_try_advisory_lock(431041) ok')).rows[0].ok;if(!acquired)return {processed:0,busy:true};
  const run=(await pool.query('SELECT * FROM bitrix_archive_runs WHERE id=$1',[id])).rows[0];assert(run,404,'Загрузка не найдена.');
  assert(!request.portal||request.portal===run.portal,409,'Клиент настроен на другой портал.');
  if(run.state==='paused')return {processed:0,state:run.state};
  await pool.query("UPDATE bitrix_archive_jobs SET state='pending' WHERE run_id=$1 AND state='running'",[id]);
  let processed=0;
  for(;processed<maxRequests;processed++){
   // Interactive writes have priority over bulk reads.
   if((await pool.query("SELECT 1 FROM bitrix_operations CROSS JOIN bitrix_live_config c WHERE c.id=1 AND c.enabled AND state IN ('pending','processing','failed') AND (retry_at IS NULL OR retry_at<=now()) LIMIT 1")).rowCount)break;
   const job=(await pool.query("SELECT * FROM bitrix_archive_jobs WHERE run_id=$1 AND state IN ('pending','failed') AND (retry_at IS NULL OR retry_at<=now()) ORDER BY id LIMIT 1",[id])).rows[0] as Job|undefined;
   if(!job)break;
   await pool.query("UPDATE bitrix_archive_jobs SET state='running',attempts=attempts+1,updated_at=now() WHERE id=$1",[job.id]);
   try{await runArchiveJob(request,run,job);}catch(error){
    const transient=error instanceof BitrixError&&(!error.code||['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT','OVERLOAD_LIMIT'].includes(error.code));
    const retry=error instanceof BitrixError&&error.retryAt||new Date(Date.now()+Math.min(3600,60*2**Math.min(job.attempts,5))*1000).toISOString();
    const message=error instanceof BitrixError||error instanceof AppError?error.message:'Не удалось загрузить раздел. Проверьте формат, права и доступность источника.';
    await pool.query('UPDATE bitrix_archive_jobs SET state=$2,error=$3,retry_at=$4,updated_at=now() WHERE id=$1',[job.id,transient?'failed':'blocked',message,retry]);
    if(transient)break;
   }
  }
  if(!(await pool.query("SELECT 1 FROM bitrix_archive_jobs WHERE run_id=$1 AND state IN ('pending','running','failed') LIMIT 1",[id])).rowCount)await pool.query("UPDATE bitrix_archive_runs SET state='captured' WHERE id=$1 AND state='running'",[id]);
  return {processed,state:(await pool.query('SELECT state FROM bitrix_archive_runs WHERE id=$1',[id])).rows[0].state};
 }finally{if(acquired)await lock.query('SELECT pg_advisory_unlock(431041)');lock.release();}
}
