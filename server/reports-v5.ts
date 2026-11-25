import {randomUUID,createHash} from 'node:crypto';
import {reportTransaction,type Db} from './db.js';
import {assert,canSee,globalAccess,metrics,moscowDay} from './domain.js';
import {config} from './service.js';
import {reportAnalysis} from '../shared/reporting.js';
import {summarizeWork,frontTasks,matchesParameters,type FrontSnapshot,workKinds,reportOutcome} from '../shared/report-summary.js';
import {compareWorkPlan,defaultReportView,localDayStart,nextBusinessDay,reportViews,type ReportParameters,type ReportView} from '../shared/report-parameters.js';
import {businessDay,taskQueue,elapsedToday} from '../shared/queues.js';
import {exclusionReason} from '../shared/task-selection.js';
import {teamMemberIds} from './org.js';
import type {User,Task,Event,Report,Approval} from '../shared/types.js';
import type {ReportSummary} from '../shared/report-summary.js';
import {activeTaskApproval,approvalTurn,taskNextAction} from '../shared/actions.js';
import {branchCovers} from '../shared/branches.js';
import {approvalHierarchy,approvalScope} from './approval-hierarchy.js';
import {controlsTask,staffWorkIds} from './staff-rollout.js';
import {loadAnalyticsScope} from './analytics-scope.js';
import {hasSplitTeams,isTeamScope} from '../shared/team-scopes.js';

const scopeForView=(u:User,view:ReportView)=>view==='mine'?'user:'+u.id:view==='company'?'company':
 view==='team'&&hasSplitTeams(u)?'sales-team:'+u.id:view+':'+u.id;
