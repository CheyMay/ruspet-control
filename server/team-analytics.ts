import {activeTaskApproval,approvalTurn,taskNextAction} from '../shared/actions.js';
import {businessDay} from '../shared/queues.js';
import {localDayStart} from '../shared/report-parameters.js';
import {reportOutcome} from '../shared/report-summary.js';
import {analyticsMetricLabels,type AnalyticsAttention,type AnalyticsGroup,type AnalyticsMetric,type AnalyticsNumbers,type AnalyticsOverview,type AnalyticsTask} from '../shared/team-analytics.js';
import type {Approval,Event,Task,User} from '../shared/types.js';
import {loadAnalyticsScope} from './analytics-scope.js';
import {approvalHierarchy,approvalScope} from './approval-hierarchy.js';
import {pool,transaction,type Db} from './db.js';
import {assert,canSee} from './domain.js';
import {stateAt} from './reports-v5.js';

const dayMs=86400000;
const fields=['id','title','branch_id','assignee_id','creator_id','deadline','status','version','created_at','updated_at','completed_at'];
const taskFields=fields.map(field=>'t.'+field).join(',');
const jsonSnapshot=(field:string)=>{
 const src=`e.data->'${field}'`;
 return `CASE WHEN ${src}->>'id' IS NOT NULL THEN jsonb_build_object(${fields.map(k=>`'${k}',${src}->'${k}'`).join(',')}) END`;
};
const movement=new Set(['assignment_accepted','review_submitted','task_completed','approval_requested','deadline_changed','approval_clarification_answered','explanation']);
const closureMetrics=new Set<AnalyticsMetric>(['closedAll','onTime','late','unknown']);
const keys=Object.keys(analyticsMetricLabels) as AnalyticsMetric[];
const blank=()=>Object.fromEntries(keys.map((key):[AnalyticsMetric,string[]]=>[key,[]])) as AnalyticsNumbers;
type ObservedTask={task:Task;flags:Set<AnalyticsMetric>;path:AnalyticsGroup[]};
type TimelineEvent=Event&{retracted_at:string|null};
type Waiting={
 next:string|null;personId:string|null;since:string|null;waiting:boolean;unaccepted:boolean;
};
const snapshot=(e:Event,key:'before'|'after'|'initialSnapshot')=>e.data[key] as Task|undefined;
const compareDeadline=(a:ObservedTask,b:ObservedTask)=>
  Date.parse(a.task.deadline??'9999-01-01')-Date.parse(b.task.deadline??'9999-01-01')||a.task.id.localeCompare(b.task.id,'ru',{numeric:true});
const sameOrBelow=(path:AnalyticsGroup[],branch:string[])=>branch.every((key,i)=>path[i]?.key===key);
const dayOffset=(date:string,days:number)=>businessDay(new Date(+localDayStart(date)+days*dayMs));

async function loadCurrentTurns(db:Db,tasks:Task[]){
 const ids=tasks.filter(t=>t.status!=='completed').map(t=>t.id);
 const hierarchy=approvalScope(await approvalHierarchy(db));
 const approvals=(await db.query<Approval&{step_at:string|null}>(`SELECT a.*,
   (SELECT max(e.created_at) FROM task_events e WHERE e.task_id=a.task_id AND e.kind='step_approved'
    AND e.data->>'approvalId'=a.id::text AND NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id)) step_at
  FROM approvals a WHERE a.task_id=ANY($1) AND a.state='pending' AND a.canceled_at IS NULL`,[ids])).rows;
 const review=new Map((await db.query<{task_id:string;since:string}>(`SELECT task_id,max(submitted_at) since FROM task_submissions
  WHERE task_id=ANY($1) AND state='review' AND withdrawn_at IS NULL GROUP BY task_id`,[ids])).rows.map(r=>[r.task_id,r.since]));
 const unaccepted=new Set((await db.query<{task_id:string}>(`SELECT p.task_id FROM personal_task_plans p JOIN tasks t ON t.id=p.task_id
  AND t.assignment_epoch=p.assignment_epoch AND t.assignee_id=p.user_id
  WHERE p.task_id=ANY($1) AND t.status='active' AND p.requires_acceptance AND p.accepted_at IS NULL`,[ids])).rows.map(r=>r.task_id));
 const pending=new Map(approvals.map(approval=>[approval.task_id,approval]));
 return new Map(tasks.map(t=>{
  const approval=pending.get(t.id);
  const active=approval&&activeTaskApproval(t,approval)?approval:undefined;
  const turn=taskNextAction(t,active,hierarchy);
  const clarification=active?approvalTurn(active).clarification:false;
  const appointment=unaccepted.has(t.id);
  const waiting=!!active&&!clarification||t.status==='review'&&!clarification;
  const since=active?(clarification?active.clarification_requested_at:
   [active.step_at,active.clarification_answered_at,active.created_at].filter(Boolean).sort().at(-1)??null):review.get(t.id)??null;
  return [t.id,{next:appointment&&!active?'Принять назначение':turn?.label??null,
   personId:turn?.userId??null,since,waiting,unaccepted:appointment} satisfies Waiting] as const;
 }));
}

