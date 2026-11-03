import {pool,transaction} from './db.js';
import {assert} from './domain.js';
import {businessDay} from '../shared/queues.js';
import {remind,makeReport,event} from './service.js';
import type {User} from '../shared/types.js';
import {nextRuns,jobLabel} from '../shared/schedule.js';
export async function operationsStatus(){
 const config=(await pool.query('SELECT * FROM automation_config WHERE id=1')).rows[0];
 const runs=(await pool.query("SELECT * FROM job_runs WHERE job_key NOT LIKE 'reminders:%' ORDER BY updated_at DESC LIMIT 20")).rows.map(r=>({...r,label:jobLabel(r.job_key)}));
 const heartbeat=(await pool.query('SELECT heartbeat_at FROM automation_runtime WHERE id=1')).rows[0]?.heartbeat_at||null;
 const done=(await pool.query("SELECT job_key FROM job_runs WHERE state='done' AND job_key=ANY($1)",[['reports-v5:morning:'+businessDay(new Date()),'reports-v5:evening:'+businessDay(new Date())]])).rows;
 return {config,runs,heartbeat,alive:!!heartbeat&&Date.now()-Date.parse(heartbeat)<90000,next:nextRuns(config,new Date(),new Set(done.map(r=>r.job_key.replace('reports-v5:',''))))};
}
export async function saveAutomation(user:User,input:{enabled:boolean;morning:string;evening:string}){
 assert(user.role==='admin',403,'Расписание меняет администратор.');
 assert(input.morning<input.evening,400,'Вечернее время должно быть позже утреннего.');
 await transaction(async db=>{await db.query('UPDATE automation_config SET enabled=$1,morning=$2,evening=$3 WHERE id=1',[input.enabled,input.morning,input.evening]);await event(db,null,user.id,'schedule_changed','Изменено расписание автоматизации',input);});
}
export async function tick(now=new Date()){
 const lock=await pool.connect();let acquired=false;try{
  acquired=(await lock.query('SELECT pg_try_advisory_lock(431010) ok')).rows[0].ok;if(!acquired)return;
  await pool.query('INSERT INTO automation_runtime(id,heartbeat_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()');
  const cfg=(await pool.query('SELECT * FROM automation_config WHERE id=1')).rows[0];if(!cfg.enabled)return;
  const shifted=new Date(now.getTime()+10800000),weekday=shifted.getUTCDay(),workday=weekday!==0&&weekday!==6;
  const hhmm=shifted.toISOString().slice(11,16),day=businessDay(now),actor=(await pool.query("SELECT * FROM users WHERE id='admin'")).rows[0] as User;
  const batch=async(kinds:string[],slot:string)=>{const ids:string[]=[];for(const kind of kinds)ids.push((await makeReport(actor,kind,slot,now)).id);return ids;};
  const jobs:{key:string;run:()=>Promise<string[]>}[]=[];
  if(workday&&hhmm>=cfg.morning)jobs.push({key:`reports-v5:morning:${day}`,run:async()=>{return batch(['snapshot'],'scheduled-morning');}});
  if(workday&&hhmm>=cfg.evening)jobs.push({key:`reports-v5:evening:${day}`,run:()=>batch(['daily'],'scheduled-evening')});
  if(workday&&hhmm>=cfg.morning&&hhmm<cfg.evening)jobs.push({key:`reminders:${day}:${Math.floor(now.getTime()/60000)}`,run:async()=>{await remind(actor);return [];}});
  for(const job of jobs){const previous=(await pool.query('SELECT * FROM job_runs WHERE job_key=$1',[job.key])).rows[0];
   // Holding the global lock proves an old 'running' record has no live worker.
   if(previous?.state==='running')await pool.query("UPDATE job_runs SET state='failed',error='Предыдущий процесс прерван. Сохранённые отчёты не потеряны.',finished_at=now(),updated_at=now() WHERE job_key=$1",[job.key]);
   if(previous?.state==='done'||previous?.attempts>=3)continue;
   if(previous?.retry_at&&Date.parse(previous.retry_at)>now.getTime())continue;
   await pool.query("INSERT INTO job_runs(job_key,state,attempts,started_at) VALUES($1,'running',1,now()) ON CONFLICT(job_key) DO UPDATE SET state='running',attempts=job_runs.attempts+1,started_at=now(),finished_at=NULL,retry_at=NULL,updated_at=now()",[job.key]);
   try{const ids=await job.run();await pool.query("UPDATE job_runs SET state='done',error=NULL,report_ids=$2,finished_at=now(),updated_at=now() WHERE job_key=$1",[job.key,JSON.stringify(ids)]);}catch{await pool.query("UPDATE job_runs SET state='failed',error='Задание не завершено. Сохранённые снимки остаются в архиве. Повтор не создаёт их дубликаты.',retry_at=$2,finished_at=now(),updated_at=now() WHERE job_key=$1",[job.key,new Date(now.getTime()+60000*Math.pow(2,previous?.attempts||0)).toISOString()]);}
  }
 }finally{if(acquired)await lock.query('SELECT pg_advisory_unlock(431010)');lock.release();}
}
export async function retryJob(user:User,key:string){
 assert(user.role==='admin',403,'Повтор запускает администратор.');
 assert(['initial:baseline','reports-v5:morning:'+businessDay(new Date()),'reports-v5:evening:'+businessDay(new Date())].includes(key),400,'Прошлые дни нельзя восстановить текущими данными. Создайте свежий отчёт.');
 await transaction(async db=>{const r=await db.query("UPDATE job_runs SET attempts=0,retry_at=NULL WHERE job_key=$1 AND state='failed'",[key]);assert(r.rowCount,409,'Задание уже завершено или ещё выполняется.');await event(db,null,user.id,'report_retry','Запрошен повтор формирования отчётов',{key});});
}
export function startAutomation(){let running=false;const run=async()=>{if(running)return;running=true;try{await tick();}catch{console.error('Automation tick failed');}finally{running=false;}};const timer=setInterval(run,30000);timer.unref();void run();return ()=>clearInterval(timer);}
