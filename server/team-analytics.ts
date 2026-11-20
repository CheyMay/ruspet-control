import {businessDay} from '../shared/queues.js';
import {localDayStart,nextBusinessDay} from '../shared/report-parameters.js';
import type {AnalyticsGroup,AnalyticsNumbers,AnalyticsOverview,AnalyticsRow,CompletedWork} from '../shared/team-analytics.js';
import type {Task,User} from '../shared/types.js';
import {loadAnalyticsScope} from './analytics-scope.js';
import {transaction,type Db} from './db.js';
import {assert} from './domain.js';
import {hasPendingTaskApproval} from './pending-task-work.js';

const dayMs=86400000;
const offsetDay=(day:string,days:number)=>businessDay(new Date(+localDayStart(day)+days*dayMs));
const mondayOf=(day:string)=>offsetDay(day,-((new Date(day+'T12:00:00+03:00').getUTCDay()+6)%7));
const blank=():AnalyticsNumbers=>({
 remaining:{total:0,overdue:0,today:0,nextWorkday:0},
 completed:{total:0,overdue:0,today:0,nextWorkday:0,later:0,withoutDeadline:0},
 approvals:0,review:0
});

type DeadlineBucket=Exclude<keyof CompletedWork,'total'>;
function deadlineBucket(deadline:string|null,day:string,next:string,at:Date,completed=false):DeadlineBucket{
 if(!deadline)return 'withoutDeadline';
 const due=Date.parse(deadline);
 if(!Number.isFinite(due))return 'withoutDeadline';
 if(completed?due<+at:due<=+at)return 'overdue';
 const dueDay=businessDay(deadline);
 if(dueDay===day)return 'today';
 return dueDay<=next?'nextWorkday':'later';
}

type Closure={task_id:string;created_at:string;before:{deadline:string|null}|null;after:Partial<Task>|null};
async function closures(db:Db,ids:string[],from:Date,now:Date){
 const {rows}=await db.query<Closure>(`SELECT DISTINCT ON (e.task_id) e.task_id,e.created_at,
 CASE WHEN (e.data->'before') ? 'deadline' THEN jsonb_build_object('deadline',e.data->'before'->'deadline') END AS before,
 jsonb_build_object('assignee_id',e.data->'after'->>'assignee_id','branch_id',e.data->'after'->>'branch_id',
 'title',e.data->'after'->>'title','completed_at',e.data->'after'->>'completed_at') AS after
 FROM task_events e
 WHERE e.task_id=ANY($1::text[]) AND e.created_at BETWEEN $2 AND $3
 AND (e.kind='task_completed' OR (e.kind IN ('bitrix_change','source_refreshed','action_undone')
  AND e.data->'after'->>'status'='completed' AND e.data->'before'->>'status'<>'completed'))
 AND NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id AND r.created_at<=$3)
 ORDER BY e.task_id,e.created_at DESC,e.id DESC`,[ids,from.toISOString(),now.toISOString()]);
 return new Map(rows.map(row=>[row.task_id,row]));
}

