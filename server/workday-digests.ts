import {pool} from './db.js';
import {managementNotice} from './management-notices.js';
import {makeReport} from './service.js';
import {businessDay} from '../shared/queues.js';
import {localDayStart} from '../shared/report-parameters.js';
import {compactTaskTitle} from '../shared/task-title.js';
import type {User} from '../shared/types.js';

export async function prepareWorkdayDigests(now:Date){
 const day=businessDay(now);
 const people=(await pool.query<User&{plan:boolean;creator:boolean}>(`WITH scope AS (
  SELECT staff_work_ids() ids
 ), work AS (
  SELECT t.assignee_id,t.creator_id,t.status FROM tasks t CROSS JOIN scope s
  WHERE t.creator_id<>t.assignee_id AND (s.ids IS NULL OR t.assignee_id=ANY(s.ids))
   AND (t.status IN ('active','review') OR t.completed_at BETWEEN $1 AND $2)
 )
 SELECT u.*,flags.plan,flags.creator FROM users u CROSS JOIN scope s
 CROSS JOIN LATERAL (SELECT
  EXISTS(SELECT 1 FROM work w WHERE w.assignee_id=u.id AND w.status IN ('active','review')) AS plan,
  EXISTS(SELECT 1 FROM work w WHERE w.creator_id=u.id AND w.assignee_id<>u.id) AS creator
 ) flags
 WHERE (s.ids IS NULL OR u.id=ANY(s.ids)) AND (flags.plan OR flags.creator)
  AND (EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)
   OR (NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id) AND EXISTS(SELECT 1 FROM telegram_binding b WHERE b.user_id=u.id)))
 ORDER BY u.id`,[localDayStart(day).toISOString(),now.toISOString()])).rows;
 const ids:string[]=[];
 for(const person of people){
  const plan=person.plan?await makeReport(person,'nextday','scheduled-workday-plan',now,{view:'mine'},true):null;
  const placed=person.creator?await makeReport(person,'daily','scheduled-workday-created',now,{view:'created'},true):null;
  const lines=['РУСПЭТ · Итоги рабочего дня'];
  if(plan?.summary?.stateAvailable){
   const next=plan.summary.tomorrow;
   const date=new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long',timeZone:'Europe/Moscow'}).format(new Date(next.day+'T12:00:00+03:00'));
   lines.push('План · '+date, next.total?`Начать с просрочек · ${next.overdue}. Срок в этот день · ${next.today}.`:'Задач с крайним сроком на этот день или раньше сейчас нет.');
   for(const task of plan.rows.slice(0,3))lines.push('#'+task.id+' · '+compactTaskTitle(task.title,80));
  }
  if(placed?.summary?.stateAvailable&&placed.summary.creatorProgress){
   const p=placed.summary.creatorProgress;
   lines.push('Мои поставленные задачи',
    `Открыто · ${p.openIds.length}. Были действия · ${p.movedIds.length}. Завершено · ${placed.summary.activity.closed}.`,
    `Просрочены без действий · ${p.idleOverdueIds.length}. Ждут моего решения · ${p.myDecisionIds.length}.`);
  }
  if(plan||placed){
   if(lines.length===1)lines.push('Сводка доступна в отчётах.');
   await managementNotice(pool,person.id,lines.join('\n'),'workday:'+day+':'+person.id,
    {kind:'workday',...(plan?{planReportId:plan.id}:{}),...(placed?{creatorReportId:placed.id}:{})},now);
   if(plan)ids.push(plan.id);
   if(placed)ids.push(placed.id);
  }
 }
 return ids;
}
