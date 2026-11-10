import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {pool} from './db.js';
import {applicationToken,readApplicationCredentials} from './bitrix-oauth.js';
import {createBitrixTransport,BitrixTransportError,type BitrixSendOptions} from './bitrix-transport.js';

export type BitrixMethod='tasks.task.list'|'tasks.task.get'|'tasks.task.update'|'tasks.task.history.list'|'im.dialog.messages.get'|'task.commentitem.getlist'|'tasks.task.getFields'|'user.get'|'tasks.task.complete'|'tasks.task.approve'|'tasks.task.disapprove'|'tasks.task.renew'|'tasks.task.chat.message.send'|'task.commentitem.add'|'crm.company.list'|'crm.company.get'|'crm.company.fields'|`crm.${'contact'|'deal'|'lead'}.${'list'|'get'|'fields'}`|'crm.company.contact.items.get'|'crm.timeline.comment.list'|'crm.activity.list'|'crm.status.list'|'crm.type.list'|'crm.item.list'|'crm.item.fields'|'crm.item.get'|'crm.requisite.list'|'crm.requisite.fields'|'crm.requisite.bankdetail.fields'|'crm.address.fields'|'crm.deal.contact.items.get'|'crm.lead.contact.items.get'|'crm.deal.productrows.get'|'crm.lead.productrows.get'|'sonet_group.user.get'|'crm.requisite.bankdetail.list'|'crm.address.list'|'department.get'|'sonet_group.get'|'task.checklistitem.getlist'|'task.elapseditem.getlist'|'tasks.task.result.list'|'disk.attachedObject.get'|'disk.file.get'|'event.bind'|'event.get'|'events'|'feature.get'|'user.admin'|'event.offline.get'|'event.offline.list'|'event.offline.clear';
const knownErrors=new Set(['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT','NO_AUTH_FOUND','ACCESS_DENIED','OVERLOAD_LIMIT','ERROR_TASK_NOT_FOUND','WRONG_AUTH_TYPE','WRONG_LICENSE','ERROR_METHOD_NOT_FOUND','ERROR_NOT_FOUND','NOT_FOUND','insufficient_scope','expired_token','invalid_token']);
export class BitrixError extends Error {constructor(message:string,public disposition:'rejected'|'uncertain'='rejected',public code:string|null=null,public retryAt:string|null=null){super(message);}}

export function webhookBase(secret:string,portal:string){
 const url=new URL(secret);
 if(url.protocol!=='https:'||url.hostname!==portal.toLowerCase()||url.port||url.username||url.password||url.search||url.hash||!/^\/rest\/\d+\/[a-zA-Z0-9_-]+\/$/.test(url.pathname)){
  throw new BitrixError('Некорректный адрес входящего вебхука.');
 }
 return url;
}

// Waiting for a quota-held request must not exhaust the panel's shared PG pool.
async function acquirePortalLock(){
 const until=performance.now()+350000;
 do{
  const db=await pool.connect();
  try{
   if((await db.query('SELECT pg_try_advisory_lock(431024) ok')).rows[0].ok)return db;
   db.release();
  }catch(e){db.release(true);throw e;}
  await delay(250);
 }while(performance.now()<until);
 throw new BitrixError('Локальная очередь Битрикс24 занята. Запрос не передан.');
}

/** Binary downloads and their redirects share the same portal budget as REST. */
export async function reservePortalRequest(portal:string){
 const db=await acquirePortalLock();
 try{
  const gate=(await db.query("SELECT portal,next_at,greatest(0,extract(epoch FROM next_at-clock_timestamp())*1000)::float8 wait FROM bitrix_rest_gate WHERE id=1")).rows[0];
  if(gate.portal!==portal)throw new BitrixError('Другой портал очереди загрузки файлов.');
  if(gate.wait>5000)throw new BitrixError('Загрузка файлов на паузе после ограничения REST.','rejected','QUERY_LIMIT_EXCEEDED',gate.next_at);
  if(gate.wait>0)await delay(Math.ceil(gate.wait));
  await db.query("UPDATE bitrix_rest_gate SET next_at=clock_timestamp()+interval '1100 milliseconds' WHERE id=1");
 }finally{try{await db.query('SELECT pg_advisory_unlock(431024)');db.release();}catch{db.release(true);}}
}

