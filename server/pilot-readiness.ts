import {pool} from './db.js';
import {access,stat,readFile} from 'node:fs/promises';
import {bitrixClient} from './bitrix-rest.js';
import {canManage,canSee} from './domain.js';
import {exclusionReason} from '../shared/task-selection.js';
import type {User,Task,Rules} from '../shared/types.js';
export async function pilotReadiness(){
 const checks:{level:'block'|'warning'|'ok';message:string}[]=[];
 const add=(ok:unknown,message:string,warning=false)=>checks.push({level:ok?'ok':warning?'warning':'block',message});
 const [people,roster,tasks,accounts,bindings,reporting,links,cfg,telegram,runtime,rules]=await Promise.all([
  pool.query<User>('SELECT * FROM users'),pool.query('SELECT * FROM bitrix_pilot_members'),pool.query<Task>('SELECT * FROM tasks'),
  pool.query('SELECT user_id FROM login_accounts WHERE enabled'),pool.query('SELECT user_id FROM telegram_binding'),pool.query('SELECT * FROM org_reporting'),
  pool.query('SELECT * FROM bitrix_task_links'),pool.query('SELECT * FROM bitrix_live_config WHERE id=1'),pool.query('SELECT * FROM telegram_settings WHERE id=1'),
  pool.query('SELECT last_poll_at,error FROM telegram_runtime WHERE id=1'),pool.query('SELECT config FROM rule_versions ORDER BY version DESC LIMIT 1')
 ]);
 const managers=roster.rows.filter(p=>p.pilot_role==='manager'),leaders=roster.rows.filter(p=>p.pilot_role==='leader'),members=new Set(roster.rows.map(p=>p.user_id));
 add(process.env.DEMO_AUTH==='false','Демонстрационный вход должен быть выключен (DEMO_AUTH=false).');
 let https=false;try{https=new URL(process.env.PUBLIC_ORIGIN||'').protocol==='https:'}catch{}
 add(https,'Для ссылок и защищённых cookies нужен HTTPS PUBLIC_ORIGIN.');
 add(managers.length===2&&leaders.length>0,'Нужны два менеджера и хотя бы один руководитель в подтверждённом составе пилота.');
 let secretReady=false;try{const file=process.env.BITRIX_WEBHOOK_FILE!;await access(file);const info=await stat(file);if(info.isFile()&&(info.mode&0o077)===0){await bitrixClient();secretReady=true;}}catch{}
 add(secretReady&&process.env.BITRIX_PORTAL==='thebest.bitrix24.ru','Нужен доступный закрытый файл вебхука портала thebest.bitrix24.ru (права 600).');
 const rest=(await pool.query('SELECT portal,last_success_at FROM bitrix_rest_gate WHERE id=1')).rows[0];
 add(rest?.portal==='thebest.bitrix24.ru'&&rest.last_success_at&&Date.now()-Date.parse(rest.last_success_at)<600000,'Нужен успешный ответ REST нужного портала за последние 10 минут.');
 add(cfg.rows[0]?.group_id&&cfg.rows[0]?.price_field,'Должны быть выбраны проект и поле цены Битрикс24.');
 add(telegram.rows[0]?.enabled&&telegram.rows[0]?.delivery,'Для пилота должны быть включены бот и доставка.');
 add(runtime.rows[0]?.last_poll_at&&Date.now()-Date.parse(runtime.rows[0].last_poll_at)<120000&&!runtime.rows[0].error,'Нужен свежий heartbeat бота без ошибки.');
 const selectorRole={branchManager:'branch_manager',salesHead:'sales_head',director:'director'};
 for(const member of roster.rows){
  const person=people.rows.find(p=>p.id===member.user_id)!;
  add(member.pilot_role==='manager'?person.role==='employee':canManage(person),`${person.name}: роль соответствует участию в пилоте.`);
  add(accounts.rows.some(a=>a.user_id===person.id),`${person.name}: есть активный персональный веб-вход.`);
  add(bindings.rows.some(b=>b.user_id===person.id),`${person.name}: привязан личный Telegram.`);
  const external=(await pool.query('SELECT 1 FROM bitrix_user_links WHERE user_id=$1',[person.id])).rowCount;
  add(external,`${person.name}: подтверждён ID пользователя Битрикс24.`);
  if(member.pilot_role!=='manager')continue;
  const managerId=reporting.rows.find(r=>r.employee_id===person.id)?.manager_id;
  add(leaders.some(p=>p.user_id===managerId),`${person.name}: назначен руководитель из пилота.`);
  const own=tasks.rows.filter(t=>t.assignee_id===person.id&&!exclusionReason(t)&&t.status!=='completed');
  const included=own.filter(t=>links.rows.some(l=>l.task_id===t.id&&l.live_enabled));
  add(included.length>0,`${person.name}: в пилот включено задач ${included.length}.`);
  add(own.length===included.length,`${person.name}: ещё ${own.length-included.length} задач остаются локальными; они не будут отправляться автоматически.`,true);
  for(const task of included){
   add(members.has(task.creator_id),`#${task.id}: постановщик участвует в пилоте и получит сдачу на приёмку.`);
   const setting=rules.rows[0]?.config as Rules|undefined;
   for(const selector of new Set([...(setting?.routes.deadline||[]),...(setting?.routes.completion||[])])){
    const matches=people.rows.filter(p=>selector==='creator'?p.id===task.creator_id:selector==='branchManager'?p.role==='branch_manager'&&p.branch_id===task.branch_id:p.role===selectorRole[selector]);
    add(matches.length===1&&members.has(matches[0].id)&&matches[0].id!==person.id&&canSee(matches[0],task),`#${task.id}: этап «${selector}» однозначен, доступен и назначен участнику пилота.`);
   }
  }
 }
 const operations=(await pool.query("SELECT state,count(*)::int count FROM bitrix_operations WHERE state NOT IN ('sent','canceled') GROUP BY state")).rows;
 add(!operations.some(o=>['uncertain','blocked','processing'].includes(o.state)),'Нет операций с неизвестным результатом, конфликтом или прерванной отправкой.');
 add(!links.rows.some(l=>l.live_enabled&&l.conflict),'Нет ошибок последней сверки активированных связей.');
 let recentBackup=false;try{const backup=JSON.parse(await readFile('/var/lib/ruspet/maintenance/backup.json','utf8'));recentBackup=Number.isFinite(Date.parse(backup.at))&&Date.now()-Date.parse(backup.at)<36*3600000;}catch{}
 add(recentBackup,'Перед началом работы нужна свежая резервная копия БД; проверьте раздел диагностики.',true);
 const ready=!checks.some(c=>c.level==='block');return {ready,enabled:!!cfg.rows[0]?.enabled,writeEnabled:process.env.BITRIX_WRITE_ENABLED==='true',checks,operations};
}
export async function pilotQueue(){return (await pool.query("SELECT event_id,task_id,state,phase,attempts,error,created_at FROM bitrix_operations WHERE state NOT IN ('sent','canceled') ORDER BY sequence LIMIT 100")).rows;}