function recordedDay(task:Task,history:TimelineEvent[],day:string,start:Date,end:Date,live:boolean,visible:(t:Task)=>boolean,turn?:Waiting){
 const current=live?task:stateAt(task,history,end);
 if(!current||!visible(current))return null;
 const isDue=(s:Task|null|undefined)=>!!s&&s.id===task.id&&visible(s)&&s.status!=='completed'&&
  !!s.deadline&&businessDay(s.deadline)<=day;
 const events=history.filter(e=>Date.parse(e.created_at)>=+start&&Date.parse(e.created_at)<=+end);
 const fullClosure=events.find(e=>reportOutcome(e)==='task_completed'&&(!e.retracted_at||Date.parse(e.retracted_at)>+end));
 const completed=Date.parse(current.completed_at??fullClosure?.created_at??'');
 const closed=current.status==='completed'&&completed>=+start&&completed<=+end;
 const open=current.status!=='completed';
 const opening=stateAt(task,history,new Date(+start-1));
 const front=(closed||open)&&(isDue(opening)||isDue(current)||
  events.some(e=>isDue(snapshot(e,'before'))||isDue(snapshot(e,'after'))||isDue(snapshot(e,'initialSnapshot')))||
  closed&&!!current.deadline&&businessDay(current.deadline)<=day);
 const flags=new Set<AnalyticsMetric>();
 if(front){
  flags.add('front');
  if(closed)flags.add('closed');
  else if(open)flags.add(isDue(current)?'remaining':'moved');
 }
 if(closed){
  flags.add('closedAll');
  const deadlineAtClose=fullClosure?snapshot(fullClosure,'before')?.deadline:null;
  flags.add(!deadlineAtClose?'unknown':completed<=Date.parse(deadlineAtClose)?'onTime':'late');
 }
 if(open&&current.deadline){
  const dueDate=businessDay(current.deadline);
  if(dueDate<day){flags.add('overdue');flags.add('earlier');}
  else if(dueDate===day){
   if(Date.parse(current.deadline)<=+end){flags.add('overdue');flags.add('expired');}
   else flags.add('due');
  }else if(live&&dueDate===dayOffset(day,1))flags.add('tomorrow');
 }
 if(live&&open&&turn){
  if(turn.unaccepted)flags.add('unaccepted');
  if(turn.waiting){
   flags.add('waiting');
   const age=turn.since?+end-Date.parse(turn.since):0;
   if(age>=2*3600000||flags.has('overdue'))flags.add('stuck');
  }else if(flags.has('overdue')&&turn.personId===current.assignee_id&&
   !events.some(e=>!e.retracted_at&&movement.has(reportOutcome(e)))){
   flags.add('idle');
  }
 }
 return {task:current,flags};
}

function lists(rows:ObservedTask[],closures?:Map<string,ObservedTask>){
 const result=blank();
 for(const row of rows)for(const key of row.flags){
  if(!closures||!closureMetrics.has(key)||closures.get(row.task.id)===row)result[key].push(row.task.id);
 }
 return result;
}

