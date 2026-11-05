import 'dotenv/config';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {pool} from '../server/db.js';
import {assert,AppError} from '../server/domain.js';
import {bitrixClient,BitrixError} from '../server/bitrix-rest.js';
import {startInitialArchive,archiveStatus,resumeArchive,pauseArchive,tickInitialArchive} from '../server/bitrix-archive.js';
import {bindArchiveEvents,pullOfflineEvents} from '../server/bitrix-events.js';
import {tickEventRefresh,reconcileKnownTask} from '../server/bitrix-refresh.js';
import {selectedPilotManagers,applySelectedManagers} from '../server/pilot-selection.js';
import {syncCompanySnapshots} from '../server/company-responsibility.js';
import {closeOkb} from '../server/okb.js';
import type {User} from '../shared/types.js';
const {values,positionals}=parseArgs({allowPositionals:true,options:{actor:{type:'string'},confirm:{type:'boolean'},'metadata-only':{type:'boolean'},online:{type:'boolean'},steps:{type:'string',default:'10'}}});
const [command,id]=positionals;let stopped=false;process.once('SIGTERM',()=>{stopped=true;});process.once('SIGINT',()=>{stopped=true;});
try{
 assert(values.actor,400,'Укажите --actor с ID администратора.');const actor=(await pool.query<User>('SELECT * FROM users WHERE id=$1',[values.actor])).rows[0];assert(actor?.role==='admin',403,'Операцию выполняет администратор.');
 const portal=process.env.BITRIX_PORTAL;assert(portal,400,'Укажите BITRIX_PORTAL.');
 switch(command){
  case 'selected':console.log(JSON.stringify(await selectedPilotManagers(actor),null,2));break;
  case 'select-managers':assert(values.confirm,400,'Сохранение состава — с --confirm после проверки ID.');console.log(await applySelectedManagers(actor));break;
  case 'status':console.log(JSON.stringify(await archiveStatus(actor,id),null,2));break;
  case 'bind':{
   assert(values.confirm,400,'Регистрация событий изменяет настройки приложения; добавьте --confirm.');
   const request=await bitrixClient({application:true});console.log(await bindArchiveEvents(request,values.online?'online':'offline',process.env.PUBLIC_ORIGIN+'/api/bitrix/events'));break;
  }
  case 'start':{
   assert(values.confirm,400,'Создание полной загрузки — с --confirm; рабочие задачи не перезаписываются.');
   const request=await bitrixClient();assert(await request('user.admin',{})===true,403,'Для полной загрузки нужна административная учётная запись Битрикс24.');
   console.log(await startInitialArchive(actor,portal,!values['metadata-only']));break;
  }
  case 'pause':assert(id,400,'Нужен ID загрузки.');await pauseArchive(actor,id);console.log('Загрузка приостановлена.');break;
  case 'resume':assert(id&&values.confirm,400,'Укажите ID и --confirm для повтора заблокированных разделов.');await resumeArchive(actor,id);console.log('Загрузка продолжена с сохранённых курсоров.');break;
  case 'reconcile':assert(id&&values.confirm,400,'Укажите конкретный ID задачи и --confirm.');await reconcileKnownTask(actor,portal,id);console.log('Задача поставлена на адресную сверку.');break;
  case 'publish-companies':{
   assert(id,400,'Нужен ID загрузки.');const status=await archiveStatus(actor,id);assert(status.run?.portal===portal,409,'Другой портал загрузки.');assert(status.sections.some(section=>section.resource==='company'&&section.state==='done'),409,'Полная выборка компаний ещё не завершена.');
   const rows=(await pool.query("SELECT raw FROM bitrix_archive_objects WHERE run_id=$1 AND resource='company' ORDER BY external_id::bigint",[id])).rows;
   let processed=0;
   for(let offset=0;offset<rows.length;offset+=20){
    await syncCompanySnapshots(actor,{portal,dryRun:!values.confirm,companies:rows.slice(offset,offset+20).map(({raw})=>({externalId:String(raw.ID),name:raw.TITLE,externalManagerId:raw.ASSIGNED_BY_ID&&String(raw.ASSIGNED_BY_ID)!=='0'?String(raw.ASSIGNED_BY_ID):null,raw}))});processed+=Math.min(20,rows.length-offset);
   }
   if(values.confirm)await pool.query('UPDATE bitrix_event_capture SET project_companies=true WHERE id=1 AND portal=$1',[portal]);
   console.log({dryRun:!values.confirm,companies:processed});break;
  }
  case 'tick':case 'watch':{
   assert(id,400,'Укажите ID загрузки.');const steps=Number(values.steps);assert(Number.isInteger(steps)&&steps>=1&&steps<=100,400,'--steps: 1–100.');
   const request=await bitrixClient();
   let app:Awaited<ReturnType<typeof bitrixClient>>|null=null;
   do{
    let busy=false;
    try{
     const capture=(await pool.query('SELECT * FROM bitrix_event_capture WHERE id=1')).rows[0];
     if(capture.enabled&&capture.mode==='offline'){app??=await bitrixClient({application:true});await pullOfflineEvents(app);}
     const bulk=await tickInitialArchive(request,id,steps),updates=await tickEventRefresh(request,steps,actor);
     busy=!!(bulk.processed||updates.processed);console.log({bulk,updates});
    }catch(error){console.error(error instanceof BitrixError||error instanceof AppError?error.message:'Шаг загрузки не подтверждён. Проверьте диагностику и закрытые настройки.');if(command==='tick')throw Error('Шаг не завершён.');}
    if(command==='watch'&&!stopped)await delay(busy?100:15000);
   }while(command==='watch'&&!stopped);break;
  }
  default:throw new AppError(400,'Команды: selected, select-managers, bind, start, status, tick, watch, pause, resume, reconcile, publish-companies.');
 }
}catch(error){console.error(error instanceof BitrixError||error instanceof AppError?error.message:'Операция не подтверждена. Подробности доступа не выводятся.');process.exitCode=1;}
finally{await closeOkb();await pool.end();}
