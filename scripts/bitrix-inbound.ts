import 'dotenv/config';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {pool} from '../server/db.js';
import {assert,AppError} from '../server/domain.js';
import {bitrixClient,BitrixError} from '../server/bitrix-rest.js';
import {bitrixId} from '../server/bitrix-sync.js';
import {readEventToken,taskWebhookEvents} from '../server/bitrix-events.js';
import {enqueueInboundSnapshot,tickInboundTasks} from '../server/bitrix-inbound.js';

let stopped=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{stopped=true;});
try{
 const {positionals,values}=parseArgs({allowPositionals:true,options:{id:{type:'string'}}});
 const [command]=positionals;
 const id=values.id;
 assert(positionals.length===1&&(!id||bitrixId(id)),400,'Команды: status, prepare, verify --id ID, enqueue [--id ID], watch.');
 const portal=process.env.BITRIX_PORTAL;
 assert(portal,400,'Укажите BITRIX_PORTAL.');
 if(command==='status'){
  const capture=(await pool.query('SELECT enabled,portal,verified_at FROM bitrix_event_capture WHERE id=1')).rows[0];
  const queue=(await pool.query(`SELECT resource,state,count(*)::int AS tasks FROM bitrix_refresh_queue
   WHERE portal=$1 AND resource IN ('task_inbound','task_inbound_comments') GROUP BY resource,state ORDER BY resource,state`,[portal])).rows;
  const issues=(await pool.query(`SELECT external_id AS id,resource,error FROM bitrix_refresh_queue
   WHERE portal=$1 AND resource IN ('task_inbound','task_inbound_comments') AND state IN ('failed','blocked') ORDER BY updated_at LIMIT 20`,[portal])).rows;
  const conflicts=(await pool.query("SELECT count(*)::int AS n FROM bitrix_task_links WHERE NOT live_enabled AND conflict IS NOT NULL")).rows[0].n;
  console.log(JSON.stringify({capture,queue,issues,conflicts},null,2));
 }else{
  assert(process.env.BITRIX_INBOUND_TASKS==='true'&&process.env.BITRIX_WRITE_ENABLED==='false'&&
   process.env.BITRIX_TRANSPORT==='balancer',409,'Укажите режим входящих задач, отключите запись и выберите балансировщик.');
  const field=process.env.BITRIX_INBOUND_PRICE_FIELD;
  assert(!field||/^UF_[A-Z0-9_]+$/.test(field),400,'Для цены нужен точный код UF-поля.');
  const request=await bitrixClient();
  assert(request.mode==='webhook',409,'Нужен входящий вебхук Битрикс24 для чтения.');
  if(command==='verify'){
   assert(id,400,'Укажите --id известной задачи из выгрузки.');
   const result=await request<{task?:{id?:unknown;createdDate?:string}}>('tasks.task.get',{taskId:id,select:['ID','CREATED_DATE']});
   const task=(await pool.query("SELECT created_at FROM tasks WHERE id=$1 AND source_fields->>'ID'=id",[id])).rows[0];
   assert(task&&bitrixId(result.task?.id)===id&&Date.parse(result.task?.createdDate??'')===Date.parse(task.created_at),409,
    'Ответ Битрикс24 расходится с ID или датой создания задачи из выгрузки.');
   console.log({task:id,readVerified:true});
  }else if(command==='prepare'){
   const tokenFile=process.env.BITRIX_EVENT_TOKEN_FILE;
   assert(tokenFile,503,'Укажите закрытый файл токена исходящего вебхука.');
   await readEventToken(tokenFile);
   const result=await pool.query(`UPDATE bitrix_event_capture SET enabled=true,mode='online',portal=$1,coverage=$2,
    started_at=coalesce(started_at,now()) WHERE id=1 AND (portal IS NULL OR portal=$1 AND mode='online')`,
    [portal,JSON.stringify(taskWebhookEvents)]);
   assert(result.rowCount,409,'Уже настроен другой портал или режим приёма событий.');
   console.log({callback:process.env.PUBLIC_ORIGIN+'/api/bitrix/events',events:taskWebhookEvents});
  }else if(command==='enqueue'){
   console.log({queued:await enqueueInboundSnapshot(portal,id)});
  }else if(command==='watch'){
   while(!stopped){
    const result=await tickInboundTasks(request);
    if(result)console.log(JSON.stringify(result));
    if(!stopped&&(!result||'transient' in result&&result.transient))await delay(result?15000:4000);
   }
  }else throw new AppError(400,'Неизвестная команда.');
 }
}catch(error){
 console.error(error instanceof AppError||error instanceof BitrixError?error.message:'Операция Битрикс24 не подтверждена. Проверьте БД и закрытые настройки.');
 process.exitCode=1;
}finally{await pool.end();}
