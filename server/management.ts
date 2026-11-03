import {randomUUID} from 'node:crypto';
import {pool,transaction} from './db.js';
import {visibleTasks,event,notify} from './service.js';
import {assert,canManage} from './domain.js';
import {summarize} from '../shared/analytics.js';
import type {User} from '../shared/types.js';

export async function managementProgress(u:User,range:{from?:string;to?:string;owner?:string}={}){
 assert(canManage(u),403,'Раздел доступен руководителю.');
 const mark=(await pool.query('SELECT * FROM management_observations WHERE user_id=$1',[u.id])).rows[0]||null;
 const tasks=(await visibleTasks(u)).filter(t=>!range.owner||t.assignee_id===range.owner),ids=tasks.map(t=>t.id);
 const from=range.from?range.from+'T00:00:00+03:00':mark?.started_at||null;
 const to=range.to?range.to+'T23:59:59.999+03:00':new Date().toISOString();
 assert(!from||Date.parse(from)<=Date.parse(to),400,'Начало периода позже окончания.');
 const events=(await pool.query("SELECT e.*,u.name actor_name FROM task_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.task_id=ANY($1) AND ($2::timestamptz IS NULL OR e.created_at>=$2) AND e.created_at<=$3 AND NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id AND r.created_at<=$3) ORDER BY e.created_at DESC,e.id",[ids,from,to])).rows;
 const counts=(list:typeof events)=>({completed:list.filter(e=>e.kind==='task_completed').length,answers:list.filter(e=>e.kind==='explanation'||e.kind==='approval_clarification_answered').length,returned:list.filter(e=>e.kind==='review_returned').length,rejected:list.filter(e=>e.kind==='approval_rejected').length,transfers:list.filter(e=>e.kind==='deadline_changed').length,submissions:list.filter(e=>e.kind==='review_submitted').length});
 const users=(await pool.query('SELECT id,name FROM users WHERE id=ANY($1) ORDER BY name',[[...new Set(tasks.map(t=>t.assignee_id))]])).rows;
 return {mark,from,to,totals:counts(events),rows:users.map(person=>{const own=tasks.filter(t=>t.assignee_id===person.id),ownIds=new Set(own.map(t=>t.id));return {...person,...summarize(own,new Date()),...counts(events.filter(e=>ownIds.has(e.task_id))),completedNow:own.filter(t=>t.status==='completed').length}}),
  incidents:events.filter(e=>['review_returned','approval_rejected'].includes(e.kind)).slice(0,100).map(e=>({...e,title:tasks.find(t=>t.id===e.task_id)?.title})),incidentTotal:events.filter(e=>['review_returned','approval_rejected'].includes(e.kind)).length};
}
export async function resetObservation(u:User,expected:string|null){
 assert(canManage(u),403,'Контрольную отметку устанавливает руководитель.');
 return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['management:'+u.id]);
  const old=(await db.query('SELECT * FROM management_observations WHERE user_id=$1 FOR UPDATE',[u.id])).rows[0];
  assert((old?.started_at||null)===expected,409,'Отметка уже изменилась. Обновите данные.');
  const row=(await db.query('INSERT INTO management_observations(user_id,started_at) VALUES($1,clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET started_at=clock_timestamp() RETURNING *',[u.id])).rows[0];
  await event(db,null,u.id,'observation_reset','Руководитель установил новую контрольную отметку',{previous:old?.started_at||null,startedAt:row.started_at});return row;
 });
}
export async function setNudgePreference(u:User,enabled:boolean){assert(canManage(u),403,'Нет доступа.');await pool.query('INSERT INTO management_observations(user_id,playful_nudge) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET playful_nudge=$2',[u.id,enabled]);return {enabled};}
export async function nudgeTeam(u:User,confirmed:boolean){
 assert(canManage(u),403,'Нет доступа.');assert(confirmed,400,'Подтвердите отправку.');
 return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(431014)');
  const mark=(await db.query('SELECT * FROM management_observations WHERE user_id=$1 FOR UPDATE',[u.id])).rows[0];assert(mark?.playful_nudge,409,'Шуточная рассылка выключена в настройках.');
  assert(!mark.last_nudge_at||Date.now()-Date.parse(mark.last_nudge_at)>=3600000,429,'Повторная рассылка доступна через час.');
  const cfg=(await db.query('SELECT enabled,delivery FROM telegram_settings WHERE id=1')).rows[0];assert(cfg?.enabled&&cfg?.delivery,409,'Доставка Telegram выключена.');
  const owners=[...new Set((await visibleTasks(u,db)).filter(t=>t.status!=='completed').map(t=>t.assignee_id))];
  const recipients=(await db.query('SELECT DISTINCT user_id FROM telegram_binding WHERE user_id=ANY($1) AND user_id<>$2',[owners,u.id])).rows;
  assert(recipients.length,409,'В вашей команде нет подключённых получателей с незавершёнными задачами.');
  const key=randomUUID();for(const r of recipients)await notify(db,null,r.user_id,`Быстро работать! 🙂\n${u.name} напоминает о задачах. Откройте «Мои задачи», обновите результаты и ответьте на запросы.`, `management-nudge:${key}:${r.user_id}`);
  await db.query('UPDATE management_observations SET last_nudge_at=now() WHERE user_id=$1',[u.id]);await event(db,null,u.id,'team_nudged','Руководитель отправил напоминание команде',{recipients:recipients.map(r=>r.user_id)});return {recipients:recipients.length};
 });
}
