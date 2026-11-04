import {readFile} from 'node:fs/promises';
import {pool} from './db.js';
import {assert,canSee} from './domain.js';
import {pendingOutbox,pilotStatus} from './telegram-pilot.js';
import {pendingAlerts} from './reminders.js';
import {taskSyncStatus} from './task-sync.js';
import {operationsStatus} from './automation.js';
import type {Task,User} from '../shared/types.js';

async function backupRecord(name:string){
 try{
  const value=JSON.parse(await readFile('/var/lib/ruspet/maintenance/'+name+'.json','utf8'));
  if(typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at)))return null;
  return {at:value.at,ok:typeof value.ok==='boolean'?value.ok:null,copies:Number.isInteger(value.copies)?value.copies:null,tasks:Number.isInteger(value.rows?.tasks)?value.rows.tasks:null};
 }catch{return null;}
}

export async function systemStatus(actor:User){
 assert(actor.role==='admin',403,'Диагностика доступна администратору.');
 const [pilot,automation,bindings,timings,reports,backup,restore,backupAttempt,restoreAttempt,sync]=await Promise.all([
  pilotStatus(actor),operationsStatus(),
  pool.query('SELECT u.*,b.paired_at FROM telegram_binding b JOIN users u ON u.id=b.user_id'),
  pool.query(`SELECT kind,count(*)::int samples,count(*) FILTER (WHERE NOT ok)::int errors,
   round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE ok))::numeric)::int median,
   round((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE ok))::numeric)::int p95
   FROM telegram_response_times WHERE created_at>now()-interval '7 days' GROUP BY kind`),
  pool.query("SELECT DISTINCT ON (state) job_key,state,finished_at FROM job_runs WHERE job_key LIKE 'reports-v5:%' AND state IN ('done','failed') ORDER BY state,finished_at DESC NULLS LAST"),
  backupRecord('backup'),backupRecord('restore'),backupRecord('backup.attempt'),backupRecord('restore.attempt'),taskSyncStatus()
 ]);
 let pending=0;
 if(pilot.settings.enabled&&pilot.settings.delivery){
  const now=new Date();
  for(const user of bindings.rows){
   pending+=(await pendingOutbox(user,pilot.settings.enabled_at,user.paired_at)).length;
   pending+=(await pendingAlerts(user,now,null)).length;
  }
 }
 return {
  telegram:{enabled:pilot.settings.enabled,deliveryEnabled:pilot.settings.delivery,bindings:bindings.rowCount,
   lastPoll:pilot.runtime?.last_poll_at??null,error:pilot.runtime?.error??null,
   pending,delivery:pilot.delivery,timings:timings.rows},
  reports:{enabled:automation.config.enabled,alive:automation.alive,heartbeat:automation.heartbeat,runs:reports.rows},
  bitrix:sync.bitrix,
  backups:{backup,restore,backupAttempt,restoreAttempt}
 };
}

export async function accessDirectory(actor:User){
 assert(actor.role==='admin',403,'Доступы сотрудников видит администратор.');
 const [people,tasks]=await Promise.all([
  pool.query(`SELECT u.*,b.paired_at,
   (SELECT json_agg(json_build_object('username',a.username,'enabled',a.enabled) ORDER BY a.username) FROM login_accounts a WHERE a.user_id=u.id) accounts,
   (SELECT max(p.expires_at) FROM telegram_pairings p WHERE p.user_id=u.id AND p.expires_at>now()) invitation_expires
   FROM users u LEFT JOIN telegram_binding b ON b.user_id=u.id ORDER BY u.name,u.id`),
  pool.query<Task>('SELECT * FROM tasks')
 ]);
 return people.rows.map(person=>({...person,accounts:person.accounts??[],visibleTasks:tasks.rows.filter(task=>canSee(person,task)).length}));
}
