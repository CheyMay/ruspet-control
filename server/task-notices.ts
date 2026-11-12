import {randomUUID} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {canSee} from './domain.js';
import {button,htmlScreen} from './bot-ui.js';
import {botDue} from './bot-presentation.js';
import {businessDay} from '../shared/queues.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {escapeHtml as h} from '../shared/report-links.js';
import type {Task,User} from '../shared/types.js';

const minute=60_000,repeatEvery=30*minute,assignmentWindow=10*minute;
type TodaySlot='morning'|'afternoon'|'last_hour';
type NoticeRecord={created_at:string;task_notice:{overdue:boolean;today:TodaySlot[]}};
type Assignment={id:string;task_id:string;created_at:string};
type TaskNotice={overdue:Task[];elapsedToday:Task[];today:Task[];assignments:Task[]};

function deadlinePlan(tasks:Task[],now:Date,previous:NoticeRecord[]){
 const day=businessDay(now),hour=new Date(+now+3*60*minute).getUTCHours();
 const workingHours=hour>=9&&hour<19;
 const recent=previous.filter(row=>Date.parse(row.created_at)>+now-repeatEvery);
 const dated=tasks.filter(task=>task.deadline).sort((a,b)=>a.deadline!.localeCompare(b.deadline!)||a.id.localeCompare(b.id));
 const late=workingHours&&!recent.some(row=>row.task_notice.overdue)?dated.filter(task=>Date.parse(task.deadline!)<=+now):[];
 const today=workingHours?dated.filter(task=>businessDay(task.deadline!)===day&&Date.parse(task.deadline!)>+now):[];
 const sent=new Set(previous.flatMap(row=>row.task_notice.today));
 const todaySlots:TodaySlot[]=[];
 if(today.length&&!recent.some(row=>row.task_notice.today.length)){
  const part=hour<14?'morning':'afternoon';
  if(!sent.has(part))todaySlots.push(part);
  if(Date.parse(today[0].deadline!)<=+now+60*minute&&!sent.has('last_hour'))todaySlots.push('last_hour');
 }
 return {
  overdue:late.filter(task=>businessDay(task.deadline!)<day),
  elapsedToday:late.filter(task=>businessDay(task.deadline!)===day),
  today:todaySlots.length?today:[],
  todaySlots
 };
}

function readyAssignments(rows:Assignment[],now:Date){
 if(!rows.length)return [];
 const closes=Date.parse(rows[0].created_at)+assignmentWindow;
 if(+now<closes)return [];
 // After downtime, deliver matured batches together.
 const cutoff=Math.max(closes,+now-assignmentWindow);
 return rows.filter(row=>Date.parse(row.created_at)<=cutoff);
}

async function planNotice(db:Db,user:User,now:Date,previous:NoticeRecord[],channel:'web'|'telegram',since:string|null){
  const tasks=(await db.query<Task>(`SELECT t.* FROM tasks t
   WHERE t.assignee_id=$1 AND t.status='active'
    AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.state='pending' AND a.type='completion')`,[user.id])).rows.filter(task=>canSee(user,task));
  if(!tasks.length)return null;

  const stamp=now.toISOString(),byId=new Map(tasks.map(task=>[task.id,task]));
  const {overdue,elapsedToday,today,todaySlots}=deadlinePlan(tasks,now,previous);
  const alreadyDelivered=channel==='telegram'?'SELECT 1 FROM telegram_delivery d WHERE d.outbox_ids ? o.id::text':
   "SELECT 1 FROM outbox d WHERE d.task_notice IS NOT NULL AND (d.task_notice->'assignmentIds') ? o.id::text";
  const rows=(await db.query<Assignment>(`SELECT o.id,o.task_id,o.created_at FROM outbox o
   WHERE o.task_assignment AND o.recipient_id=$1 AND o.task_id=ANY($2) AND o.read_at IS NULL AND o.withdrawn_at IS NULL
    AND o.created_at BETWEEN greatest($3::timestamptz,$4::timestamptz-interval '2 days') AND $4
    AND NOT EXISTS(${alreadyDelivered})
   ORDER BY o.created_at,o.id`,[user.id,[...byId.keys()],since,stamp])).rows;
  const ready=readyAssignments(rows,now),hasOverdue=!!(overdue.length||elapsedToday.length);
  if(!hasOverdue&&!today.length&&!ready.length)return null;

  const assignments=[...new Set(ready.map(row=>row.task_id))].map(taskId=>byId.get(taskId)!);
  return {notice:{overdue,elapsedToday,today,assignments},overdue:hasOverdue,today:todaySlots,assignmentIds:ready.map(row=>row.id)};
}

