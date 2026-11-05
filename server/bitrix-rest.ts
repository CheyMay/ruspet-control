import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {pool} from './db.js';
import {createBitrixTransport,BitrixTransportError} from './bitrix-transport.js';

export type BitrixMethod='tasks.task.list'|'tasks.task.get'|'tasks.task.update'|'tasks.task.history.list'|'im.dialog.messages.get'|'task.commentitem.getlist'|'tasks.task.getFields'|'user.get'|'tasks.task.complete'|'tasks.task.approve'|'tasks.task.disapprove'|'tasks.task.renew'|'tasks.task.chat.message.send'|'task.commentitem.add'|'crm.company.list'|'crm.company.get'|'crm.company.fields';
const knownErrors=new Set(['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT','NO_AUTH_FOUND','ACCESS_DENIED','OVERLOAD_LIMIT','ERROR_TASK_NOT_FOUND']);
export class BitrixError extends Error {constructor(message:string,public disposition:'rejected'|'uncertain'='rejected'){super(message);}}

export function webhookBase(secret:string,portal:string){
 const url=new URL(secret);
 if(url.protocol!=='https:'||url.hostname!==portal.toLowerCase()||url.port||url.username||url.password||url.search||url.hash||!/^\/rest\/\d+\/[a-zA-Z0-9_-]+\/$/.test(url.pathname)){
  throw new BitrixError('Некорректный адрес входящего вебхука.');
 }
 return url;
}

export async function bitrixClient(){
 const {BITRIX_PORTAL:portal,BITRIX_WEBHOOK_FILE:file}=process.env;
 if(!portal||!file)throw new BitrixError('Укажите BITRIX_PORTAL и BITRIX_WEBHOOK_FILE.');
 let base:URL;
 try{base=webhookBase((await readFile(file,'utf8')).trim(),portal);}
 catch{throw new BitrixError('Не удалось прочитать настройки вебхука. Проверьте домен и файл.');}
 let transport:Awaited<ReturnType<typeof createBitrixTransport>>;
 try{transport=await createBitrixTransport(base.origin);}catch(e){throw new BitrixError(e instanceof BitrixTransportError?e.message:'Не удалось настроить транспорт Битрикс24.');}
 return async function request<T>(method:BitrixMethod,params:object):Promise<T>{
  const db=await pool.connect();
  try{
   await db.query('SELECT pg_advisory_lock(431024)');
   const pinned=(await db.query('UPDATE bitrix_rest_gate SET portal=$1 WHERE id=1 AND (portal IS NULL OR portal=$1) RETURNING id',[base.hostname])).rowCount;
   if(!pinned)throw new BitrixError('Настроен другой портал Битрикс24. Проверьте существующие привязки.');
   const gate=(await db.query("SELECT greatest(0,extract(epoch FROM next_at-clock_timestamp())*1000)::float8 AS wait FROM bitrix_rest_gate WHERE id=1")).rows[0];
   if(gate.wait>5000)throw new BitrixError('Битрикс24 на паузе после ограничения REST.');
   if(gate.wait>0)await delay(Math.ceil(gate.wait));
   await db.query("UPDATE bitrix_rest_gate SET next_at=clock_timestamp()+interval '1100 milliseconds' WHERE id=1");
   let response:Awaited<ReturnType<typeof transport.send>>;
   try{
    const target=new URL(method,base);if(method==='tasks.task.chat.message.send')target.pathname=target.pathname.replace('/rest/','/rest/api/');
    response=await transport.send(target,params);
   }catch(e){throw new BitrixError(e instanceof BitrixTransportError?e.message:'Нет подтверждённого ответа REST Битрикс24.',e instanceof BitrixTransportError?e.disposition:'uncertain');}
   const body=response.body;
   if(response.status===429||body?.error==='OPERATION_TIME_LIMIT'){
    await db.query("UPDATE bitrix_rest_gate SET next_at=clock_timestamp()+interval '10 minutes' WHERE id=1");
   }else if(response.status===503||body?.error==='QUERY_LIMIT_EXCEEDED'||body?.error==='OVERLOAD_LIMIT'){
    await db.query("UPDATE bitrix_rest_gate SET next_at=clock_timestamp()+interval '1 minute' WHERE id=1");
   }
   if(!response.ok||body?.error||!body||!Object.hasOwn(body,'result')){
    const rejected=response.status===429||response.status<500&&response.status!==408&&!!body?.error;
    throw new BitrixError(knownErrors.has(body?.error)?body.error:`Ошибка ответа ${response.layer==='balancer'?'балансировщика':'REST Битрикс24'} (HTTP ${response.status}).`,rejected?'rejected':'uncertain');
   }
   await db.query('UPDATE bitrix_rest_gate SET last_success_at=clock_timestamp() WHERE id=1');
   return body.result as T;
  }finally{
   try{await db.query('SELECT pg_advisory_unlock(431024)');db.release();}
   catch{db.release(true);}
  }
 };
}
export type BitrixRequest=Awaited<ReturnType<typeof bitrixClient>>;