export async function analyticsOverview(user:User,selection:string[],period:'day'|'week',now=new Date()):Promise<AnalyticsOverview>{
 return transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const scope=await loadAnalyticsScope(user,db);
  const candidates=(await db.query<Task&{pending:boolean}>(`SELECT
   t.id,t.title,t.branch_id,t.assignee_id,t.created_at,t.completed_at,t.status,t.deadline,
   (t.status<>'completed' AND ${hasPendingTaskApproval}) AS pending FROM tasks t`)).rows.filter(scope.visible);
  const date=businessDay(now),nextWorkday=nextBusinessDay(date);
  const first=period==='week'?mondayOf(date):date,start=localDayStart(first);
  const history=await closures(db,candidates.filter(t=>t.status==='completed'&&(!t.completed_at||Date.parse(t.completed_at)>=+start)).map(t=>t.id),start,now);
  const paths=new Map<string,AnalyticsGroup[]>(),groups=new Map<string,AnalyticsRow>();
  const dayCounts=new Map<string,number>(),numbers=blank();
  function count(task:Task,add:(numbers:AnalyticsNumbers)=>void){
   const path=scope.path(task);
   for(let depth=1;depth<=path.length;depth++)paths.set(JSON.stringify(path.slice(0,depth).map(p=>p.key)),path.slice(0,depth));
   if(!selection.every((key,i)=>path[i]?.key===key))return false;
   add(numbers);
   const child=path[selection.length];
   if(child){
    const row=groups.get(child.key)??{...child,numbers:blank()};
    add(row.numbers);
    groups.set(child.key,row);
   }
   return true;
  }

  for(const task of candidates){
   if(task.status==='completed'){
    const event=history.get(task.id),at=new Date(task.completed_at??event?.created_at??'');
    if(!Number.isFinite(+at)||+at<+start||+at>+now){count(task,()=>{});continue;}
    const after=event?.after,occurred=after?.completed_at?Date.parse(after.completed_at):Date.parse(event?.created_at??'');
    const matching=!!event&&(occurred===+at||!after?.completed_at&&Math.abs(occurred-(+at))<=60_000);
    const owner=matching&&after?.assignee_id&&after.branch_id?{...task,assignee_id:after.assignee_id,branch_id:after.branch_id,title:after.title??task.title}:task;
    if(!scope.visible(owner))continue;
    const deadline=matching&&event?.before?event.before.deadline:task.deadline;
    const day=businessDay(at),kind=deadlineBucket(deadline,day,nextBusinessDay(day),at,true);
    if(count(owner,n=>{n.completed[kind]++;n.completed.total++;}))dayCounts.set(day,(dayCounts.get(day)??0)+1);
    continue;
   }
   if(task.pending){count(task,n=>{n.approvals++;});continue;}
   if(task.status==='review'){count(task,n=>{n.review++;});continue;}
   const kind=deadlineBucket(task.deadline,date,nextWorkday,now);
   count(task,n=>{
    if(kind==='overdue'||kind==='today'||kind==='nextWorkday'){n.remaining[kind]++;n.remaining.total++;}
   });
  }

  const path=selection.length?paths.get(JSON.stringify(selection)):[];
  assert(path,404,'Этот отдел или сотрудник сейчас недоступен в вашей области.');
  const {rows:[source]}=await db.query<{tracking:string|null;delayed:boolean}>(`SELECT
   (SELECT max(imported_at) FROM import_batches) tracking, EXISTS(SELECT 1 FROM bitrix_refresh_queue q
    JOIN bitrix_task_links l ON l.external_id::text=q.external_id WHERE l.task_id=ANY($1)
    AND q.resource IN ('task_inbound','task_inbound_new') AND q.state IN ('pending','processing','failed','blocked')
    AND q.updated_at<$2::timestamptz-interval '5 minutes') delayed`,[candidates.map(t=>t.id),now.toISOString()]);
  const days=[];
  if(period==='week')for(let day=first;day<=date;day=offsetDay(day,1)){
   if(day===date||!source.tracking||Date.parse(source.tracking)<+localDayStart(day)+dayMs||dayCounts.has(day))
    days.push({date:day,completed:dayCounts.get(day)??0});
  }
  const rows=[...groups.values()].filter(({numbers:n})=>n.remaining.total||n.completed.total||n.approvals||n.review)
   .sort((a,b)=>b.numbers.remaining.overdue-a.numbers.remaining.overdue||b.numbers.remaining.total-a.numbers.remaining.total||a.label.localeCompare(b.label,'ru'));
  return {access:scope.access,scope:scope.label,path,rows,numbers,days,
   generatedAt:now.toISOString(),date,nextWorkday,historyFrom:source.tracking,
   partialHistory:!!source.tracking&&Date.parse(source.tracking)>+start,bitrixDelay:source.delayed};
 });
}
