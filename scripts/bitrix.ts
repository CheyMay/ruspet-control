import {processBitrixReconcile} from '../server/bitrix-reconcile.js';
import {processBitrixImEvents} from '../server/bitrix-im-events.js';
import {processBitrixContentOperation} from '../server/bitrix-operations.js';
import {processBitrixContent,refreshBitrixMetadata} from '../server/bitrix-content.js';
import {processBitrixCommentEvent,processBitrixCommentOutbound,readRemoteComment} from '../server/bitrix-comments.js';
import {bootstrapBitrixExport,catchupBitrix,mapExportUsers} from '../server/bitrix-bootstrap.js';
import {processBitrixCreation} from '../server/bitrix-create.js';
import {processBitrixOutbound} from '../server/bitrix-outbound.js';
import {processBitrixEvent} from '../server/bitrix-events.js';
import {setTimeout as delay} from 'node:timers/promises';
import {pool} from '../server/db.js';
import {BitrixError,bitrixClient,closeBitrixRest} from '../server/bitrix-rest.js';
import {bitrixId,getRemote,linkTask,scanProject,syncActivity,syncLinkedTask} from '../server/bitrix-sync.js';

const [command,taskId,arg,extra]=process.argv.slice(2);
const requiredId=(value:unknown)=>{
 const id=bitrixId(value);
 if(!id)throw new BitrixError('Укажите числовой ID Битрикс24.');
 return id;
};
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
const lock=await pool.connect();
try{
 if(!(await lock.query('SELECT pg_try_advisory_lock(431025) AS ok')).rows[0].ok)throw new BitrixError('Другой процесс синхронизации уже работает.');
 await pool.query("UPDATE bitrix_comment_outbox SET state='uncertain',last_error='Предыдущий обработчик остановился во время отправки. Требуется сверка.' WHERE state='sending'");
 await pool.query("UPDATE bitrix_content_ops SET state='uncertain',last_error='Предыдущий обработчик остановился во время создания. Требуется сверка.' WHERE state='sending'");
 const request=await bitrixClient();
 switch(command){
  case 'confirm-comment':{
   const q=(await pool.query("SELECT q.*,c.task_id,l.external_id FROM bitrix_comment_outbox q JOIN comments c ON c.id=q.comment_id JOIN bitrix_task_links l ON l.task_id=c.task_id WHERE q.comment_id=$1 AND q.state='uncertain'",[taskId])).rows[0];
   if(!q)throw new BitrixError('Нет неподтверждённой отправки комментария.');
   const task=await getRemote(request,String(q.external_id)),transport=task.chatId?'chat':'legacy';
   const comment=await readRemoteComment(request,task.id,transport,requiredId(arg),task.chatId);
   if(!comment||comment.body!==q.attempted_body)throw new BitrixError('Комментарий не совпадает с отправленным текстом.');
   await pool.query('INSERT INTO bitrix_comment_links(comment_id,task_id,transport,external_id,remote_body,local_body,prefix) VALUES($1,$2,$3,$4,$5,$6,$7)',[taskId,q.task_id,transport,requiredId(arg),q.attempted_body,q.attempted_local_body,q.attempted_prefix]);
   await pool.query("UPDATE bitrix_comment_outbox SET state='pending',retry_at=NULL,last_error=NULL WHERE comment_id=$1",[taskId]);
   console.log({confirmed:true});break;
  }
  case 'comments-backfill':{
   const result=await pool.query(`SELECT c.id FROM comments c JOIN bitrix_task_links l ON l.task_id=c.task_id
    WHERE NOT c.bitrix_origin AND c.withdrawn_at IS NULL AND NOT EXISTS(SELECT 1 FROM bitrix_comment_links cl WHERE cl.comment_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM bitrix_comment_outbox q WHERE q.comment_id=c.id)`);
   if(taskId==='--apply')await pool.query(`INSERT INTO bitrix_comment_outbox(comment_id,revision) SELECT c.id,c.revision FROM comments c WHERE c.id=ANY($1::uuid[]) ON CONFLICT DO NOTHING`,[result.rows.map(row=>row.id)]);
   console.log({comments:result.rowCount,queued:taskId==='--apply'});break;
  }
  case 'field-map':{
   if(!['price','important','customer_risk'].includes(taskId)||!/^UF_[A-Z0-9_]+$/.test(arg??''))throw new BitrixError('Укажите локальное поле и UF-код.');
   const fields=await refreshBitrixMetadata(request);
   if(!Object.hasOwn(fields,arg))throw new BitrixError('Такого поля нет в метаданных портала.');
   await pool.query('INSERT INTO bitrix_field_map(local_key,external_code) VALUES($1,$2) ON CONFLICT(local_key) DO UPDATE SET external_code=excluded.external_code',[taskId,arg]);
   console.log({mapped:true});
   break;
  }
  case 'metadata':
   await refreshBitrixMetadata(request);console.log({metadataSaved:true});
   break;
  case 'export-users':
   if(!taskId)throw new BitrixError('Укажите закрытый JSON выгрузки.');
   console.log(await mapExportUsers(request,taskId));
   break;
  case 'bootstrap':
   if(!taskId)throw new BitrixError('Укажите закрытый JSON выгрузки.');
   console.log(await bootstrapBitrixExport(taskId,arg==='--apply'));
   break;
  case 'catchup':
   if(!taskId)throw new BitrixError('Укажите время выгрузки с часовым поясом.');
   console.log(await catchupBitrix(request,taskId,arg??'0'));
   break;
  case 'confirm-created':{
   const intent=(await pool.query("SELECT * FROM bitrix_task_creations WHERE task_id=$1 AND state='uncertain'",[taskId])).rows[0];
   if(!intent)throw new BitrixError('Нет неподтверждённого создания для этой задачи.');
   const remote=await getRemote(request,requiredId(arg));
   if(remote.xmlId!=='ruspet:'+intent.operation_key)throw new BitrixError('XML_ID не совпадает с операцией создания.');
   await pool.query("UPDATE bitrix_task_creations SET external_id=$2,state='confirming',retry_at=NULL WHERE task_id=$1",[taskId,remote.id]);
   console.log({readyForConfirmation:true});
   break;
  }
  case 'map-user':
   if(!taskId)throw new BitrixError('Укажите ID локального сотрудника и ID Битрикс24.');
   const people=await request<{ID:unknown}[]>('user.get',{filter:{ID:requiredId(arg)},select:['ID']});
   if(!Array.isArray(people)||people.length!==1||String(people[0].ID)!==requiredId(arg))throw new BitrixError('Сотрудник Битрикс24 не подтверждён.');
   const existing=(await pool.query('SELECT external_id FROM bitrix_user_links WHERE user_id=$1',[taskId])).rows[0];
   if(existing&&String(existing.external_id)!==requiredId(arg))throw new BitrixError('Есть другая привязка. Требуется ручная сверка перед заменой.');
   await pool.query('INSERT INTO bitrix_user_links(user_id,external_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET external_id=excluded.external_id',[taskId,requiredId(arg)]);
   console.log({mapped:true});
   break;
  case 'scan':{
   const pages=Number(extra??10);
   if(!Number.isInteger(pages)||pages<1||pages>20)throw new BitrixError('Укажите от 1 до 20 страниц.');
   console.log(await scanProject(request,requiredId(taskId),arg==='0'||!arg?'0':requiredId(arg),pages));
   break;
  }
  case 'link':
   if(!taskId)throw new BitrixError('Укажите ID задачи РУСПЭТ.');
   console.log(await linkTask(request,taskId,requiredId(arg),extra==='--accept-bitrix'));
   break;
  case 'sync':
   if(!taskId)throw new BitrixError('Укажите ID задачи РУСПЭТ.');
   console.log(await syncLinkedTask(request,taskId,arg==='--write'&&process.env.BITRIX_WRITE_ENABLED==='true'));
   break;
  case 'activity':
   if(!taskId)throw new BitrixError('Укажите ID задачи РУСПЭТ.');
   console.log(await syncActivity(request,taskId,arg?requiredId(arg):undefined));
   break;
  case 'events':{
   let lastHeartbeat=0;
   if(process.env.BITRIX_EVENTS_ENABLED!=='true')throw new BitrixError('Укажите BITRIX_EVENTS_ENABLED=true.');
   while(!stopping){
    if(Date.now()-lastHeartbeat>15000){
     await pool.query(`INSERT INTO bitrix_runtime(id,heartbeat_at,write_enabled,create_enabled,import_enabled) VALUES(1,now(),$1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),write_enabled=excluded.write_enabled,create_enabled=excluded.create_enabled,import_enabled=excluded.import_enabled`,
      [process.env.BITRIX_WRITE_ENABLED==='true',process.env.BITRIX_CREATE_ENABLED==='true',process.env.BITRIX_IMPORT_NEW_ENABLED==='true']);
     lastHeartbeat=Date.now();
    }
    const imEvents=await processBitrixImEvents(request);
    const incoming=await processBitrixEvent(request);
    const commentEvent=await processBitrixCommentEvent(request);
    const created=await processBitrixCreation(request);
    const commentOutbound=await processBitrixCommentOutbound(request);
    const contentOperation=await processBitrixContentOperation(request);
    const outgoing=await processBitrixOutbound(request);
    const content=await processBitrixContent(request);
    const reconcile=await processBitrixReconcile(request);
    if(!incoming&&!outgoing&&!created&&!commentEvent&&!commentOutbound&&!content&&!contentOperation&&!imEvents&&!reconcile)await delay(2000);
   }
   break;
  }
  case 'watch':
   if(process.env.BITRIX_POLL_ENABLED!=='true')throw new BitrixError('Для опроса укажите BITRIX_POLL_ENABLED=true.');
   while(!stopping){
    const {rows}=await pool.query("SELECT task_id FROM bitrix_task_links WHERE checked_at IS NULL OR checked_at<now()-interval '5 minutes' ORDER BY checked_at NULLS FIRST,task_id LIMIT 10");
    for(const {task_id:id} of rows){
     try{
      await syncLinkedTask(request,id,process.env.BITRIX_WRITE_ENABLED==='true');
      if(process.env.BITRIX_ACTIVITY_ENABLED==='true')await syncActivity(request,id);
     }
     catch(e){
      const reason=e instanceof BitrixError?e.message:'Ошибка синхронизации.';
      await pool.query('UPDATE bitrix_task_links SET checked_at=now(),conflict=$2 WHERE task_id=$1',[id,reason]);
     }
    }
    await delay(15000);
   }
   break;
  default:throw new BitrixError('Команды: confirm-created, export-users, bootstrap, catchup, map-user, scan, link, sync, activity, events, watch.');
 }
}catch(e){
 console.error(e instanceof BitrixError?e.message:'Не удалось выполнить операцию Битрикс24.');
 process.exitCode=1;
}finally{
 try{await lock.query('SELECT pg_advisory_unlock(431025)');lock.release();}
 catch{lock.release(true);}
 await closeBitrixRest();
 await pool.end();
}
