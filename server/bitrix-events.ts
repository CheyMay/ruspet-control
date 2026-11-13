import {createHash,timingSafeEqual} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {pool,transaction,type Db} from './db.js';
import {assert} from './domain.js';
import {bitrixId} from './bitrix-sync.js';
import type {BitrixRequest} from './bitrix-rest.js';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const requiredEvents=['ONTASKADD','ONTASKUPDATE','ONTASKDELETE','ONTASKCOMMENTADD',
 ...['COMPANY','CONTACT','DEAL','LEAD'].flatMap(entity=>['ADD','UPDATE','DELETE'].map(action=>'ONCRM'+entity+action)),
 'ONCRMDYNAMICITEMADD','ONCRMDYNAMICITEMUPDATE','ONCRMDYNAMICITEMDELETE','ONUSERADD','ONSONETGROUPADD','ONSONETGROUPUPDATE','ONSONETGROUPDELETE'];
export function eventTargets(event:string,data:any):{resource:string;id:string}[]{
 const after=data?.FIELDS_AFTER,before=data?.FIELDS_BEFORE,fields=data?.FIELDS;
 if(['ONTASKADD','ONTASKUPDATE','ONTASKDELETE'].includes(event)){
  const id=bitrixId(after?.ID)||bitrixId(before?.ID);assert(id,400,'В событии нет ID задачи.');
  return [{resource:'task',id},{resource:'task_history',id},{resource:'task_results',id},{resource:'task_checklist',id},{resource:'task_time',id}];
 }
 if(event==='ONTASKCOMMENTADD'){
  const id=bitrixId(after?.TASK_ID)||bitrixId(before?.TASK_ID);assert(id,400,'В событии нет TASK_ID.');
  return [{resource:'task',id},{resource:'task_comments',id}];
 }
 const crm=event.match(/^ONCRM(COMPANY|CONTACT|DEAL|LEAD)(ADD|UPDATE|DELETE)$/);
 if(crm){const id=bitrixId(fields?.ID);assert(id,400,'В событии нет ID объекта CRM.');return [{resource:crm[1].toLowerCase()+'_one',id}];}
 if(/^ONCRMDYNAMICITEM(ADD|UPDATE|DELETE)$/.test(event)){
  const id=bitrixId(fields?.ID),type=bitrixId(fields?.ENTITY_TYPE_ID);assert(id&&type,400,'В событии нет ID/типа смарт-процесса.');return [{resource:'smart_one:'+type,id}];
 }
 if(event==='ONUSERADD'){const id=bitrixId(data?.ID);assert(id,400,'В событии нет ID пользователя.');return [{resource:'user_one',id}];}
 if(/^ONSONETGROUP(ADD|UPDATE|DELETE)$/.test(event)){const id=bitrixId(data?.ID)||bitrixId(fields?.ID);assert(id,400,'В событии нет ID проекта.');return [{resource:'project_one',id}];}
 assert(false,400,'Это событие не поддерживается приёмником.');
}
export async function queueRefresh(db:Db,portal:string,resource:string,id:string,deleted=false){
 await db.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id,delete_hint) VALUES($1,$2,$3,$4)
 ON CONFLICT(portal,resource,external_id) DO UPDATE SET generation=bitrix_refresh_queue.generation+1,delete_hint=excluded.delete_hint,state='pending',retry_at=NULL,error=NULL,updated_at=clock_timestamp()`,[portal,resource,id,deleted]);
}
async function saveEvent(db:Db,portal:string,event:string,data:unknown,key:string,when:string|null){
 const targets=eventTargets(event,data);
 const inserted=(await db.query('INSERT INTO bitrix_event_inbox(portal,dedupe_key,event,data,occurred_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[portal,key,event,JSON.stringify(data),when])).rowCount;
 if(inserted)for(const target of targets)await queueRefresh(db,portal,target.resource,target.id,event.endsWith('DELETE'));
 return !!inserted;
}
export async function receiveBitrixEvent(input:any){
 const inbound=process.env.BITRIX_INBOUND_TASKS==='true';
 const cfg=(await pool.query('SELECT * FROM bitrix_event_capture WHERE id=1')).rows[0];
 assert(cfg.enabled&&cfg.portal&&(cfg.member_id||inbound&&cfg.mode==='online'),503,'Приём событий ещё не включён.');
 const file=process.env.BITRIX_EVENT_TOKEN_FILE;assert(file,503,'Не задан закрытый файл токена событий.');
 const token=await readEventToken(file),supplied=input?.auth?.application_token;
 assert(token.length>=16&&typeof supplied==='string'&&timingSafeEqual(createHash('sha256').update(token).digest(),createHash('sha256').update(supplied).digest()),403,'Неверная подпись источника событий.');
 const memberId=input.auth.member_id;
 assert(input.auth.domain===cfg.portal&&typeof memberId==='string'&&(!inbound||/^[a-f0-9]{32}$/i.test(memberId))&&(!cfg.member_id||memberId===cfg.member_id),403,'Событие другого портала отклонено.');
 assert(typeof input.event==='string'&&requiredEvents.includes(input.event),400,'Неподдерживаемое событие.');
 assert(/^[0-9]{9,12}$/.test(String(input.ts)),400,'У события нет корректного времени.');
 // Never persist auth/access/refresh/application tokens from the request.
 const key=digest({event:input.event,data:input.data,ts:input.ts,handler:input.event_handler_id});
 const when=new Date(Number(input.ts)*1000).toISOString();
 if(!inbound)return transaction(async db=>({accepted:await saveEvent(db,cfg.portal,input.event,input.data,key,when)}));
 assert(taskWebhookEvents.includes(input.event),400,'Исходящий вебхук настроен на события задач.');
 const {id}=eventTargets(input.event,input.data)[0];
 return transaction(async db=>{
  const pinned=await db.query(`UPDATE bitrix_event_capture SET member_id=$2,verified_at=coalesce(verified_at,now())
   WHERE id=1 AND enabled AND mode='online' AND portal=$1 AND (member_id IS NULL OR member_id=$2)`,[cfg.portal,memberId]);
  assert(pinned.rowCount,403,'Событие другого портала отклонено.');
  const known=await db.query(`SELECT 1 FROM tasks WHERE id=$1 AND source_fields->>'ID'=id
   UNION ALL SELECT 1 FROM bitrix_task_links WHERE external_id=$1::bigint AND NOT live_enabled`,[id]);
  if(!known.rowCount)return {accepted:false,ignored:true};
  const inserted=await db.query(`INSERT INTO bitrix_event_inbox(portal,dedupe_key,event,data,occurred_at)
   VALUES($1,$2,$3,jsonb_build_object('taskId',$4::text),$5) ON CONFLICT DO NOTHING`,[cfg.portal,key,input.event,id,when]);
  if(inserted.rowCount){
   await queueRefresh(db,cfg.portal,'task_inbound',id,input.event==='ONTASKDELETE');
   if(input.event==='ONTASKCOMMENTADD')await queueRefresh(db,cfg.portal,'task_inbound_comments',id);
  }
  return {accepted:!!inserted.rowCount};
 });
}
export const taskWebhookEvents=['ONTASKADD','ONTASKUPDATE','ONTASKDELETE','ONTASKCOMMENTADD'];
export async function readEventToken(file:string){
 const info=await stat(file).catch(()=>null);
 assert(info?.isFile()&&(info.mode&0o077)===0,503,'Файл токена событий должен быть доступен службе с правами 0600.');
 const token=(await readFile(file,'utf8')).trim();
 assert(token.length>=16,503,'Не настроен токен исходящего вебхука.');
 return token;
}
export async function bindArchiveEvents(request:BitrixRequest,mode:'offline'|'online',handler?:string){
 assert(request.mode==='application'&&request.portal&&request.memberId,409,'Для event.bind нужна авторизация отдельного приложения OAuth. Входящий вебхук не подходит.');
 if(mode==='offline'){
  const feature=await request<string>('feature.get',{code:'rest_offline_extended'});
  assert(feature==='Y'||/^[a-z]+_selfhosted$/.test(String(feature)),409,'Безопасное получение событий с подтверждением недоступно на этом тарифе.');
 }else{const url=new URL(handler!);assert(url.protocol==='https:'&&url.origin===process.env.PUBLIC_ORIGIN&&!url.search&&!url.username&&!url.password,400,'Обработчик должен быть на публичном HTTPS-адресе нашего сервиса.');}
 await pool.query("UPDATE bitrix_event_capture SET portal=$1,member_id=$2,enabled=true,mode=$3,verified_at=NULL,started_at=coalesce(started_at,now()) WHERE id=1",[request.portal,request.memberId,mode]);
 const bound=await request<any[]>('event.get',{});assert(Array.isArray(bound),502,'Нет списка подписок приложения.');
 for(const event of requiredEvents){
  if(bound.some(item=>String(item.event).toUpperCase()===event&&(mode==='offline'?String(item.offline)==='1':item.handler===handler)))continue;
  await request('event.bind',{event,event_type:mode,...(mode==='online'?{handler}:{})});
 }
 const verified=await request<any[]>('event.get',{});
 assert(Array.isArray(verified)&&requiredEvents.every(event=>verified.some(item=>String(item.event).toUpperCase()===event&&(mode==='offline'?String(item.offline)==='1':item.handler===handler))),409,'Подписки не подтверждены. Первоначальная загрузка не считается готовой.');
 await pool.query('UPDATE bitrix_event_capture SET verified_at=now(),coverage=$1 WHERE id=1',[JSON.stringify(requiredEvents)]);return {mode,events:requiredEvents.length};
}
export async function pullOfflineEvents(request:BitrixRequest){
 assert(request.mode==='application'&&request.portal,409,'Офлайн-события требуют OAuth приложения.');
 const lock=await pool.connect();let acquired=false;
 try{
  acquired=(await lock.query('SELECT pg_try_advisory_lock(431042) ok')).rows[0].ok;if(!acquired)return {saved:0,busy:true};
  let batch=(await pool.query("SELECT * FROM bitrix_offline_batches WHERE portal=$1 AND state='saved' ORDER BY created_at LIMIT 1",[request.portal])).rows[0];
  if(!batch){
   // Recover reservations whose response was lost before local persistence.
   const listed=await request<any[]>('event.offline.list',{order:{ID:'ASC'},start:0});assert(Array.isArray(listed),502,'Нет списка очереди событий.');
   if(!listed.length)return {saved:0};
   const reserved=listed.find(item=>typeof item.PROCESS_ID==='string'&&item.PROCESS_ID.length>0)?.PROCESS_ID;
   const response=await request<{process_id:string|null;events:any[]}>('event.offline.get',{clear:0,limit:50,...(reserved?{process_id:reserved}:{})});
   assert(Array.isArray(response.events),502,'Нет пакета событий.');if(!response.events.length)return {saved:0};
   assert(typeof response.process_id==='string'&&response.process_id.length>0,502,'События не зарезервированы: удаление запрещено.');
   const messages=response.events.map(item=>item.MESSAGE_ID);assert(messages.every(id=>typeof id==='string'&&id.length===32),502,'Неверные ключи подтверждения событий.');
   await transaction(async db=>{
    for(const item of response.events){
     const time=Date.parse(item.TIMESTAMP_X);assert(Number.isFinite(time),502,'Неверная дата офлайн-события.');
     await saveEvent(db,request.portal!,item.EVENT_NAME,item.EVENT_DATA,digest({id:item.ID,time:item.TIMESTAMP_X,event:item.EVENT_NAME,data:item.EVENT_DATA}),new Date(time).toISOString());
    }
    await db.query("INSERT INTO bitrix_offline_batches(process_id,portal,state,message_ids) VALUES($1,$2,'saved',$3) ON CONFLICT(process_id) DO UPDATE SET state='saved',message_ids=excluded.message_ids",[response.process_id,request.portal,messages]);
   });
   batch={process_id:response.process_id,message_ids:messages};
  }
  assert(batch.process_id&&batch.message_ids.length>0,409,'Пустое подтверждение запрещено: оно может очистить чужую очередь.');
  const cleared=await request('event.offline.clear',{process_id:batch.process_id,message_id:batch.message_ids});
  assert(cleared===true,502,'Битрикс24 не подтвердил очистку пакета. Локальная копия сохранена.');
  await pool.query("UPDATE bitrix_offline_batches SET state='acked' WHERE process_id=$1",[batch.process_id]);return {saved:batch.message_ids.length};
 }finally{if(acquired)await lock.query('SELECT pg_advisory_unlock(431042)');lock.release();}
}
