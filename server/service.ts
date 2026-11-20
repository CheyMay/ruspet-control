import {canSetApprovedDeadline} from '../shared/actions.js';
import {loadDeadlineHistories,queueDeadlineHistories} from './deadline-history.js';
import {taskPrice} from '../shared/pricing.js';
import {keepTaskApprovals} from './approval-updates.js';
import {delegatedTaskAccepted} from './delegation-review.js';
import {taskEditAccess} from './task-edit-permissions.js';
import {controlsTask,staffWorkIds} from './staff-rollout.js';
import {approvalHierarchy,approvalScope,approvalWatch,branchApprover,hierarchyRoute,requiresTaskApproval} from './approval-hierarchy.js';
import {branchCovers,unassignedBranch} from '../shared/branches.js';
import {lockDelegationChain,requireAcceptedDelegations} from './delegation-lock.js';
import {recordTaskAction} from './undo-record.js';
import {enqueueBitrixOperation} from './bitrix-live.js';
import {loadBitrixResults} from './bitrix-results.js';
import {teamMemberIds} from './org.js';
import {generateReport,reportScopes} from './reports-v5.js';
import type {ReportParameters,ReportView} from '../shared/report-parameters.js';
import {parseWrittenRule} from '../shared/written-rules.js';
import {exclusionReason} from '../shared/task-selection.js';
import {reportAnalysis} from '../shared/reporting.js';
import {plannedMinutesOn,plannedInterval} from '../shared/analytics.js';
import { taskQueue } from '../shared/queues.js';
import { randomUUID } from 'node:crypto';
import { pool, transaction, type Db } from './db.js';
import type { Task, User, Rules, Approval, ControlRequest, Step, BitrixDiscussion, TaskApprovalProgress } from '../shared/types.js';
import { assert, canAccess, canSee, canRequest, canManage, globalAccess, evaluate, metrics, moscowDay } from './domain.js';
import { providers } from './providers.js';
import {pendingAssignmentTasks,registerTaskAcceptance,requireTaskAcceptance,taskAssignmentReceipt,taskPersonalPlan,visiblePlanNotice} from './personal-calendar.js';
import {analyticsAccess} from './analytics-scope.js';
const adapters=providers();
const planningFindings=new Set(['planned_overdue','missing_plan_start','missing_plan_end','negative_plan','long_plan','plan_after_deadline','plan_before_creation','child_plan','parent_unavailable','child_deadline','children_unavailable']);
export async function event(db:Db,taskId:string|null,actor:string|null,kind:string,message:string,data:object={}) {
 if(taskId&&['review_submitted','task_completed'].includes(kind))await requireAcceptedDelegations(db,taskId);
 const after=(data as {after?:Task}).after;
 if(taskId&&after?.version&&['created','task_edited','review_submitted','review_returned','task_completed','deadline_changed','action_undone'].includes(kind))await db.query('INSERT INTO task_sync_queue(id,task_id,task_version,payload) VALUES($1,$2,$3,$4) ON CONFLICT(task_id,task_version) DO NOTHING',[randomUUID(),taskId,after.version,JSON.stringify({kind,after,context:Object.fromEntries(Object.entries(data).filter(([key])=>!['before','after'].includes(key)))})]);
 const id=randomUUID();
 await db.query('INSERT INTO task_events(id,task_id,actor_id,kind,message,data) VALUES ($1,$2,$3,$4,$5,$6)',[id,taskId,actor,kind,message,JSON.stringify(data)]);
 if(taskId)await enqueueBitrixOperation(db,id,taskId,kind,message,data as Record<string,unknown>,actor);
 if(taskId&&kind==='task_completed')await db.query(`INSERT INTO task_acceptance_events(event_id,task_id,occurred_at,available_at)
  SELECT $1,$2,clock_timestamp(),clock_timestamp()+interval '5 minutes' WHERE NOT EXISTS(SELECT 1 FROM business_runs WHERE task_id=$2)
  AND NOT EXISTS(SELECT 1 FROM business_run_tasks WHERE task_id=$2)`,[id,taskId]);
 if(taskId&&kind==='task_completed')await delegatedTaskAccepted(db,taskId);
 return id;
}
export async function notify(db:Db,taskId:string|null,recipient:string,body:string,key:string,taskAssignment=false) {
 await db.query('INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key,task_assignment) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING',[randomUUID(),taskId,recipient,body,key,taskAssignment]);
}
export async function notifyTaskAssignment(db:Db,task:Task,actorId:string|null,label='Вам поставили задачу'){
 if(task.assignee_id===actorId)return;
 await registerTaskAcceptance(db,task);
 await notify(db,task.id,task.assignee_id,label+' #'+task.id+' · '+task.title,`task-assignment:${task.id}:${task.version}`,true);
}
export async function config(db:Db=pool):Promise<{version:number;config:Rules}> { const row=(await db.query('SELECT * FROM rule_versions ORDER BY version DESC LIMIT 1')).rows[0];return {...row,config:{requiredPrice:true,showPlanning:false,writtenRules:[],...row.config}}; }
export async function visibleTasksForCompany(user:User,id:string):Promise<Task[]>{
 return (await pool.query<Task>("SELECT * FROM tasks WHERE company_id=$1 ORDER BY (status='completed'),updated_at DESC,id",[id])).rows.filter(t=>canSee(user,t));
}
export async function visibleTasks(user:User,db:Db=pool):Promise<Task[]> {
 return (await db.query<Task>(`SELECT * FROM tasks WHERE $1 OR assignee_id=$2 OR creator_id=$2
  OR ($3 AND (branch_id=$4 OR starts_with(branch_id,$4 || ' / ')))
  ORDER BY deadline ASC NULLS LAST,id`,[globalAccess(user)||user.role==='branch_manager'&&!!user.company_branch_access,user.id,
   user.role==='branch_manager'&&!!user.branch_id&&user.branch_id!==unassignedBranch,user.branch_id])).rows.filter(t=>canSee(user,t));
}
async function taskFor(db:Db,id:string,user:User,lock=false):Promise<Task> {
 if(lock)await lockDelegationChain(db,id);
 const task=(await db.query(`SELECT * FROM tasks WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
 assert(task && canSee(user,task),404,'Задача не найдена или недоступна.'); return task;
}
export async function bootstrap(user:User,light=false,compactWorkspace=false,includePrivate=true) {
 return transaction(async db=>{
 await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const tasks=await visibleTasks(user,db), ids=tasks.map(t=>t.id), cfg=await config(db);
 const hierarchy=await approvalHierarchy(db),scope=approvalScope(hierarchy);
 const approvals=(await db.query<Approval>('SELECT * FROM approvals WHERE task_id=ANY($1) ORDER BY created_at DESC',[ids])).rows;
 const editRequests=(await db.query(`SELECT p.id,p.task_id,t.creator_id,p.created_at FROM task_edit_permissions p JOIN tasks t ON t.id=p.task_id
  WHERE p.task_id=ANY($1) AND t.status='active' AND p.state='pending' AND p.task_version=t.version AND p.requester_id=t.assignee_id`,[ids])).rows;
 const controls=(await db.query('SELECT * FROM control_requests WHERE task_id=ANY($1) ORDER BY created_at DESC',[ids])).rows;
 const people=new Set([...tasks.flatMap(t=>[t.assignee_id,t.creator_id]),...approvals.flatMap((a:Approval)=>a.route.map(step=>step.userId))]);
 const users=(await db.query<User>('SELECT * FROM users ORDER BY name')).rows.filter(u=>globalAccess(user)||branchCovers(user.branch_id,u.branch_id)||u.id===user.id||people.has(u.id));
 const teamIds=await teamMemberIds(user,db);
 const pendingAssignmentIds=includePrivate?await pendingAssignmentTasks(user,ids,db):[];
 const pendingAssignments=pendingAssignmentIds.length;
 if(light)return {pendingAssignments,pendingAssignmentIds,approvalScope:scope,user,users,tasks,teamIds,approvals,editRequests,controls,submissions:(await db.query('SELECT * FROM task_submissions WHERE withdrawn_at IS NULL AND task_id=ANY($1) ORDER BY submitted_at DESC',[ids])).rows,rules:cfg.config,rulesVersion:cfg.version,serverTime:new Date().toISOString(),metrics:metrics(tasks,approvals,controls),source:null,findings:[],events:[],notifications:[],reports:[]};
 const available=(await db.query('SELECT * FROM tasks')).rows.filter(t=>canAccess(user,t));
 const selection={total:available.length,included:tasks.length,checklist:available.filter(t=>exclusionReason(t)==='checklist').length,unfinishedAnalysis:available.filter(t=>exclusionReason(t)==='unfinished_analysis').length};
 const lastTaskChange=(await db.query("SELECT max(created_at) AS at FROM task_events WHERE task_id=ANY($1) AND (kind=ANY($2) OR (data ? 'before' AND data ? 'after'))",[ids,['created','task_edited','task_completed','deadline_changed','review_submitted','review_returned','action_undone']])).rows[0].at;
 const deadlineHistory=await loadDeadlineHistories(db,[...new Set(approvals.map(a=>a.task_id))]);
 return {analyticsAccess:includePrivate?await analyticsAccess(user,db):null,pendingAssignments,pendingAssignmentIds,
 deadlineApproverId:hierarchy?.sales_head_id??null,deadlineHistory,approvalScope:scope,lastTaskChange,selection,user,users,
 tasks:compactWorkspace?tasks.map(({source_fields,...task})=>({...task,price:task.price??taskPrice({price:task.price,source_fields})})):tasks,
 teamIds,approvals,editRequests,controls,approvalComments:(await db.query('SELECT * FROM comments WHERE task_id=ANY($1) AND approval_id IS NOT NULL AND withdrawn_at IS NULL ORDER BY created_at',[ids])).rows,submissions:(await db.query('SELECT * FROM task_submissions WHERE withdrawn_at IS NULL AND task_id=ANY($1) ORDER BY submitted_at DESC',[ids])).rows,rules:cfg.config,rulesVersion:cfg.version,serverTime:new Date().toISOString(),metrics:metrics(tasks,approvals,controls),source:(await db.query('SELECT file_name,sheet_name,row_count,imported_at,assumptions FROM import_batches ORDER BY imported_at DESC LIMIT 1')).rows[0]||null,
 findings:(await db.query("SELECT * FROM findings WHERE task_id=ANY($1) AND status='open'",[ids])).rows.filter(f=>cfg.config.showPlanning||!planningFindings.has(f.rule)),
 events:compactWorkspace?[]:(await db.query('SELECT * FROM task_events WHERE task_id=ANY($1) OR (task_id IS NULL AND $2) ORDER BY created_at DESC LIMIT 250',[ids,globalAccess(user)])).rows,
 notifications:(await db.query(`SELECT id,task_id,recipient_id,body,state,created_at,read_at,task_notice,management_notice,dedupe_key LIKE 'staff-review:%' AS staff_review FROM outbox o WHERE withdrawn_at IS NULL AND NOT task_assignment AND recipient_id=$1 AND (task_id IS NULL OR task_id=ANY($2))
 AND ($3 OR o.personal_plan_alert_id IS NULL) AND ${visiblePlanNotice} ORDER BY created_at DESC LIMIT 150`,[user.id,ids,includePrivate])).rows,
 reports:(await db.query('SELECT id,day,scope,metrics,rules_version,created_at,kind,activity,slot,formula_version,parameters,summary FROM reports WHERE scope=ANY($1) AND ($2::boolean OR kind<>\'nextday\') ORDER BY created_at DESC LIMIT 100',[reportScopes(user),!!cfg.config.showPlanning])).rows};
 });
}
export async function queueApprovalHistories(user:User){
 return transaction(async db=>{
  const ids=(await visibleTasks(user,db)).map(task=>task.id);
  const {rows}=await db.query<{task_id:string}>(`SELECT DISTINCT a.task_id FROM approvals a JOIN tasks t ON t.id=a.task_id
   WHERE a.task_id=ANY($1) AND a.state='pending' AND a.canceled_at IS NULL AND a.task_version=t.version`,[ids]);
  await queueDeadlineHistories(db,rows.map(row=>row.task_id));
  return {ok:true};
 });
}

export async function detail(user:User,id:string,db:Db=pool,includeDeadlineHistory=false,includePrivate=true) {
 const task=await taskFor(db,id,user);
 const approvals=(await db.query<Approval>('SELECT * FROM approvals WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows;
 const current=task.status==='completed'?undefined:approvals.find(a=>a.state==='pending'&&!a.canceled_at&&a.task_version===task.version&&a.route[a.current_step]);
 let approvalProgress:TaskApprovalProgress|null=null;
 if(current){
  const step=current.route[current.current_step];
  const waiting=!!current.clarification_requested_at&&!current.clarification_answered_at;
  const people=(await db.query<Pick<User,'id'|'name'>>('SELECT id,name FROM users WHERE id=ANY($1)',[
   waiting?[step.userId,current.requester_id]:[step.userId]
  ])).rows;
  approvalProgress={
   type:current.type,step:current.current_step+1,total:current.route.length,
   label:step.label==='Руководитель филиала'?'Руководитель подразделения':step.label,
   approver:people.find(person=>person.id===step.userId)?.name??null,
   clarificationBy:waiting?people.find(person=>person.id===current.requester_id)?.name??'Автор запроса':null,
   deferredUntil:current.deferred_until,
  };
 }
 const imported=(await db.query<{count:number;linked:boolean}>(`SELECT
  (SELECT count(*)::int FROM bitrix_task_activity WHERE task_id=$1 AND kind='comment') AS count,
  EXISTS(SELECT 1 FROM bitrix_task_links WHERE task_id=$1) AS linked`,[id])).rows[0];
 const hierarchy=await approvalHierarchy(db);
 const deadlineHistory=includeDeadlineHistory&&approvals.length?(await loadDeadlineHistories(db,[id]))[id]??[]:[];
 const personalPlan=includePrivate?await taskPersonalPlan(user,task,db):null;
 return {
  task,personalPlan,assignmentReceipt:await taskAssignmentReceipt(task,personalPlan,db),deadlineHistory,deadlineApproverId:hierarchy?.sales_head_id??null,approvalScope:approvalScope(hierarchy),approvalProgress,editAccess:await taskEditAccess(user,task,db),approvalWatch:await approvalWatch(user,task,db),
  submissions:(await db.query('SELECT * FROM task_submissions WHERE withdrawn_at IS NULL AND task_id=$1 ORDER BY round DESC',[id])).rows,
  comments:(await db.query('SELECT * FROM comments WHERE withdrawn_at IS NULL AND task_id=$1 ORDER BY created_at',[id])).rows,
  bitrixCommentCount:imported.count,bitrixLinked:imported.linked,
  events:(await db.query('SELECT * FROM task_events WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows,
  approvals,
  decisions:(await db.query('SELECT d.*,EXISTS(SELECT 1 FROM decision_retractions r WHERE r.decision_id=d.id) retracted FROM decisions d JOIN approvals a ON a.id=d.approval_id WHERE a.task_id=$1 ORDER BY d.created_at',[id])).rows,
  controls:(await db.query('SELECT * FROM control_requests WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows
 };
}
export async function taskBitrixResults(user:User,id:string,allowQueue=true){
 await taskFor(pool,id,user);
 return loadBitrixResults(id,allowQueue);
}
export async function taskBitrixDiscussion(user:User,id:string,allowQueue=true):Promise<BitrixDiscussion>{
 await taskFor(pool,id,user);
 const portal=process.env.BITRIX_PORTAL;
 const origin=portal&&/^[a-z0-9.-]+$/i.test(portal)?'https://'+portal:null;
 const [stored,links,results]=await Promise.all([
  pool.query<BitrixDiscussion['messages'][number]>(`SELECT external_id,occurred_at,author,body FROM bitrix_task_activity a
   WHERE task_id=$1 AND kind='comment' AND NOT EXISTS(
    SELECT 1 FROM bitrix_operations o WHERE o.task_id=a.task_id AND o.payload->>'kind'='comment'
    AND position('[ruspet:'||o.event_id::text||']' IN a.body)>0)
   ORDER BY occurred_at DESC,external_id DESC LIMIT 100`,[id]),
  pool.query<{external_id:string;state:string|null}>(`SELECT l.external_id::text,q.state FROM bitrix_task_links l
   LEFT JOIN bitrix_refresh_queue q ON q.portal=$2 AND q.resource='task_inbound_comments' AND q.external_id=l.external_id::text
   WHERE l.task_id=$1 AND NOT l.live_enabled`,[id,portal??null]),
  loadBitrixResults(id,allowQueue)
 ]);
 const link=links.rows[0];
 let state:BitrixDiscussion['state']='ready';
 if(link?.state==='pending'||link?.state==='failed'||link?.state==='processing')state='pending';
 else if(link?.state==='blocked')state='unavailable';
 else if(link&&!link.state&&allowQueue&&portal&&process.env.BITRIX_INBOUND_TASKS==='true'){
  await pool.query(`INSERT INTO bitrix_refresh_queue(portal,resource,external_id)
   VALUES($1,'task_inbound_comments',$2) ON CONFLICT DO NOTHING`,[portal,link.external_id]);
  state='pending';
 }
 return {state,origin,messages:stored.rows,results};
}
async function addCommentCore(user:User,id:string,body:string,approvalId?:string) {
 return transaction(async db=>{
  const task=await taskFor(db,id,user,true);
  const approval=approvalId?(await db.query('SELECT * FROM approvals WHERE id=$1 AND task_id=$2',[approvalId,id])).rows[0]:null;
  assert(!approvalId||approval,404,'Согласование не найдено для этой задачи.');
  await db.query('INSERT INTO comments(id,task_id,author_id,body,approval_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,user.id,body,approvalId||null]);
  await event(db,id,user.id,'comment',approval?'Сообщение в обсуждении согласования':'Добавлен комментарий',{body,approvalId:approvalId||null});
  const recipients=approval?[approval.requester_id,approval.route[approval.current_step]?.userId]:[task.assignee_id,task.creator_id];
  const key=randomUUID();for(const recipient of new Set(recipients.filter(Boolean)))if(recipient!==user.id)await notify(db,id,recipient,`${user.name} · #${id}${approval?' · обсуждение согласования':''}: ${body}`,`comment:${key}:${recipient}`);
 });
}
export async function refreshTaskFindings(db:Db,task:Task,user:User){
 const scope=await staffWorkIds(db);
 const controlled=controlsTask(task,scope);
 const findings=controlled?evaluate(task,(await config(db)).config,new Date(),await visibleTasks(user,db)):[];
 await db.query("UPDATE findings SET status='resolved' WHERE task_id=$1 AND NOT(rule=ANY($2))",[task.id,findings.map(f=>f.rule)]);
 for(const f of findings)await db.query("INSERT INTO findings(id,task_id,rule,severity,message,status) VALUES($1,$2,$3,$4,$5,'open') ON CONFLICT(task_id,rule) DO UPDATE SET status='open',last_seen=now(),message=excluded.message,severity=excluded.severity",[randomUUID(),task.id,f.rule,f.severity,f.message]);
 if(!controlled)await db.query(`UPDATE outbox o SET withdrawn_at=now() FROM control_requests c
  WHERE c.task_id=$1 AND o.withdrawn_at IS NULL AND (o.dedupe_key='control:'||c.id OR o.dedupe_key LIKE 'remind:'||c.id||':%')`,[task.id]);
 if(!findings.some(f=>f.severity!=='info'))await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[task.id]);
 return findings;
}
export async function runChecks(user:User,now=new Date()) {
 assert(canManage(user),403,'Запуск проверки доступен руководителю.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431002)');
  const cfg=await config(db),scope=await staffWorkIds(db); let found=0;
  const allTasks=await visibleTasks(user,db);
  for(const visible of allTasks.filter(task=>controlsTask(task,scope))) {
   const task=await taskFor(db,visible.id,user,true);
   if(!controlsTask(task,scope))continue;
   const findings=evaluate(task,cfg.config,now,allTasks); found+=findings.length;
   await db.query("UPDATE findings SET status='resolved' WHERE task_id=$1 AND NOT(rule=ANY($2))",[task.id,findings.map(f=>f.rule)]);
   for(const f of findings) await db.query("INSERT INTO findings(id,task_id,rule,severity,message,status) VALUES($1,$2,$3,$4,$5,'open') ON CONFLICT(task_id,rule) DO UPDATE SET status='open',last_seen=now(),message=excluded.message,severity=excluded.severity",[randomUUID(),task.id,f.rule,f.severity,f.message]);
   if(findings.some(f=>f.severity!=='info')) {
    const id=randomUUID();
    const inserted=await db.query("INSERT INTO control_requests(id,task_id,assignee_id,state,due_at) VALUES($1,$2,$3,'waiting',$4) ON CONFLICT DO NOTHING",[id,task.id,task.assignee_id,new Date(now.getTime()+cfg.config.reminderMinutes*60000)]);
    if(inserted.rowCount) { await notify(db,task.id,task.assignee_id,`По задаче #${task.id}: ${findings.map(f=>f.message).join('; ')}. Укажите причину, что сделано и дальнейший план.`,`control:${id}`); await event(db,task.id,user.id,'check','Запрошено объяснение по результатам проверки',{rulesVersion:cfg.version,rules:findings.map(f=>f.rule)}); }
   } else await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[task.id]);
  }
  await event(db,null,user.id,'checks_run',`Проверка завершена: найдено нарушений — ${found}`,{rulesVersion:cfg.version});
  await adapters.telegram.dispatch(db); return {found};
 });
}
async function answerControlCore(user:User,id:string,input:{reason:string;progress:string;plan:string}) {
 return transaction(async db=>{
  const control=(await db.query('SELECT * FROM control_requests WHERE id=$1 FOR UPDATE',[id])).rows[0] as ControlRequest;
  assert(control,404,'Запрос не найден.'); const task=await taskFor(db,control.task_id,user);
  assert(user.id===control.assignee_id || user.role==='admin',403,'Ответ даёт исполнитель задачи.');
  assert(['waiting','escalated'].includes(control.state),409,'На этот запрос уже ответили.');
  const cfg=await config(db);
  for(const text of Object.values(input)) assert(text.trim().length>=cfg.config.responseMinLength,400,`Заполните каждое поле: минимум ${cfg.config.responseMinLength} символов.`);
  await db.query("UPDATE control_requests SET state='answered',reason=$2,progress=$3,plan=$4 WHERE id=$1",[id,input.reason,input.progress,input.plan]);
  await db.query("INSERT INTO comments(id,task_id,author_id,body,kind) VALUES($1,$2,$3,$4,'explanation')",[randomUUID(),task.id,user.id,`Причина: ${input.reason}\nСделано: ${input.progress}\nПлан: ${input.plan}`]);
  await event(db,task.id,user.id,'explanation','Получено структурированное объяснение',{controlId:id,...input});await notify(db,task.id,task.creator_id,'Получен ответ по задаче #'+task.id+'. Причина, результат и план сохранены.', 'answer:'+id);
 });
}
async function routeFor(db:Db,task:Task,selectors:Rules['routes']['deadline']):Promise<Step[]> {
 const users=(await db.query('SELECT * FROM users ORDER BY id')).rows as User[];
 const labels={branchManager:'Руководитель филиала',salesHead:'Руководитель продаж',director:'Директор',creator:'Постановщик'};
 return selectors.map(selector=>{
  const scoped=selector==='branchManager'?branchApprover(users,task):undefined;
  const matches=selector==='branchManager'?(scoped?[scoped]:[]):users.filter(u=>selector==='creator'?u.id===task.creator_id:u.role===(selector==='salesHead'?'sales_head':'director'));
  assert(matches.length===1,422,matches.length?`Неоднозначный маршрут: несколько согласующих «${labels[selector]}». Настройте реальные роли и филиалы.`:`Не назначен согласующий: ${labels[selector]}`);return {userId:matches[0].id,label:labels[selector]};
 });
}
async function requestApprovalCore(user:User,id:string,input:{type:'deadline'|'completion';reason:string;plan?:string;proposedDeadline?:string;expectedVersion:number}) {
 return transaction(async db=>{
  const task=await taskFor(db,id,user,true); assert(canRequest(user,task),403,'У вас нет права запрашивать изменение.');
  if(input.type==='completion')await requireTaskAcceptance(user,task,db);
  assert(task.version===input.expectedVersion,409,'Задача изменилась. Обновите карточку.');
  assert(task.status!=='completed',409,'Задача уже завершена.');
  assert(!(await db.query("SELECT 1 FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rowCount,409,'У задачи уже есть активное согласование.');
  const cfg=await config(db),min=cfg.config.responseMinLength;
  const plan=input.type==='completion'?input.plan?.trim()??'':'';
  assert(input.reason.trim().length>=min,400,`Причина запроса: минимум ${min} символов.`);
  if(input.type==='completion')assert(plan.length>=min,400,`Результат: минимум ${min} символов.`);
  if(input.type==='deadline') { assert(input.proposedDeadline&&new Date(input.proposedDeadline)>new Date(),400,'Новый срок должен быть в будущем.'); assert(new Date(input.proposedDeadline).getTime()!==new Date(task.deadline||0).getTime(),400,'Новый срок совпадает с текущим.'); }
  const hierarchy=await approvalHierarchy(db,true);
  if(!requiresTaskApproval(hierarchy,task,input.type,user.id)){
   assert(input.type==='deadline',422,'Передайте результат на приёмку в карточке задачи.');
   const next=(await db.query<Task>('UPDATE tasks SET deadline=$2,transfer_count=transfer_count+1,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,input.proposedDeadline])).rows[0];
   await adapters.tasks.applyApprovedChange(db,next,task.version);
   await event(db,id,user.id,'deadline_changed','Изменён крайний срок',{before:task,after:next,reason:input.reason});
   await refreshTaskFindings(db,next,user);
   return {id,applied:true};
  }
  const route=hierarchy?await hierarchyRoute(db,hierarchy,task,user.id,input.type):await routeFor(db,task,cfg.config.routes[input.type]);
  assert(route.length>0,422,'Маршрут не настроен.'); assert(!route.some(s=>s.userId===user.id),422,'Согласовать собственный запрос нельзя.');
  const approvalId=randomUUID();
  await db.query("INSERT INTO approvals(id,task_id,requester_id,type,reason,plan,proposed_deadline,task_version,state,route,route_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)",[approvalId,id,user.id,input.type,input.reason,plan,input.proposedDeadline||null,task.version,JSON.stringify(route),cfg.version]);
  await event(db,id,user.id,'approval_requested',input.type==='deadline'?'Запрошен перенос срока':'Запрошено закрытие задачи',{approvalId,oldDeadline:task.deadline,newDeadline:input.proposedDeadline,version:task.version,reason:input.reason,...(plan?{plan}:{}),route});
  await queueDeadlineHistories(db,[id]);
  if(route[0].userId!==hierarchy?.sales_head_id)await notify(db,id,route[0].userId,`Требуется решение по задаче #${id}: ${input.reason}`,`approval:${approvalId}:0`);
  await adapters.telegram.dispatch(db);
  return {id:approvalId};
 });
}
export async function decideCore(user:User,id:string,input:{decision:'approve'|'reject'|'later'|'clarify';comment:string;expectedStep?:number;expectedRevision?:number;approvedDeadline?:string;remindMinutes?:number}) {
 return transaction(async db=>{
  const first=(await db.query('SELECT task_id FROM approvals WHERE id=$1',[id])).rows[0]; assert(first,404,'Согласование не найдено.');
  const task=await taskFor(db,first.task_id,user,true);
  const a=(await db.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE',[id])).rows[0] as Approval;
  assert(input.expectedRevision===undefined?a.action_revision===1:input.expectedRevision===a.action_revision,409,'Версия согласования изменилась. Откройте актуальную задачу, чтобы проверить этап и решение.');
  assert(input.expectedStep===undefined||input.expectedStep===a.current_step,409,'Этот этап уже завершён. Откройте актуальное решение.');
  assert(a.state==='pending',409,a.state==='stale'?'Запрос устарел из-за изменения задачи. В актуальной карточке можно посмотреть текущий статус и срок.':'Этот запрос уже обработан. Откройте актуальную задачу, чтобы посмотреть решение.');
  assert(!a.task_change?.routeIssue,409,'Нужен другой согласующий. Проверьте участников и маршрут задачи.');
  const hierarchy=await approvalHierarchy(db);
  assert(a.requester_id!==user.id&&(a.type!=='completion'||task.assignee_id!==user.id),403,'Нельзя согласовать собственный запрос или принять свою работу.');
  assert(a.route[a.current_step].userId===user.id,403,'Сейчас решение принимает другой согласующий.');
  assert(!a.clarification_requested_at||a.clarification_answered_at,409,'Сначала дождитесь ответа на уточнение.');
  if(a.task_version!==task.version) {
   await db.query("UPDATE approvals SET state='stale' WHERE id=$1",[id]); await event(db,task.id,user.id,'approval_stale','Согласование остановлено: задача изменилась',{approvalId:id});
   return {state:'stale'};
  }
  if(input.approvedDeadline!==undefined){
   assert(input.decision==='approve'&&canSetApprovedDeadline(user.id,a,task,{
    deadlineApproverId:hierarchy?.sales_head_id,creatorApproverId:hierarchy?.creator_approver_id
   }),403,'Для этого запроса итоговый крайний срок изменить нельзя.');
   assert(Date.parse(input.approvedDeadline)>Date.now(),400,'Итоговый крайний срок должен быть в будущем.');
  }
  if(input.decision==='reject'||input.decision==='clarify'||input.decision==='approve'&&a.type==='completion'&&task.status!=='review')
   assert(input.comment.trim().length>=5,400,'Комментарий к решению обязателен, минимум 5 символов.');
  if(input.decision==='clarify') {
   await db.query(`UPDATE approvals SET clarification_question=$2,clarification_answer=NULL,clarification_requested_at=now(),
    clarification_answered_at=NULL,deferred_until=NULL,action_revision=action_revision+1 WHERE id=$1`,[id,input.comment]);
   await db.query("INSERT INTO comments(id,task_id,author_id,body,kind,approval_id) VALUES($1,$2,$3,$4,'clarification',$5)",[randomUUID(),task.id,user.id,`Уточнение по согласованию: ${input.comment}`,id]);
   await event(db,task.id,user.id,'approval_clarification_requested','Согласующий запросил уточнение',{approvalId:id,step:a.current_step,question:input.comment});
   await notify(db,task.id,a.requester_id,`По задаче #${task.id} нужен ответ: ${input.comment}`,`clarify:${id}:${a.action_revision+1}`);
   await adapters.telegram.dispatch(db);return {state:'pending',clarification:'requested'};
  }
  await db.query('INSERT INTO decisions(id,approval_id,actor_id,step_index,decision,comment) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,user.id,a.current_step,input.decision,input.comment]);
  if(input.decision==='later') {
   const cfg=await config(db); await db.query("UPDATE approvals SET deferred_until=now()+($2 * interval '1 minute') WHERE id=$1",[id,input.remindMinutes||cfg.config.reminderMinutes]);
   await event(db,task.id,user.id,'approval_later','Согласующий вернётся к решению позже',{approvalId:id,comment:input.comment}); return {state:'pending'};
  }
  if(input.decision==='reject') {
   await db.query("UPDATE approvals SET state='rejected',deferred_until=NULL WHERE id=$1",[id]);
   if(a.type==='completion'&&task.status==='review'){
    const returned=(await db.query<Task>("UPDATE tasks SET status='active',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[task.id])).rows[0];
    await adapters.tasks.applyApprovedChange(db,returned,task.version);
    await db.query("UPDATE task_submissions SET state='returned',reviewer_id=$2,remark=$3,decided_at=now() WHERE task_id=$1 AND state='review' AND withdrawn_at IS NULL",[task.id,user.id,input.comment]);
    await event(db,task.id,user.id,'review_returned','Результат возвращён в работу',{approvalId:id,before:task,after:returned,comment:input.comment});
    await refreshTaskFindings(db,returned,user);
    if(task.assignee_id!==a.requester_id)await notify(db,task.id,task.assignee_id,'Результат по задаче #'+task.id+' возвращён. '+input.comment,'review-return:'+id);
   }
   await event(db,task.id,user.id,'approval_rejected','В изменении отказано',{approvalId:id,comment:input.comment});
   await notify(db,task.id,a.requester_id,`По задаче #${task.id} отказано. ${input.comment}`,`rejected:${id}`);
  } else if(a.current_step<a.route.length-1) {
   await db.query(`UPDATE approvals SET current_step=current_step+1,deferred_until=NULL,
    clarification_question=NULL,clarification_answer=NULL,clarification_requested_at=NULL,clarification_answered_at=NULL WHERE id=$1`,[id]);
   await event(db,task.id,user.id,'step_approved',`Этап согласован: ${a.route[a.current_step].label}`,{approvalId:id,comment:input.comment});
   const next=a.route[a.current_step+1];
   if(next.userId!==hierarchy?.sales_head_id)await notify(db,task.id,next.userId,`Требуется ваше решение по задаче #${task.id}`,`approval:${id}:${a.current_step+1}`);
  } else {
   const approvedDeadline=a.type==='deadline'?(input.approvedDeadline??a.proposed_deadline):null;
   const deadlineAlreadySet=!!approvedDeadline&&Date.parse(approvedDeadline)===Date.parse(task.deadline??'');
   if(a.type==='deadline'&&!deadlineAlreadySet)assert(approvedDeadline&&Date.parse(approvedDeadline)>Date.now(),409,'Предложенный срок уже прошёл. Выберите актуальный срок или отклоните запрос.');
   const deadlineChangedByApprover=!!approvedDeadline&&Date.parse(approvedDeadline)!==Date.parse(a.proposed_deadline??'');
   const next=deadlineAlreadySet?task:a.type==='deadline'?
    (await db.query('UPDATE tasks SET deadline=$2,transfer_count=transfer_count+1,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[task.id,approvedDeadline])).rows[0]:
    (await db.query("UPDATE tasks SET status='completed',completed_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[task.id])).rows[0];
   if(!deadlineAlreadySet)await adapters.tasks.applyApprovedChange(db,next,task.version);
   if(a.type==='completion')await db.query("UPDATE task_submissions SET state='accepted',reviewer_id=$2,remark=$3,decided_at=now() WHERE task_id=$1 AND state='review' AND withdrawn_at IS NULL",[task.id,user.id,input.comment||'Результат принят по маршруту согласования.']);
   await db.query("UPDATE approvals SET state='approved',approved_deadline=$2,deferred_until=NULL WHERE id=$1",[id,approvedDeadline]);
   await event(db,task.id,user.id,deadlineAlreadySet?'deadline_confirmed':a.type==='deadline'?'deadline_changed':'task_completed',deadlineAlreadySet?'Перенос согласован. Предложенный крайний срок уже установлен.':a.type==='deadline'?'Перенос согласован, крайний срок изменён':'Закрытие согласовано, задача завершена',{approvalId:id,before:task,after:next,comment:input.comment,reason:a.reason,...(a.type==='deadline'?{proposedDeadline:a.proposed_deadline,approvedDeadline}:{plan:a.plan})});
   if(a.type==='completion'&&task.assignee_id!==a.requester_id)await notify(db,task.id,task.assignee_id,'Результат по задаче #'+task.id+' принят.','review-accepted:'+id);
   // Re-evaluate the affected task in the same transaction; no stale violations in the UI.
   const cfg=await config(db), remaining=evaluate(next,cfg.config,new Date(),await visibleTasks(user,db));
   await db.query("UPDATE findings SET status='resolved' WHERE task_id=$1 AND NOT(rule=ANY($2))",[task.id,remaining.map(f=>f.rule)]);
   if(!remaining.length) await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[task.id]);
   if(approvedDeadline){
    const msk=new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'});
    const original=a.proposed_deadline?msk.format(new Date(a.proposed_deadline)):null;
    const text=`Перенос задачи #${task.id} согласован. Итоговый крайний срок — ${msk.format(new Date(approvedDeadline))} МСК.`
     +(deadlineChangedByApprover&&original?` В запросе был указан ${original} МСК.`:'');
    await notify(db,task.id,a.requester_id,text,`approved:${id}`);
    if(deadlineChangedByApprover&&task.assignee_id!==a.requester_id)
     await notify(db,task.id,task.assignee_id,text,`approved-assignee:${id}`);
   }else await notify(db,task.id,a.requester_id,`Изменение по задаче #${task.id} согласовано и применено в локальной системе.`,`approved:${id}`);
  }
  await adapters.telegram.dispatch(db); return {state:input.decision==='reject'?'rejected':a.current_step===a.route.length-1?'approved':'pending'};
 });
}
async function answerClarificationCore(user:User,id:string,answer:string,expectedRevision?:number){
 return transaction(async db=>{
  const found=(await db.query('SELECT task_id FROM approvals WHERE id=$1',[id])).rows[0];assert(found,404,'Согласование не найдено.');
  const task=await taskFor(db,found.task_id,user,true);
  const a=(await db.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE',[id])).rows[0] as Approval;
  assert(a.requester_id===user.id,403,'Ответить может автор запроса.');
  assert(a.state==='pending'&&!a.canceled_at&&a.task_version===task.version&&!a.task_change?.routeIssue&&
   a.clarification_requested_at&&!a.clarification_answered_at,409,'Здесь не ожидается уточнение.');
  assert(expectedRevision===undefined||expectedRevision===a.action_revision,409,'Вопрос обновился. Откройте согласование и ответьте на актуальный вопрос.');
  await db.query('UPDATE approvals SET clarification_answer=$2,clarification_answered_at=now(),action_revision=action_revision+1 WHERE id=$1',[id,answer]);
  await db.query("INSERT INTO comments(id,task_id,author_id,body,kind,approval_id) VALUES($1,$2,$3,$4,'clarification',$5)",[randomUUID(),a.task_id,user.id,`Ответ на уточнение: ${answer}`,id]);
  await event(db,a.task_id,user.id,'approval_clarification_answered','Автор запроса ответил на уточнение',{approvalId:id,step:a.current_step,answer});
  await db.query("UPDATE outbox SET withdrawn_at=now() WHERE recipient_id=$1 AND dedupe_key LIKE $2 AND read_at IS NULL AND withdrawn_at IS NULL",
   [user.id,'clarify:'+id+':%']);
  await notify(db,a.task_id,a.route[a.current_step].userId,`Получен ответ на уточнение по задаче #${a.task_id}. Этап ${a.current_step+1} из ${a.route.length} ждёт вашего решения.\n${answer}`,
   `clarification-answer:${id}:${a.action_revision+1}`);
  await adapters.telegram.dispatch(db);return {state:'pending',clarification:'answered'};
 });
}
export async function remind(user:User,now=new Date()) {
 assert(canManage(user),403,'Недостаточно прав.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431002)'); const cfg=await config(db), ids=(await visibleTasks(user,db)).map(t=>t.id); let count=0;
  const hierarchy=await approvalHierarchy(db),scope=await staffWorkIds(db);
  const controls=(await db.query("SELECT * FROM control_requests WHERE task_id=ANY($1) AND state='waiting' AND due_at<=$2",[ids,now])).rows as ControlRequest[];
  for(const candidate of controls) {
   const task=await taskFor(db,candidate.task_id,user,true);
   if(!controlsTask(task,scope))continue;
   const c=(await db.query("SELECT * FROM control_requests WHERE id=$1 AND state='waiting' AND due_at<=$2 FOR UPDATE",[candidate.id,now])).rows[0] as ControlRequest|undefined;if(!c)continue; const escalated=c.reminders>=cfg.config.maxReminders;
   const recipient=escalated?(hierarchy?.direct_assignee_ids?hierarchy.sales_head_id:(await routeFor(db,task,['branchManager']))[0].userId):c.assignee_id;
   await notify(db,c.task_id,recipient,`${escalated?'Эскалация руководителю':'Напоминание'}: нет объяснения по задаче #${c.task_id}`,`remind:${c.id}:${c.reminders}`);
   await db.query("UPDATE control_requests SET state=$2,reminders=reminders+1,due_at=$3 WHERE id=$1",[c.id,escalated?'escalated':'waiting',new Date(now.getTime()+cfg.config.reminderMinutes*60000)]);
   await event(db,c.task_id,user.id,escalated?'escalated':'reminder',escalated?'Отсутствие ответа передано руководителю':'Отправлено тестовое напоминание');count++;
  }
  const postponed=(await db.query("SELECT * FROM approvals WHERE task_id=ANY($1) AND state='pending' AND deferred_until<=$2",[ids,now])).rows as Approval[];
  for(const candidate of postponed){await taskFor(db,candidate.task_id,user,true);const a=(await db.query("SELECT * FROM approvals WHERE id=$1 AND state='pending' AND deferred_until<=$2 FOR UPDATE",[candidate.id,now])).rows[0] as Approval|undefined;if(!a)continue;await notify(db,a.task_id,a.route[a.current_step].userId,`Вы отложили решение по задаче #${a.task_id}. Вернитесь к согласованию.`,`defer:${a.id}:${a.deferred_until}`);await db.query('UPDATE approvals SET deferred_until=NULL WHERE id=$1',[a.id]);count++;}
  await adapters.telegram.dispatch(db);return {count};
 });
}
export async function makeReport(user:User,kind='snapshot',slot='manual',capturedAt=new Date(),parameters:ReportParameters={},controlledOnly=false) {
 return generateReport(user,kind,slot,capturedAt,parameters,controlledOnly);
}
export async function listReports(user:User,input:{kind?:string;from?:string;to?:string;view?:ReportView;page:number}){
 return transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const args=[reportScopes(user,input.view),input.kind||null,input.from||null,input.to||null,!!(await config(db)).config.showPlanning];
  const condition="scope=ANY($1) AND ($2::text IS NULL OR kind=$2) AND ($3::date IS NULL OR day>=$3) AND ($4::date IS NULL OR day<=$4) AND ($5::boolean OR kind<>'nextday' OR scope LIKE 'user:%')";
  const total=Number((await db.query('SELECT count(*) n FROM reports WHERE '+condition,args)).rows[0].n);
  const items=(await db.query('SELECT id,day,scope,metrics,rules_version,created_at,kind,activity,slot,formula_version,parameters,summary FROM reports WHERE '+condition+' ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $6',[...args,input.page*20])).rows;
  return {items,total,page:input.page,pageSize:20};
 });
}
export async function getReport(user:User,id:string){const report=(await pool.query('SELECT * FROM reports WHERE id=$1 AND scope=ANY($2)',[id,reportScopes(user)])).rows[0];assert(report,404,'Отчёт не найден или недоступен.');return report;}
export async function saveRules(user:User,rules:Rules,expectedVersion:number) {
 assert(user.role==='admin',403,'Настройки меняет администратор.');
 for(const rule of rules.writtenRules||[])assert(parseWrittenRule(rule.text),400,'Неизвестная формулировка письменного правила: выберите поддерживаемый шаблон.');
 return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(431003)');const current=await config(db);assert(current.version===expectedVersion,409,'Настройки уже изменены. Обновите страницу.');const result=await db.query('INSERT INTO rule_versions(config,author_id) VALUES($1,$2) RETURNING version',[JSON.stringify(rules),user.id]);await event(db,null,user.id,'rules_changed','Обновлены правила контроля',{before:current.config,after:rules,version:result.rows[0].version});return result.rows[0];});
}
export async function simulateExternalChange(user:User,id:string,expectedVersion:number) {
 assert(user.role==='admin',403,'Только администратор может изменять тестовый источник.');
 return transaction(async db=>{const before=await taskFor(db,id,user,true);assert(before.version===expectedVersion,409,'Задача изменилась.');const after=(await db.query("UPDATE tasks SET description=description || E'\nУточнение из тестового источника.',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];await adapters.tasks.applyApprovedChange(db,after,before.version);await keepTaskApprovals(db,before,after,['description'],'ruspet',user.id);await event(db,id,user.id,'external_change','Изменение из mock-источника',{before,after});});
}

export async function addComment(...args:Parameters<typeof addCommentCore>){const taskId=args[1];return recordTaskAction(args[0],taskId,'Комментарий',()=>addCommentCore(...args));}

export async function answerControl(...args:Parameters<typeof answerControlCore>){const taskId=(await pool.query('SELECT task_id FROM control_requests WHERE id=$1',[args[1]])).rows[0]?.task_id;if(!taskId)return answerControlCore(...args);return recordTaskAction(args[0],taskId,'Ответ на запрос контроля',()=>answerControlCore(...args));}

export async function requestApproval(...args:Parameters<typeof requestApprovalCore>){const taskId=args[1];return recordTaskAction(args[0],taskId,'Запрос согласования',()=>requestApprovalCore(...args));}

export async function decide(...args:Parameters<typeof decideCore>){
 return transaction(async db=>{
  const taskId=(await db.query('SELECT task_id FROM approvals WHERE id=$1',[args[1]])).rows[0]?.task_id;
  if(!taskId)return decideCore(...args);
  return recordTaskAction(args[0],taskId,args[2].decision==='clarify'?'Запрос уточнения':'Решение по согласованию',()=>decideCore(...args));
 });
}

export async function answerClarification(...args:Parameters<typeof answerClarificationCore>){
 return transaction(async db=>{
  const taskId=(await db.query('SELECT task_id FROM approvals WHERE id=$1',[args[1]])).rows[0]?.task_id;
  if(!taskId)return answerClarificationCore(...args);
  return recordTaskAction(args[0],taskId,'Ответ на уточнение',()=>answerClarificationCore(...args));
 });
}
