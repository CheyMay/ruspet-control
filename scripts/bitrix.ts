import {setTimeout as delay} from 'node:timers/promises';
import {pool} from '../server/db.js';
import {BitrixError,bitrixClient} from '../server/bitrix-rest.js';
import {bitrixId,linkTask,scanProject,syncActivity,syncLinkedTask} from '../server/bitrix-sync.js';

const [command,taskId,arg,extra]=process.argv.slice(2);
const requiredId=(value:unknown)=>{
 const id=bitrixId(value);
 if(!id)throw new BitrixError('Укажите числовой ID Битрикс24.');
 return id;
};
const lock=await pool.connect();
try{
 if(!(await lock.query('SELECT pg_try_advisory_lock(431025) AS ok')).rows[0].ok)throw new BitrixError('Другой процесс синхронизации уже работает.');
 const request=await bitrixClient();
 switch(command){
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
  case 'watch':
   if(process.env.BITRIX_POLL_ENABLED!=='true')throw new BitrixError('Для опроса укажите BITRIX_POLL_ENABLED=true.');
   for(;;){
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
  default:throw new BitrixError('Команды: scan, link, sync, activity, watch.');
 }
}catch(e){
 console.error(e instanceof BitrixError?e.message:'Не удалось выполнить операцию Битрикс24.');
 process.exitCode=1;
}finally{
 try{await lock.query('SELECT pg_advisory_unlock(431025)');lock.release();}
 catch{lock.release(true);}
 await pool.end();
}