export async function claimTelegramTaskNotice(user:User,chatId:string,now:Date):Promise<(TaskNotice&{id:string})|null>{
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['telegram-task-notice:'+user.id]);
  const settings=(await db.query<{since:string}>(`SELECT greatest(b.paired_at,s.task_delivery_enabled_at) AS since
   FROM telegram_binding b JOIN telegram_settings s ON s.id=1 AND s.enabled AND s.task_delivery
   LEFT JOIN notification_preferences p ON p.user_id=b.user_id
   WHERE b.user_id=$1 AND b.chat_id=$2 AND COALESCE(p.telegram_digest,true)
    AND (NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=b.user_id)
     OR EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=b.user_id AND a.enabled))`,[user.id,chatId])).rows[0];
  if(!settings)return null;
  const stamp=now.toISOString(),dayStart=businessDay(now)+'T00:00:00+03:00';
  const previous=(await db.query<NoticeRecord>(`SELECT created_at,task_notice FROM telegram_delivery
   WHERE chat_id=$1 AND task_notice IS NOT NULL AND task_notice->>'userId'=$2 AND created_at BETWEEN $3 AND $4`,[chatId,user.id,dayStart,stamp])).rows;
  const plan=await planNotice(db,user,now,previous,'telegram',settings.since);
  if(!plan)return null;
  const id=randomUUID();
  await db.query(`INSERT INTO telegram_delivery(id,chat_id,outbox_ids,state,created_at,task_notice)
   VALUES($1,$2,$3,'sending',$4,$5)`,[id,chatId,JSON.stringify(plan.assignmentIds),stamp,
   JSON.stringify({userId:user.id,overdue:plan.overdue,today:plan.today})]);
  return {id,...plan.notice};
 });
}

function noticeContent(notice:TaskNotice,now:Date){
 const deadlines=[...notice.overdue,...notice.elapsedToday,...notice.today];
 const topDeadlines=[...notice.overdue.slice(0,3),...notice.elapsedToday.slice(0,3),...notice.today.slice(0,3)];
 const assigned=new Set(notice.assignments.map(task=>task.id)),shown=new Set(topDeadlines.map(task=>task.id));
 const onlyNew=notice.assignments.filter(task=>!shown.has(task.id));
 const sections:{heading:string;lines:string[]}[]=[];
 const add=(label:string,tasks:Task[],total=tasks.length,listedAbove=0)=>{
  if(!total)return;
  const lines=tasks.slice(0,3).map(task=>{
   const facts=['#'+task.id,compactTaskTitle(task.title,84)];
   if(task.deadline)facts.push(botDue(task,now));
   if(assigned.has(task.id)&&shown.has(task.id))facts.push('новая');
   return facts.join(' · ');
  });
  if(tasks.length>3)lines.push('Ещё '+(tasks.length-3)+' в списке');
  if(listedAbove)lines.push(listedAbove+' уже в списке сроков выше');
  sections.push({heading:label+' · '+total,lines});
 };
 add('Просрочены с прошлых дней',notice.overdue);
 add('Время истекло сегодня',notice.elapsedToday);
 add('Крайний срок сегодня',notice.today);
 add('Новые задачи',onlyNew,notice.assignments.length,notice.assignments.length-onlyNew.length);

 const taskIds=[...topDeadlines,...onlyNew.slice(0,3)].slice(0,5).map(task=>task.id);
 return {sections,taskIds,hasDeadlines:!!deadlines.length,hasAssignments:!!assigned.size};
}

export async function taskNoticeScreen(user:User,ch:string,notice:TaskNotice,now:Date){
 const {sections,taskIds,hasDeadlines,hasAssignments}=noticeContent(notice,now);
 const buttons=taskIds.map(id=>button('#'+id,'task',{id}));
 return htmlScreen(user,ch,sections.map(s=>'<b>'+h(s.heading)+'</b>\n'+s.lines.map(h).join('\n')).join('\n\n'),[
  ...Array.from({length:Math.ceil(buttons.length/3)},(_,i)=>buttons.slice(i*3,i*3+3)),
  [...(hasDeadlines?[button('Мои сроки','tasks',{filter:'my_due'})]:[]),...(hasAssignments?[button('Мои задачи','tasks',{filter:'mine'})]:[])]
 ]);
}

export async function generateWebTaskNotices(now=new Date()){
 const users=(await pool.query<User>(`SELECT u.* FROM users u
  WHERE EXISTS(SELECT 1 FROM tasks t WHERE t.assignee_id=u.id AND t.status='active')
   AND (EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)
    OR (NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id)
     AND EXISTS(SELECT 1 FROM sessions s WHERE s.user_id=u.id AND s.expires_at>now())))`)).rows;
 for(const user of users)await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['web-task-notice:'+user.id]);
  const stamp=now.toISOString(),dayStart=businessDay(now)+'T00:00:00+03:00';
  const previous=(await db.query<NoticeRecord>(`SELECT created_at,task_notice FROM outbox
   WHERE recipient_id=$1 AND task_notice IS NOT NULL AND created_at BETWEEN $2 AND $3`,[user.id,dayStart,stamp])).rows;
  const plan=await planNotice(db,user,now,previous,'web',null);
  if(!plan)return;
  const id=randomUUID(),{sections,taskIds,hasDeadlines,hasAssignments}=noticeContent(plan.notice,now);
  const body=sections.map(section=>[section.heading,...section.lines].join('\n')).join('\n\n');
  const metadata={overdue:plan.overdue,today:plan.today,assignmentIds:plan.assignmentIds,taskIds,hasDeadlines,hasAssignments};
  await db.query('INSERT INTO outbox(id,recipient_id,body,dedupe_key,created_at,task_notice) VALUES($1,$2,$3,$4,$5,$6)',
   [id,user.id,body,'web-task-notice:'+id,stamp,JSON.stringify(metadata)]);
 });
}
