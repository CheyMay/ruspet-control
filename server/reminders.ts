import {makeReport} from './service.js';
import {reportText} from './report-content.js';
import {reportScope} from './reports-v5.js';
import type {ReportLink} from '../shared/report-links.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,reportTransaction,type Db} from './db.js';
import {assert,canSee,canEdit} from './domain.js';
import {event,visibleTasks} from './service.js';
import {businessDay,taskQueue,elapsedToday} from '../shared/queues.js';
import type {User,Task} from '../shared/types.js';

export const reminderInput=z.object({
 recipientId:z.string().min(1).max(100),
 days:z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(a=>new Set(a).size===a.length),
 times:z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1).max(8).refine(a=>new Set(a).size===a.length),
 weeks:z.number().int().min(1).max(52),
});
export type ReminderInput=z.infer<typeof reminderInput>;
export type TaskReminder=Omit<ReminderInput,'recipientId'>&{id:string;task_id:string;recipient_id:string;created_by:string;start_date:string;enabled:boolean;version:number};
async function task(db:Db,u:User,id:string,lock=false){const t=(await db.query('SELECT * FROM tasks WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0] as Task;assert(t&&canSee(u,t),404,'Задача недоступна.');return t;}
export async function listTaskReminders(u:User,id:string){return transaction(async db=>{
 const t=await task(db,u,id);
 const schedules=(await db.query('SELECT * FROM task_reminders WHERE task_id=$1 AND (recipient_id=$2 OR created_by=$2 OR $3) ORDER BY created_at',[id,u.id,canEdit(u,t)])).rows;
 const alerts=(await db.query('SELECT a.id,kind,recipient_id,body,due_at,acknowledged_at,canceled_at,(SELECT state FROM task_alert_deliveries WHERE alert_id=a.id ORDER BY created_at DESC LIMIT 1) delivery_state FROM task_alerts a WHERE task_id=$1 AND (recipient_id=$2 OR $3) ORDER BY due_at DESC LIMIT 30',[id,u.id,canEdit(u,t)])).rows;
 const bound=(await db.query('SELECT user_id FROM telegram_binding WHERE user_id=ANY($1)',[[u.id,t.assignee_id]])).rows.map(r=>r.user_id);
 return {schedules,alerts,bound};
});}
export async function saveTaskReminder(u:User,id:string,raw:ReminderInput){const input=reminderInput.parse(raw);return transaction(async db=>{
 const t=await task(db,u,id,true);assert(t.status!=='completed',409,'Задача уже завершена.');
 assert(input.recipientId===u.id||input.recipientId===t.assignee_id&&canEdit(u,t),403,'Напоминание другому исполнителю назначает постановщик или руководитель.');
 const recipient=(await db.query('SELECT * FROM users WHERE id=$1',[input.recipientId])).rows[0];assert(recipient&&canSee(recipient,t),403,'Получателю задача недоступна.');
 const normalizedDays=[...input.days].sort((a,b)=>a-b),normalizedTimes=[...input.times].sort(),start=businessDay(new Date());
 const existing=(await db.query('SELECT id FROM task_reminders WHERE task_id=$1 AND recipient_id=$2 AND enabled AND days=$3 AND times=$4 AND start_date=$5 AND weeks=$6',[id,input.recipientId,normalizedDays,normalizedTimes,start,input.weeks])).rows[0];if(existing)return {id:existing.id};
 const count=(await db.query('SELECT count(*)::int n FROM task_reminders WHERE task_id=$1 AND enabled',[id])).rows[0].n;assert(count<20,400,'У задачи уже 20 активных расписаний.');
 const key=randomUUID();await db.query('INSERT INTO task_reminders(id,task_id,recipient_id,created_by,days,times,start_date,weeks) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[key,id,input.recipientId,u.id,normalizedDays,normalizedTimes,start,input.weeks]);
 await event(db,id,u.id,'reminder_scheduled','Назначено напоминание по задаче',{reminderId:key,...input});return {id:key};
});}
export async function disableTaskReminder(u:User,id:string){return transaction(async db=>{
 const r=(await db.query('SELECT * FROM task_reminders WHERE id=$1 FOR UPDATE',[id])).rows[0];assert(r,404,'Напоминание не найдено.');const t=await task(db,u,r.task_id);
 assert(r.recipient_id===u.id||r.created_by===u.id||canEdit(u,t),403,'Нет права отменить напоминание.');
 if(r.enabled){await db.query('UPDATE task_reminders SET enabled=false,version=version+1 WHERE id=$1',[id]);await db.query('UPDATE task_alerts SET canceled_at=now() WHERE reminder_id=$1 AND acknowledged_at IS NULL AND canceled_at IS NULL',[id]);await event(db,t.id,u.id,'reminder_disabled','Расписание напоминаний выключено',{reminderId:id});}
 return {ok:true};
});}
export async function acknowledgeAlert(u:User,id:string){return transaction(async db=>{
 const r=(await db.query('SELECT * FROM task_alerts WHERE id=$1 FOR UPDATE',[id])).rows[0];assert(r&&r.recipient_id===u.id,404,'Напоминание недоступно.');
 if(r.task_id)await task(db,u,r.task_id);assert(!r.canceled_at,409,'Напоминание уже отменено.');
 if(!r.acknowledged_at){await db.query('UPDATE task_alerts SET acknowledged_at=now() WHERE id=$1',[id]);await event(db,r.task_id,u.id,'reminder_acknowledged','Подтверждено получение напоминания. Это не выполнение задачи.',{alertId:id,dueAt:r.due_at,kind:r.kind});}
 return {ok:true};
});}
export async function userAlerts(u:User){const allowed=(await visibleTasks(u)).map(t=>t.id);return (await pool.query('SELECT a.id,task_id,kind,body,due_at,acknowledged_at,canceled_at,(SELECT state FROM task_alert_deliveries WHERE alert_id=a.id ORDER BY created_at DESC LIMIT 1) delivery_state FROM task_alerts a WHERE recipient_id=$1 AND (task_id IS NULL OR task_id=ANY($2)) AND (report_id IS NULL OR EXISTS(SELECT 1 FROM reports r WHERE r.id=a.report_id AND r.scope=$3)) ORDER BY due_at DESC LIMIT 100',[u.id,allowed,reportScope(u)])).rows;}
const at=(day:string,time:string)=>new Date(day+'T'+time+':00+03:00');
async function add(db:Db,recipient:string,key:string,kind:string,body:string,due:Date,expires:Date,taskId:string|null=null,reminderId:string|null=null,reportId:string|null=null,links:ReportLink[]=[]){
 await db.query('INSERT INTO task_alerts(id,dedupe_key,recipient_id,task_id,reminder_id,kind,body,due_at,expires_at,report_id,links) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(dedupe_key) DO NOTHING',[randomUUID(),key,recipient,taskId,reminderId,kind,body,due.toISOString(),expires.toISOString(),reportId,JSON.stringify(links)]);
}
/** Persist current-day alerts independently of report scheduling. Multiple workers are safe. */
export async function tickTaskReminders(now=new Date()){
 await reportTransaction('task-alert-tick',async db=>{
  const cfg=(await db.query('SELECT enabled,delivery FROM telegram_settings WHERE id=1')).rows[0];if(!cfg?.enabled||!cfg.delivery)return;
  const day=businessDay(now),shifted=new Date(now.getTime()+10800000),weekday=shifted.getUTCDay()||7,hhmm=shifted.toISOString().slice(11,16),expires=new Date(at(day,'00:00').getTime()+86400000);
  const schedules=(await db.query('SELECT r.*,row_to_json(t) task,row_to_json(u) recipient FROM task_reminders r JOIN tasks t ON t.id=r.task_id JOIN users u ON u.id=r.recipient_id WHERE r.enabled')).rows;
  for(const r of schedules){
   if(r.task.status==='completed'||r.task.assignee_id!==r.recipient_id&&r.recipient_id!==r.created_by||!canSee(r.recipient,r.task)){await db.query('UPDATE task_alerts SET canceled_at=$2 WHERE reminder_id=$1 AND acknowledged_at IS NULL AND canceled_at IS NULL',[r.id,now.toISOString()]);continue;}
   const delta=Math.floor((at(day,'00:00').getTime()-at(r.start_date,'00:00').getTime())/86400000);
   if(delta<0||delta>r.weeks*7||!r.days.includes(weekday))continue;
   for(const time of r.times){const due=at(day,time);if(time>hhmm||due.getTime()<Date.parse(r.created_at)||due.getTime()>=Date.parse(r.created_at)+r.weeks*7*86400000)continue;
    await add(db,r.recipient_id,`task:${r.id}:${day}:${time}`,'task',`Напоминание по задаче #${r.task.id}\n${r.task.title.slice(0,400)}\nНажмите «ОК, увидел» и приступите к задаче либо назначьте новое напоминание.`,due,expires,r.task_id,r.id);
   }
  }
  if(weekday<=5){
   const people=(await db.query('SELECT u.*,b.paired_at FROM telegram_binding b JOIN users u ON u.id=b.user_id')).rows;
   for(const u of people){
    const tasks=(await visibleTasks(u,db)).filter(t=>u.role!=='employee'||t.assignee_id===u.id),remaining=tasks.filter(t=>taskQueue(t,now)==='overdue'||elapsedToday(t,now));
    const sendReport=async(kind:string,key:string,alertKind:string,due:Date,until:Date)=>{const r=await makeReport(u,kind,key,now);const content=reportText(r);await add(db,u.id,key,alertKind,content.text,due,until,null,null,r.id,content.links);};
    if(hhmm>='09:00'&&hhmm<'12:00'&&Date.parse(u.paired_at)<=at(day,'09:00').getTime())await sendReport('snapshot',`morning:${u.id}:${day}`,'morning',at(day,'09:00'),at(day,'12:00'));
    if(!remaining.length)await db.query("UPDATE task_alerts SET canceled_at=$2 WHERE recipient_id=$1 AND kind='noon' AND acknowledged_at IS NULL AND canceled_at IS NULL",[u.id,now.toISOString()]);
    if(hhmm>='12:00'&&remaining.length&&Date.parse(u.paired_at)<=at(day,'12:00').getTime())await sendReport('overdue',`noon:${u.id}:${day}`,'noon',at(day,'12:00'),expires);
    if(hhmm>='19:01'&&Date.parse(u.paired_at)<=at(day,'19:01').getTime())await sendReport('daily',`evening:${u.id}:${day}`,'evening',at(day,'19:01'),expires);

   }
  }
 });
}

export async function pendingAlerts(u:User,now=new Date(),limit:number|null=5){
 const allowed=(await visibleTasks(u)).filter(t=>t.status!=='completed').map(t=>t.id);
 return (await pool.query('SELECT a.* FROM task_alerts a WHERE recipient_id=$1 AND acknowledged_at IS NULL AND canceled_at IS NULL AND due_at<=$2 AND expires_at>$2 AND (task_id IS NULL OR task_id=ANY($3)) AND (report_id IS NULL OR EXISTS(SELECT 1 FROM reports r WHERE r.id=a.report_id AND r.scope=$4)) AND NOT EXISTS(SELECT 1 FROM task_alert_deliveries d WHERE d.alert_id=a.id AND (d.state IN (\'sending\',\'uncertain\') OR d.created_at>$2::timestamptz-interval \'30 minutes\')) ORDER BY due_at LIMIT $5',[u.id,now.toISOString(),allowed,reportScope(u),limit])).rows;
}