export async function analyticsOverview(user:User,selection:string[],period:'day'|'week',now=new Date()):Promise<AnalyticsOverview>{
 return transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const scope=await loadAnalyticsScope(user,db);
  const candidates=(await db.query<Task>(`SELECT ${taskFields} FROM tasks t`)).rows.filter(scope.visible);
  const date=businessDay(now),monday=dayOffset(date,-((new Date(date+'T12:00:00+03:00').getUTCDay()+6)%7));
  const first=period==='week'?monday:date;
  const ids=candidates.map(t=>t.id);
  const history=(await db.query<TimelineEvent>(`SELECT e.id,e.task_id,e.actor_id,e.kind,e.created_at,'' message,
   jsonb_build_object('before',${jsonSnapshot('before')},'after',${jsonSnapshot('after')},'initialSnapshot',${jsonSnapshot('initialSnapshot')}) data,
   r.created_at retracted_at FROM task_events e LEFT JOIN event_retractions r ON r.event_id=e.id
   WHERE e.task_id=ANY($1) AND e.created_at BETWEEN $2 AND $3
   ORDER BY e.created_at DESC,e.id DESC`,[ids,localDayStart(first).toISOString(),now.toISOString()])).rows;
  const byTask=new Map<string,TimelineEvent[]>();
  for(const e of history){
   if(!e.task_id)continue;
   const events=byTask.get(e.task_id)??[];
   events.push(e);byTask.set(e.task_id,events);
  }
  const turns=await loadCurrentTurns(db,candidates);
  const observed=new Map<string,ObservedTask[]>();
  const paths=new Map<string,AnalyticsGroup[]>();
  for(const t of candidates){
   const path=scope.path(t);
   for(let depth=1;depth<=path.length;depth++)paths.set(JSON.stringify(path.slice(0,depth).map(p=>p.key)),path.slice(0,depth));
  }
  for(let day=first;day<=date;day=dayOffset(day,1)){
   const start=localDayStart(day),live=day===date,end=live?now:new Date(+start+dayMs-1);
   const rows:ObservedTask[]=[];
   for(const task of candidates){
    const row=recordedDay(task,byTask.get(task.id)??[],day,start,end,live,scope.visible,turns.get(task.id));
    if(!row||!row.flags.size)continue;
    const path=scope.path(row.task);
    for(let depth=1;depth<=path.length;depth++)paths.set(JSON.stringify(path.slice(0,depth).map(p=>p.key)),path.slice(0,depth));
    if(sameOrBelow(path,selection))rows.push({...row,path});
   }
   observed.set(day,rows.sort(compareDeadline));
  }
  const path=selection.length?paths.get(JSON.stringify(selection)):[];
  assert(path,404,'Этот отдел или сотрудник сейчас недоступен в вашей области.');
  const current=observed.get(date)??[],dayNumbers=lists(current);
  const sourceStatus=(await db.query<{tracking:string|null;delayed:boolean}>(`SELECT
   (SELECT max(imported_at) FROM import_batches) tracking, EXISTS(SELECT 1 FROM bitrix_refresh_queue q
    JOIN bitrix_task_links l ON l.external_id::text=q.external_id WHERE l.task_id=ANY($1)
    AND q.resource IN ('task_inbound','task_inbound_new') AND q.state IN ('pending','processing','failed','blocked')
    AND q.updated_at<$2::timestamptz-interval '5 minutes') delayed`,[ids,now.toISOString()])).rows[0];
  const historyFrom=sourceStatus.tracking??history.at(-1)?.created_at??null;
  const covered=[...observed.entries()].filter(([day])=>day===date||!historyFrom||Date.parse(historyFrom)<+localDayStart(day)+dayMs);
  const isWeek=period==='week';
  const source=isWeek?covered.flatMap(([,rows])=>rows):current;
  const closingRows=isWeek?new Map(source.filter(r=>r.flags.has('closedAll')).map(row=>[row.task.id,row])):undefined;
  const groups=new Map<string,{group:AnalyticsGroup;rows:ObservedTask[];navigable:boolean}>();
  const currentRows=new Set(current);
  for(const row of source){
   const group=row.path[selection.length];
   if(!group)continue;
   const collected=groups.get(group.key)??{group,rows:[],navigable:false};
   collected.navigable ||= row.path.length>selection.length+1;
   collected.rows.push(row);
   groups.set(group.key,collected);
  }
  const rows=[...groups.values()].map(({group,rows,navigable})=>{
   const numbers=lists(rows,closingRows);
   if(isWeek)for(const kind of keys){
    if(kind==='overdue')numbers.overdue=rows.filter(r=>currentRows.has(r)&&r.flags.has('overdue')).map(r=>r.task.id);
    numbers[kind]=[...new Set(numbers[kind])];
   }
   return {...group,numbers,navigable};
  }).sort((a,b)=>b.numbers.overdue.length-a.numbers.overdue.length||b.numbers.waiting.length-a.numbers.waiting.length||a.label.localeCompare(b.label,'ru'));
  const attention:AnalyticsAttention[]=[];
  for(const row of current){
   if(!row.flags.has('stuck')&&!row.flags.has('idle'))continue;
   const {task}=row,turn=turns.get(task.id);
   const stuck=row.flags.has('stuck');
   attention.push({id:task.id,title:task.title,person:scope.byId.get(turn?.personId??task.assignee_id)?.name??'Исполнитель',
    label:stuck?turn?.next??'Ждёт решения':turn?.unaccepted?'Принять назначение':'По просрочке сегодня не было рабочих действий',
    since:stuck?turn?.since??null:task.deadline,kind:stuck?'stuck':'idle',nativeCard:canSee(user,task)});
  }
  const days=isWeek?covered.map(([day,rows])=>({date:day,numbers:lists(rows),live:day===date})):[];
  const boardNumbers={...dayNumbers};
  if(isWeek){
   const weekNumbers=lists(source,closingRows);
   for(const metric of closureMetrics)boardNumbers[metric]=weekNumbers[metric];
  }
  const focus=[...attention.filter(item=>item.kind==='stuck').slice(0,2),...attention.filter(item=>item.kind==='idle').slice(0,3)];
  return {access:scope.access,scope:scope.label,path,rows,numbers:boardNumbers,days,attention:focus,
   generatedAt:now.toISOString(),date,historyFrom,
   partialHistory:!!historyFrom&&Date.parse(historyFrom)>+localDayStart(first),bitrixDelay:sourceStatus.delayed};
 });
}

