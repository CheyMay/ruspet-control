import 'dotenv/config';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {pool,transaction} from '../server/db.js';
import {assert,AppError,canManage} from '../server/domain.js';
import {bitrixClient,BitrixError} from '../server/bitrix-rest.js';
import {discoverTaskFields,mapBitrixUser} from '../server/bitrix-fields.js';
import {configureLive,activateLiveTask,deactivateLiveTask,tickLiveSync,recoverOperation} from '../server/bitrix-live.js';
import {pilotReadiness,pilotQueue} from '../server/pilot-readiness.js';
const {values,positionals}=parseArgs({allowPositionals:true,options:{manager:{type:'string',multiple:true},leader:{type:'string',multiple:true},confirm:{type:'boolean'},'accept-bitrix':{type:'boolean'}}});
const [command,arg,extra]=positionals;
try{
 switch(command){
  case 'fields':console.log(JSON.stringify(await discoverTaskFields(await bitrixClient()),null,2));break;
  case 'queue':console.log(await pilotQueue());break;
  case 'map-user':assert(arg&&extra,400,'Нужны локальный ID и ID Битрикс24.');console.log(await mapBitrixUser(await bitrixClient(),arg,extra,!!values.confirm));break;
  case 'configure':assert(arg&&extra,400,'Нужны ID проекта и код поля цены.');await configureLive(arg,extra);console.log('Настройки сохранены. Обмен не включён.');break;
  case 'roster':{
   const managers=values.manager||[],leaders=values.leader||[],all=[...managers,...leaders];
   assert(managers.length===2&&leaders.length>0&&new Set(all).size===all.length,400,'Укажите два разных --manager и хотя бы одного --leader.');
   const people=(await pool.query('SELECT * FROM users WHERE id=ANY($1)',[all])).rows;
   assert(people.length===all.length&&people.every(p=>managers.includes(p.id)?p.role==='employee':canManage(p)),400,'Проверьте ID и роли участников. Руководителям нужна управленческая роль.');
   console.log(people.map(p=>({id:p.id,name:p.name,role:p.role,pilot:managers.includes(p.id)?'manager':'leader'})));
   if(values.confirm)await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(431025)');const active=(await db.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0];assert(!active.enabled,409,'Сначала приостановите пилот.');await db.query('DELETE FROM bitrix_pilot_members');for(const person of people)await db.query('INSERT INTO bitrix_pilot_members(user_id,pilot_role) VALUES($1,$2)',[person.id,managers.includes(person.id)?'manager':'leader']);});
   console.log(values.confirm?'Состав сохранён.':'Это предварительный просмотр. Для сохранения добавьте --confirm.');break;
  }
  case 'activate':assert(arg,400,'Нужен локальный ID задачи.');console.log(await activateLiveTask(await bitrixClient(),arg,!!values['accept-bitrix']));break;
  case 'deactivate':assert(arg&&values.confirm,400,'Нужны ID задачи и --confirm.');console.log(await deactivateLiveTask(arg));break;
  case 'check':{const status=await pilotReadiness();for(const c of status.checks)console.log(`[${c.level}] ${c.message}`);console.log(status.ready?'Проверки перед включением пройдены. Реальная запись ещё требует контрольного прогона.':'Пилот не готов: устраните блокирующие пункты.');if(!status.ready)process.exitCode=1;break;}
  case 'enable':{
   assert(values.confirm,400,'Для включения требуется --confirm.');assert(process.env.BITRIX_WRITE_ENABLED==='true',400,'Запись требует BITRIX_WRITE_ENABLED=true в окружении обработчика.');
   const status=await pilotReadiness();assert(status.ready,409,'Пилот не готов. Сначала выполните check.');
   await pool.query('UPDATE bitrix_live_config SET enabled=true,updated_at=now() WHERE id=1');console.log('Пилот включён только для явно активированных задач.');break;
  }
  case 'pause':await pool.query('UPDATE bitrix_live_config SET enabled=false,updated_at=now() WHERE id=1');console.log('Запись приостановлена. Очередь и локальные данные сохранены.');break;
  case 'retry':case 'verify':assert(arg&&values.confirm,400,'Укажите ID операции и --confirm после сверки.');console.log(await recoverOperation(await bitrixClient(),arg,command));break;
  case 'tick':console.log(await tickLiveSync(await bitrixClient()));break;
  case 'watch':{
   const request=await bitrixClient();let stopped=false;process.on('SIGTERM',()=>{stopped=true});process.on('SIGINT',()=>{stopped=true});
   do{try{await tickLiveSync(request);}catch(e){console.error(e instanceof BitrixError||e instanceof AppError?e.message:'Не удалось выполнить сверку пилота.');}if(!stopped)await delay(15000);}while(!stopped);break;
  }
  default:throw new AppError(400,'Команды: fields, map-user, configure, roster, activate, deactivate, check, enable, pause, tick, watch, queue, retry, verify.');
 }
}catch(e){console.error(e instanceof BitrixError||e instanceof AppError?e.message:'Операция не подтверждена. Проверьте окружение и состояние пилота.');process.exitCode=1;}finally{await pool.end();}