export type BitrixMeta={next?:number;total?:number;time?:{operating?:number;operating_reset_at?:number;duration?:number}};
export type BitrixRequest={<T>(method:BitrixMethod,params:object,observe?:(metadata:BitrixMeta)=>void,options?:BitrixSendOptions):Promise<T>;mode?:'application'|'webhook';portal?:string;memberId?:string};
export async function bitrixClient(options:{application?:boolean}={}):Promise<BitrixRequest>{
 const {BITRIX_PORTAL:portal,BITRIX_WEBHOOK_FILE:file,BITRIX_OAUTH_FILE:oauth}=process.env;
 const application=options.application||!file&&!!oauth;
 if(!portal||(application?!oauth:!file))throw new BitrixError('Укажите портал и закрытый файл вебхука или OAuth.');
 if(!/^[a-z0-9.-]+$/.test(portal!))throw new BitrixError('Некорректный домен портала.');
 const credentials=application?await readApplicationCredentials(oauth!,portal!):null;
 let base:URL;
 try{base=application?new URL(`https://${portal}/rest/`):webhookBase((await readFile(file!,'utf8')).trim(),portal!);}
 catch{throw new BitrixError('Не удалось прочитать настройки вебхука. Проверьте домен и файл.');}
 let transport:Awaited<ReturnType<typeof createBitrixTransport>>;
 try{transport=await createBitrixTransport(base.origin);}catch(e){throw new BitrixError(e instanceof BitrixTransportError?e.message:'Не удалось настроить транспорт Битрикс24.');}
 const request:BitrixRequest=async<T>(method:BitrixMethod,params:object,observe?:(metadata:BitrixMeta)=>void,options?:BitrixSendOptions):Promise<T>=>{
  const db=await acquirePortalLock();
  try{
   const pinned=(await db.query('UPDATE bitrix_rest_gate SET portal=$1 WHERE id=1 AND (portal IS NULL OR portal=$1) RETURNING id',[base.hostname])).rowCount;
   if(!pinned)throw new BitrixError('Настроен другой портал Битрикс24. Проверьте существующие привязки.');
   const gate=(await db.query("SELECT greatest(0,extract(epoch FROM next_at-clock_timestamp())*1000)::float8 AS wait FROM bitrix_rest_gate WHERE id=1")).rows[0];
   const budget=(await db.query("SELECT greatest(0,extract(epoch FROM next_at-clock_timestamp())*1000)::float8 wait,next_at FROM bitrix_method_budget WHERE portal=$1 AND method=$2",[base.hostname,method])).rows[0];
   if(budget?.wait>5000)throw new BitrixError('Метод Битрикс24 на паузе после ограничения ресурсоёмкости.','rejected','OPERATION_TIME_LIMIT',budget.next_at);
   gate.wait=Math.max(gate.wait,budget?.wait||0);
   if(gate.wait>5000)throw new BitrixError('Битрикс24 на паузе после ограничения REST.');
   if(gate.wait>0)await delay(Math.ceil(gate.wait));
   await db.query("UPDATE bitrix_rest_gate SET next_at=clock_timestamp()+interval '1100 milliseconds' WHERE id=1");
   let response:Awaited<ReturnType<typeof transport.send>>;
   try{
    const target=new URL(method,base);if(method==='tasks.task.chat.message.send')target.pathname=target.pathname.replace('/rest/','/rest/api/');
    const token=application?await applicationToken(oauth!,portal!):null;
    response=await transport.send(target,token?{...params,auth:token.access_token}:params,options);
   }catch(e){throw new BitrixError(e instanceof BitrixTransportError?e.message:'Нет подтверждённого ответа REST Битрикс24.',e instanceof BitrixTransportError?e.disposition:'uncertain');}
   const body=response.body;
   const operating=Number(body?.time?.operating),reset=Number(body?.time?.operating_reset_at);
   if(Number.isFinite(operating)&&operating>=0){
    await db.query(`INSERT INTO bitrix_method_budget(portal,method,operating,reset_at,next_at) VALUES($1,$2,$3::float8,to_timestamp($4::float8),CASE WHEN $3::float8>=300 AND $4::float8>extract(epoch FROM now()) THEN to_timestamp($4::float8) ELSE 'epoch'::timestamptz END)
     ON CONFLICT(portal,method) DO UPDATE SET operating=excluded.operating,reset_at=excluded.reset_at,next_at=greatest(bitrix_method_budget.next_at,excluded.next_at),updated_at=now()`,[base.hostname,method,operating,Number.isFinite(reset)?reset:0]);
   }
   if(body?.error==='OPERATION_TIME_LIMIT'){
    await db.query("INSERT INTO bitrix_method_budget(portal,method,next_at,last_error) VALUES($1,$2,now()+interval '10 minutes','OPERATION_TIME_LIMIT') ON CONFLICT(portal,method) DO UPDATE SET next_at=now()+interval '10 minutes',last_error='OPERATION_TIME_LIMIT'",[base.hostname,method]);
   }else if([429,503].includes(response.status)||body?.error==='QUERY_LIMIT_EXCEEDED'||body?.error==='OVERLOAD_LIMIT'){
    await db.query("UPDATE bitrix_rest_gate SET next_at=greatest(next_at,clock_timestamp()+interval '1 minute') WHERE id=1");
   }
   if(!response.ok||body?.error||!body||!Object.hasOwn(body,'result')){
    const rejected=['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT','OVERLOAD_LIMIT'].includes(body?.error)||response.layer==='bitrix'&&response.status===429||response.status<500&&response.status!==408&&!!body?.error;
    throw new BitrixError(knownErrors.has(body?.error)?body.error:`Ошибка ответа ${response.layer==='balancer'?'балансировщика':'REST Битрикс24'} (HTTP ${response.status}).`,rejected?'rejected':'uncertain',knownErrors.has(body?.error)?body.error:null);
   }
   await db.query('UPDATE bitrix_rest_gate SET last_success_at=clock_timestamp() WHERE id=1');
   observe?.({next:body.next,total:body.total,time:body.time});
   return body.result as T;
  }finally{
   try{await db.query('SELECT pg_advisory_unlock(431024)');db.release();}
   catch{db.release(true);}
  }
 };
 request.mode=application?'application':'webhook';request.portal=portal;request.memberId=credentials?.member_id;return request;
}