export async function analyticsTasks(user:User,ids:string[]):Promise<AnalyticsTask[]>{
 const scope=await loadAnalyticsScope(user,pool);
 const tasks=(await pool.query<Task&{last_remark:string|null}>(`SELECT ${taskFields},left(t.description,1800) description,
  (SELECT left(coalesce(nullif(e.data->>'comment',''),e.message),500) FROM task_events e
   WHERE e.task_id=t.id AND e.kind IN ('review_returned','approval_rejected')
    AND NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id)
   ORDER BY e.created_at DESC,e.id DESC LIMIT 1) last_remark
  FROM tasks t WHERE t.id=ANY($1)`,[ids])).rows.filter(scope.visible);
 const turns=await loadCurrentTurns(pool,tasks);
 const name=(id:string)=>scope.byId.get(id)?.name??'Сотрудник';
 const byId=new Map(tasks.map(t=>{
  const turn=turns.get(t.id);
  return [t.id,{id:t.id,title:t.title,status:t.status,deadline:t.deadline,branch:t.branch_id,
   assignee:name(t.assignee_id),creator:name(t.creator_id),next:turn?.next??null,nextPerson:turn?.personId?name(turn.personId):null,
   nativeCard:canSee(user,t),description:t.description,lastRemark:t.last_remark}];
 }));
 return ids.flatMap(id=>{const row=byId.get(id);return row?[row]:[];});
}