export function reportScopes(u:User,view?:ReportView){
 const allowed=reportViews(u);
 if(view)assert(allowed.includes(view),403,'Этот раздел отчётов недоступен.');
 return [...(view?[view]:allowed).map(mode=>scopeForView(u,mode)),...(!view&&hasSplitTeams(u)?['team:'+u.id]:[]),
  ...(!view&&u.role==='branch_manager'&&!u.company_branch_access?['branch:'+u.branch_id]:[])];
}
export function stateAt(current:Task,events:Event[],at:Date):Task|null {
 let result:Task|null=current;
 const history=events.filter(e=>e.task_id===current.id).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||Number((b.data.after as Task|undefined)?.version||0)-Number((a.data.after as Task|undefined)?.version||0));
 for(const e of history){if(Date.parse(e.created_at)<=at.getTime())continue;if(e.kind==='created'||e.kind==='imported')return null;const before=e.data.before as Task|undefined;if(before?.id===current.id)result=before;}
 if(Date.parse(current.created_at)>at.getTime())return null;
 return result;
}
export async function captureFronts(db:Db,ownerIds:string[],now:Date){
 if(new Date(now.getTime()+10800000).toISOString().slice(11,16)<'09:00')return;
 const day=moscowDay(now);
 for(const id of ownerIds){
  const exists=(await db.query('SELECT 1 FROM work_fronts WHERE user_id=$1 AND day=$2',[id,day])).rowCount;if(exists)continue;
  const tasks=(await db.query('SELECT * FROM tasks WHERE assignee_id=$1',[id])).rows.filter(t=>!exclusionReason(t));
  await db.query('INSERT INTO work_fronts(user_id,day,captured_at,rows) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,day,now.toISOString(),JSON.stringify(frontTasks(tasks,day))]);
 }
}
export async function generateReport(u:User,kind:string,slot:string,now:Date,raw:ReportParameters={},controlledOnly=false):Promise<Report>{
 if(controlledOnly)slot+=':control';
 assert(['snapshot','period','today','overdue','review','daily','nextday'].includes(kind),400,'Неизвестный вид отчёта.');
 return reportTransaction('report:'+u.id+':'+kind+':'+slot,async db=>{
  const view=raw.view??defaultReportView(u);
  const scope=scopeForView(u,view);
  reportScopes(u,view);
  const p:ReportParameters={...raw,view};
  if(p.queue==='all')delete p.queue;
  if(view==='mine'){assert(!p.assigneeId||p.assigneeId===u.id,403,'Личный отчёт формируется только по своим задачам.');p.assigneeId=u.id;}
  if(view==='created'){assert(!p.creatorId||p.creatorId===u.id,403,'В этом отчёте видны только поставленные вами задачи.');p.creatorId=u.id;}
  if(isTeamScope(view))assert(p.assigneeId!==u.id,400,'Для своих задач откройте личный отчёт.');
  const from=p.from?new Date(p.from):localDayStart(moscowDay(now)),to=p.to?new Date(p.to):now;
  assert(Number.isFinite(from.getTime())&&Number.isFinite(to.getTime())&&from<=to&&to<=now,400,'Укажите корректный период, не позже текущего времени.');
  p.from=from.toISOString();p.to=to.toISOString();
  const day=moscowDay(to),key=createHash('sha256').update(JSON.stringify({kind,day,assignee:p.assigneeId||null,creator:p.creatorId||null,actor:p.actorId||null,price:p.priceBand||null,queue:p.queue||null,from:p.from,to:raw.to?p.to:null})).digest('hex');
  const old=(await db.query('SELECT * FROM reports WHERE day=$1 AND scope=$2 AND kind=$3 AND slot=$4',[day,scope,kind,slot])).rows[0];
  if(old){assert(old.comparison_key===key,409,'Этот запрос уже использован с другими параметрами. Создайте новый отчёт.');return old;}
  const split=isTeamScope(view)&&hasSplitTeams(u)?await loadAnalyticsScope(u,db):null;
  const team=view==='team'&&!split?new Set(await teamMemberIds(u,db)):null;
  if(team&&p.assigneeId)assert(team.has(p.assigneeId),403,'Исполнитель вне вашей команды.');
  const workScope=controlledOnly?await staffWorkIds(db):null;
  const inView=(task:Task)=>(!controlledOnly||controlsTask(task,workScope))&&
   (split?split.teamFor(task)===view:view==='mine'?task.assignee_id===u.id:view==='created'?task.creator_id===u.id:team?team.has(task.assignee_id):true);
  const canRead=(task:Task)=>canSee(u,task)||!!split?.teamFor(task);
  const current=(await db.query<Task>('SELECT * FROM tasks WHERE ($1::text IS NULL OR creator_id=$1) ORDER BY deadline NULLS LAST,id',[view==='created'?u.id:null])).rows.filter(canRead);
  const allowedIds=current.map(t=>t.id),allowed=new Set(allowedIds);
  const history=(await db.query('SELECT * FROM task_events WHERE task_id=ANY($1) ORDER BY created_at,id',[allowedIds])).rows as Event[];
  const byCurrent=new Map(current.map(t=>[t.id,t]));const byHistory=new Map<string,Event[]>();for(const e of history){const list=byHistory.get(e.task_id!)||[];list.push(e);byHistory.set(e.task_id!,list);}
  const atTime=(id:string,at:Date)=>stateAt(byCurrent.get(id)!,byHistory.get(id)||[],at);
  const source=(await db.query('SELECT * FROM import_batches ORDER BY imported_at DESC LIMIT 1')).rows[0]||null;
  const tracked=source?.imported_at||history.map(e=>e.created_at).sort()[0]||current.map(t=>t.created_at).sort()[0]||null;
  const stateAvailable=!tracked||Date.parse(tracked)<=to.getTime();
  const atEnd=stateAvailable?current.map(t=>atTime(t.id,to)).filter((t):t is Task=>!!t&&canRead(t)&&inView(t)):[];
  const scoped=atEnd.filter(t=>matchesParameters(t,{...p,queue:'all'},to));
  const filtered=atEnd.filter(t=>matchesParameters(t,p,to));
  const users=(await db.query('SELECT id,name,role,branch_id,position FROM users')).rows as User[];
  const currentAssignees=new Set((split?atEnd:current).map(t=>t.assignee_id));
  const eligible=users.filter(person=>split?currentAssignees.has(person.id):(view==='mine'?person.id===u.id:!team||team.has(person.id))&&
   (view==='created'?currentAssignees.has(person.id):globalAccess(u)||person.id===u.id||u.role==='branch_manager'&&branchCovers(u.branch_id,person.branch_id)||currentAssignees.has(person.id)));
  if(p.assigneeId)assert(eligible.some(person=>person.id===p.assigneeId),403,'Исполнитель вне доступной области.');
  const owners=p.assigneeId?[p.assigneeId]:[...new Set(eligible.map(person=>person.id))];
  // Only a live report may establish today's baseline; historical reports never invent it.
  if(view!=='created'&&day===moscowDay(now)&&Math.abs(to.getTime()-now.getTime())<1000)await captureFronts(db,owners,now);
  const fronts=(await db.query('SELECT * FROM work_fronts WHERE user_id=ANY($1) AND day=$2 AND captured_at<=$3',[owners,day,to.toISOString()])).rows.map((f:FrontSnapshot)=>({...f,rows:f.rows.filter(t=>canRead(t)&&inView(t))}));
  const selectedQueue=p.queue?p.queue:['today','overdue','review'].includes(kind)?kind:'all';
  const queueMatches=(t:Task)=>selectedQueue==='all'||selectedQueue==='today'&&!!t.deadline&&moscowDay(t.deadline)===day||selectedQueue==='overdue'&&!!t.deadline&&new Date(t.deadline)<to||selectedQueue==='review'&&t.status==='review'||selectedQueue==='completed'&&t.status==='completed'||selectedQueue==='no_deadline'&&!t.deadline||selectedQueue==='front'&&t.status!=='completed'&&frontTasks([t],day).length>0;
  const retracted=new Set((await db.query('SELECT r.event_id FROM event_retractions r JOIN task_events e ON e.id=r.event_id WHERE e.task_id=ANY($1) AND r.created_at<=$2',[allowedIds,to.toISOString()])).rows.map(r=>r.event_id));
  const inRange=history.filter(e=>!retracted.has(e.id)).filter(e=>Date.parse(e.created_at)>=from.getTime()&&Date.parse(e.created_at)<=to.getTime()).filter(e=>{
   const t=(e.data.after||e.data.before) as Task|undefined;const snapshot=t?.id?t:atTime(e.task_id!,new Date(e.created_at));const before=e.data.before as Task|undefined;
   return (!p.actorId||e.actor_id===p.actorId)&&!!snapshot&&canRead(snapshot)&&inView(snapshot)&&matchesParameters(snapshot,{...p,queue:'all'},to)&&(queueMatches(snapshot)||!!before&&queueMatches(before));
  });
  const closedIds=new Set(inRange.filter(e=>reportOutcome(e)==='task_completed').map(e=>e.task_id));
  const touched=new Set(inRange.filter(e=>workKinds.has(reportOutcome(e))).map(e=>e.task_id));
  const live=Math.abs(+now-+to)<1000;
  const nextDay=nextBusinessDay(day);
  const candidates=kind==='nextday'?filtered.filter(t=>t.status==='active'&&t.deadline&&businessDay(t.deadline)<=nextDay):[];
  const approvalTasks=kind==='nextday'?candidates:scoped;
  const approvals=live?(await db.query<Approval>("SELECT * FROM approvals WHERE state='pending' AND canceled_at IS NULL AND task_id=ANY($1)",[approvalTasks.map(t=>t.id)])).rows:[];
  const byApprovalTask=new Map(approvalTasks.map(t=>[t.id,t]));
  const currentApproval=new Map(approvals.filter(a=>activeTaskApproval(byApprovalTask.get(a.task_id)!,a)).map(a=>[a.task_id,a]));
  let tasks:Task[];
  if(kind==='nextday')tasks=candidates.filter(t=>!currentApproval.has(t.id))
   .sort((a,b)=>compareWorkPlan(a,b,nextDay));
  else if(p.queue)tasks=filtered;
  else if(['today','overdue','review'].includes(kind))tasks=scoped.filter(t=>taskQueue(t,to)===kind||kind==='overdue'&&elapsedToday(t,to));
  else if(view==='created')tasks=scoped.filter(t=>t.status!=='completed'||closedIds.has(t.id));
  else tasks=scoped.filter(t=>frontTasks([t],day).length>0||closedIds.has(t.id)||kind==='period'&&touched.has(t.id));
  if(controlledOnly&&live&&view==='mine')tasks=tasks.filter(t=>t.status==='completed'||t.status==='active'&&!currentApproval.has(t.id));
  if(p.actorId)tasks=tasks.filter(t=>touched.has(t.id));
  const relevant=new Set(scoped.map(t=>t.id));const summary=summarizeWork(tasks,users,inRange.filter(e=>relevant.has(e.task_id||'')),{...p,queue:selectedQueue as ReportParameters['queue']},from,to,fronts,tracked,stateAvailable,atEnd);
  if(!stateAvailable)summary.notes.push('На конец выбранного периода ещё не было данных в системе. Историческое состояние недоступно.');
  else if(tracked&&!summary.completeHistory)summary.notes.push('История действий покрывает период частично: учёт начат '+new Date(tracked).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК. Более ранняя история не восстановлена.');
  if(!summary.front.capturedAt&&view!=='created'&&kind!=='nextday')summary.notes.push('Утренний фронт на выбранную дату не был сохранён. Сравнение «ожидалось / сделано» недоступно.');
  else if(summary.front.capturedAt&&new Date(summary.front.capturedLatest||summary.front.capturedAt).getTime()>localDayStart(day).getTime()+9*3600000+60000)summary.notes.push('Фронт впервые сохранён после 09:00; сравнение начинается с фактического времени снимка.');
  const previous=(await db.query('SELECT id,created_at,rows,summary,analysis FROM reports WHERE scope=$1 AND kind=$2 AND comparison_key=$3 AND (summary->>\'to\')::timestamptz<=$4 ORDER BY created_at DESC,id DESC LIMIT 1',[scope,kind,key,to.toISOString()])).rows[0]||null;
  if(previous?.summary){summary.previous={id:previous.id,at:previous.summary.to,closedChange:summary.activity.closed-previous.summary.activity.closed,processedChange:summary.activity.processed-previous.summary.activity.processed,openChange:tasks.filter(t=>t.status!=='completed').length-Number(previous.summary.openCount||0)};}
  const approvalQueue=live&&kind!=='nextday'?{decisionIds:[] as string[],clarificationIds:[] as string[]}:undefined;
  const taskIds=new Set(tasks.map(t=>t.id));
  if(approvalQueue){
   for(const approval of currentApproval.values()){
    if(!approvalTurn(approval).userId||((p.queue||p.actorId||!['snapshot','daily'].includes(kind))&&!taskIds.has(approval.task_id)))continue;
    const ids=approvalTurn(approval).clarification?approvalQueue.clarificationIds:approvalQueue.decisionIds;
    ids.push(approval.task_id);
   }
  }
  const c=(await db.query('SELECT * FROM control_requests WHERE task_id=ANY($1)',[[...taskIds]])).rows,cfg=await config(db);
  const stored:ReportSummary&{openCount:number}={...summary,approvalQueue,openCount:tasks.filter(t=>t.status!=='completed').length};
  if(kind==='nextday'){
   stored.tomorrow={...summary.tomorrow,ids:[...taskIds],total:tasks.length,prices:summary.prices,
    overdue:tasks.filter(t=>businessDay(t.deadline!)<nextDay).length,today:tasks.filter(t=>businessDay(t.deadline!)===nextDay).length};
  }
  if(view==='created'){
   const reviewScope=live?approvalScope(await approvalHierarchy(db)):null;
   const open=tasks.filter(t=>t.status!=='completed');
   const moved=new Set(inRange.filter(e=>e.task_id&&taskIds.has(e.task_id)&&workKinds.has(reportOutcome(e))).map(e=>e.task_id!));
   const closedOnTime=new Set<string>(),closedLate=new Set<string>();
   for(const e of inRange){
    if(!e.task_id||!taskIds.has(e.task_id)||reportOutcome(e)!=='task_completed')continue;
    const before=e.data.before as Task|undefined,after=e.data.after as Task|undefined;
    if(!before?.deadline)continue;
    const late=Date.parse(after?.completed_at??e.created_at)>Date.parse(before.deadline);
    (late?closedLate:closedOnTime).add(e.task_id);
    (late?closedOnTime:closedLate).delete(e.task_id);
   }
   stored.creatorProgress={openIds:open.map(t=>t.id),movedIds:[...moved],closedOnTimeIds:[...closedOnTime],closedLateIds:[...closedLate],
    idleOverdueIds:open.filter(t=>t.status==='active'&&(taskQueue(t,to)==='overdue'||elapsedToday(t,to))&&!moved.has(t.id)&&
     !currentApproval.has(t.id)&&taskNextAction(t,undefined)?.userId===t.assignee_id).map(t=>t.id),
    myDecisionIds:live?open.filter(t=>(t.status==='review'||currentApproval.has(t.id))&&taskNextAction(t,currentApproval.get(t.id),reviewScope)?.userId===u.id).map(t=>t.id):[]};
  }
  const analysis=reportAnalysis(tasks,users,to,previous,source);
  const report=(await db.query("INSERT INTO reports(id,day,scope,kind,slot,metrics,rows,rules_version,activity,formula_version,analysis,parameters,summary,comparison_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'v5-workday',$10,$11,$12,$13) RETURNING *",[randomUUID(),day,scope,kind,slot,JSON.stringify(metrics(tasks,[...currentApproval.values()],c,to)),JSON.stringify(tasks),cfg.version,JSON.stringify({completed:summary.activity.closed,transfers:summary.activity.transfers,returned:summary.activity.returned,answers:summary.activity.answers}),JSON.stringify(analysis),JSON.stringify(p),JSON.stringify(stored),key])).rows[0];
  return report;
 });
}
