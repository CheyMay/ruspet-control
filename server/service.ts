import {delegatedTaskAccepted} from './delegation-review.js';
import {taskEditAccess} from './task-edit-permissions.js';
import {lockDelegationChain,requireAcceptedDelegations} from './delegation-lock.js';
import {recordTaskAction} from './undo-record.js';
import {enqueueBitrixOperation} from './bitrix-live.js';
import {generateReport} from './reports-v5.js';
import type {ReportParameters} from '../shared/report-parameters.js';
import {parseWrittenRule} from '../shared/written-rules.js';
import {exclusionReason} from '../shared/task-selection.js';
import {reportAnalysis} from '../shared/reporting.js';
import {plannedMinutesOn,plannedInterval} from '../shared/analytics.js';
import { taskQueue } from '../shared/queues.js';
import { randomUUID } from 'node:crypto';
import { pool, transaction, type Db } from './db.js';
import type { Task, User, Rules, Approval, ControlRequest, Step } from '../shared/types.js';
import { assert, canAccess, canSee, canRequest, canManage, globalAccess, evaluate, metrics, moscowDay } from './domain.js';
import { providers } from './providers.js';
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
 await notify(db,task.id,task.assignee_id,label+' #'+task.id+' · '+task.title,`task-assignment:${task.id}:${task.version}`,true);
}
export async function config(db:Db=pool):Promise<{version:number;config:Rules}> { const row=(await db.query('SELECT * FROM rule_versions ORDER BY version DESC LIMIT 1')).rows[0];return {...row,config:{requiredPrice:true,showPlanning:false,writtenRules:[],...row.config}}; }
export async function visibleTasksForCompany(user:User,id:string):Promise<Task[]>{
 return (await pool.query<Task>("SELECT * FROM tasks WHERE company_id=$1 ORDER BY (status='completed'),updated_at DESC,id",[id])).rows.filter(t=>canSee(user,t));
}
export async function visibleTasks(user:User,db:Db=pool):Promise<Task[]> { return (await db.query('SELECT * FROM tasks ORDER BY deadline ASC NULLS LAST,id')).rows.filter(t=>canSee(user,t)); }
async function taskFor(db:Db,id:string,user:User,lock=false):Promise<Task> {
 if(lock)await lockDelegationChain(db,id);
 const task=(await db.query(`SELECT * FROM tasks WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
 assert(task && canSee(user,task),404,'Задача не найдена или недоступна.'); return task;
}
export async function bootstrap(user:User,light=false) {
 return transaction(async db=>{
 await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const tasks=await visibleTasks(user,db), ids=tasks.map(t=>t.id), cfg=await config(db);
 const approvals=(await db.query('SELECT * FROM approvals WHERE task_id=ANY($1) ORDER BY created_at DESC',[ids])).rows;
 const editRequests=(await db.query(`SELECT p.id,p.task_id,t.creator_id,p.created_at FROM task_edit_permissions p JOIN tasks t ON t.id=p.task_id
  WHERE p.task_id=ANY($1) AND t.status='active' AND p.state='pending' AND p.task_version=t.version AND p.requester_id=t.assignee_id`,[ids])).rows;
 const controls=(await db.query('SELECT * FROM control_requests WHERE task_id=ANY($1) ORDER BY created_at DESC',[ids])).rows;
 const users=(await db.query('SELECT * FROM users ORDER BY name')).rows.filter((u:User)=>globalAccess(user)||u.branch_id===user.branch_id||u.id===user.id||tasks.some(t=>t.creator_id===u.id||t.assignee_id===u.id)||approvals.some((a:Approval)=>a.route.some(s=>s.userId===u.id)));
 if(light)return {user,users,tasks,approvals,editRequests,controls,submissions:(await db.query('SELECT * FROM task_submissions WHERE withdrawn_at IS NULL AND task_id=ANY($1) ORDER BY submitted_at DESC',[ids])).rows,rules:cfg.config,rulesVersion:cfg.version,serverTime:new Date().toISOString(),metrics:metrics(tasks,approvals,controls),source:null,findings:[],events:[],notifications:[],reports:[]};
 const available=(await db.query('SELECT * FROM tasks')).rows.filter(t=>canAccess(user,t));
 const selection={total:available.length,included:tasks.length,checklist:available.filter(t=>exclusionReason(t)==='checklist').length,unfinishedAnalysis:available.filter(t=>exclusionReason(t)==='unfinished_analysis').length};
 const lastTaskChange=(await db.query("SELECT max(created_at) AS at FROM task_events WHERE task_id=ANY($1) AND (kind=ANY($2) OR (data ? 'before' AND data ? 'after'))",[ids,['created','task_edited','task_completed','deadline_changed','review_submitted','review_returned','action_undone']])).rows[0].at;
 return {lastTaskChange,selection,user,users,tasks,approvals,editRequests,controls,approvalComments:(await db.query('SELECT * FROM comments WHERE task_id=ANY($1) AND approval_id IS NOT NULL AND withdrawn_at IS NULL ORDER BY created_at',[ids])).rows,submissions:(await db.query('SELECT * FROM task_submissions WHERE withdrawn_at IS NULL AND task_id=ANY($1) ORDER BY submitted_at DESC',[ids])).rows,rules:cfg.config,rulesVersion:cfg.version,serverTime:new Date().toISOString(),metrics:metrics(tasks,approvals,controls),source:(await db.query('SELECT file_name,sheet_name,row_count,imported_at,assumptions FROM import_batches ORDER BY imported_at DESC LIMIT 1')).rows[0]||null,
 findings:(await db.query("SELECT * FROM findings WHERE task_id=ANY($1) AND status='open'",[ids])).rows.filter(f=>cfg.config.showPlanning||!planningFindings.has(f.rule)),
 events:(await db.query('SELECT * FROM task_events WHERE task_id=ANY($1) OR (task_id IS NULL AND $2) ORDER BY created_at DESC LIMIT 250',[ids,globalAccess(user)])).rows,
 notifications:(await db.query('SELECT id,task_id,recipient_id,body,state,created_at,read_at,task_notice FROM outbox WHERE withdrawn_at IS NULL AND NOT task_assignment AND recipient_id=$1 AND (task_id IS NULL OR task_id=ANY($2)) ORDER BY created_at DESC LIMIT 150',[user.id,ids])).rows,
 reports:(await db.query('SELECT id,day,scope,metrics,rules_version,created_at,kind,activity,slot,formula_version,parameters,summary FROM reports WHERE scope=$1 AND ($2::boolean OR kind<>\'nextday\') ORDER BY created_at DESC LIMIT 100',[scopeFor(user),!!cfg.config.showPlanning])).rows};
 });
}
export async function detail(user:User,id:string,db:Db=pool) {
 const task=await taskFor(db,id,user);
 return {
  task,editAccess:await taskEditAccess(user,task,db),
  submissions:(await db.query('SELECT * FROM task_submissions WHERE withdrawn_at IS NULL AND task_id=$1 ORDER BY round DESC',[id])).rows,
  comments:(await db.query('SELECT * FROM comments WHERE withdrawn_at IS NULL AND task_id=$1 ORDER BY created_at',[id])).rows,
  events:(await db.query('SELECT * FROM task_events WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows,
  approvals:(await db.query('SELECT * FROM approvals WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows,
  decisions:(await db.query('SELECT d.*,EXISTS(SELECT 1 FROM decision_retractions r WHERE r.decision_id=d.id) retracted FROM decisions d JOIN approvals a ON a.id=d.approval_id WHERE a.task_id=$1 ORDER BY d.created_at',[id])).rows,
  controls:(await db.query('SELECT * FROM control_requests WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows
 };
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
 const findings=evaluate(task,(await config(db)).config,new Date(),await visibleTasks(user,db));
 await db.query("UPDATE findings SET status='resolved' WHERE task_id=$1 AND NOT(rule=ANY($2))",[task.id,findings.map(f=>f.rule)]);
 for(const f of findings)await db.query("INSERT INTO findings(id,task_id,rule,severity,message,status) VALUES($1,$2,$3,$4,$5,'open') ON CONFLICT(task_id,rule) DO UPDATE SET status='open',last_seen=now(),message=excluded.message,severity=excluded.severity",[randomUUID(),task.id,f.rule,f.severity,f.message]);
 if(!findings.some(f=>f.severity!=='info'))await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[task.id]);
 return findings;
}
export async function runChecks(user:User,now=new Date()) {
 assert(canManage(user),403,'Запуск проверки доступен руководителю.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431002)');
  const cfg=await config(db); let found=0;
  const allTasks=await visibleTasks(user,db);
  for(const visible of allTasks) {
   const task=await taskFor(db,visible.id,user,true), findings=evaluate(task,cfg.config,now,allTasks); found+=findings.length;
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
  const matches=users.filter(u=>selector==='branchManager'?u.role==='branch_manager'&&u.branch_id===task.branch_id:selector==='creator'?u.id===task.creator_id:u.role===(selector==='salesHead'?'sales_head':'director'));
  assert(matches.length===1,422,matches.length?`Неоднозначный маршрут: несколько согласующих «${labels[selector]}». Настройте реальные роли и филиалы.`:`Не назначен согласующий: ${labels[selector]}`);return {userId:matches[0].id,label:labels[selector]};
 });
}
async function requestApprovalCore(user:User,id:string,input:{type:'deadline'|'completion';reason:string;plan:string;proposedDeadline?:string;expectedVersion:number}) {
 return transaction(async db=>{
  const task=await taskFor(db,id,user,true); assert(canRequest(user,task),403,'У вас нет права запрашивать изменение.');
  assert(task.version===input.expectedVersion,409,'Задача изменилась. Обновите карточку.');
  assert(task.status!=='completed',409,'Задача уже завершена.');
  assert(!(await db.query("SELECT 1 FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rowCount,409,'У задачи уже есть активное согласование.');
  const cfg=await config(db); assert(input.reason.trim().length>=cfg.config.responseMinLength&&input.plan.trim().length>=cfg.config.responseMinLength,400,`Причина и план: минимум ${cfg.config.responseMinLength} символов.`);
  if(input.type==='deadline') { assert(input.proposedDeadline&&new Date(input.proposedDeadline)>new Date(),400,'Новый срок должен быть в будущем.'); assert(new Date(input.proposedDeadline).getTime()!==new Date(task.deadline||0).getTime(),400,'Новый срок совпадает с текущим.'); }
  const route=await routeFor(db,task,cfg.config.routes[input.type]);
  assert(route.length>0,422,'Маршрут не настроен.'); assert(!route.some(s=>s.userId===user.id),422,'В демонстрационном маршруте запрещено согласование собственного запроса.');
  const approvalId=randomUUID();
  await db.query("INSERT INTO approvals(id,task_id,requester_id,type,reason,plan,proposed_deadline,task_version,state,route,route_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)",[approvalId,id,user.id,input.type,input.reason,input.plan,input.proposedDeadline||null,task.version,JSON.stringify(route),cfg.version]);
  await event(db,id,user.id,'approval_requested',input.type==='deadline'?'Запрошен перенос срока':'Запрошено закрытие задачи',{approvalId,oldDeadline:task.deadline,newDeadline:input.proposedDeadline,version:task.version,reason:input.reason,plan:input.plan,route});
  await notify(db,id,route[0].userId,`Требуется решение по задаче #${id}: ${input.reason}`,`approval:${approvalId}:0`); await adapters.telegram.dispatch(db);
  return {id:approvalId};
 });
}
async function decideCore(user:User,id:string,input:{decision:'approve'|'reject'|'later'|'clarify';comment:string;expectedStep?:number;expectedRevision?:number;remindMinutes?:number}) {
 return transaction(async db=>{
  const first=(await db.query('SELECT task_id FROM approvals WHERE id=$1',[id])).rows[0]; assert(first,404,'Согласование не найдено.');
  const task=await taskFor(db,first.task_id,user,true);
  const a=(await db.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE',[id])).rows[0] as Approval;
  assert(input.expectedRevision===undefined?a.action_revision===1:input.expectedRevision===a.action_revision,409,'Согласование изменилось после отмены. Откройте актуальную карточку.');
  assert(input.expectedStep===undefined||input.expectedStep===a.current_step,409,'Этот этап уже завершён. Откройте актуальное решение.');
  assert(a.state==='pending',409,'Решение уже принято или запрос устарел.');
  assert(a.route[a.current_step].userId===user.id,403,'Сейчас решение принимает другой согласующий.');
  assert(!a.clarification_requested_at||a.clarification_answered_at,409,'Сначала дождитесь ответа на уточнение.');
  if(a.task_version!==task.version) {
   await db.query("UPDATE approvals SET state='stale' WHERE id=$1",[id]); await event(db,task.id,user.id,'approval_stale','Согласование остановлено: задача изменилась',{approvalId:id});
   return {state:'stale'};
  }
  if(input.decision!=='later')assert(input.comment.trim().length>=5,400,'Комментарий к решению обязателен, минимум 5 символов.');
  await db.query('INSERT INTO decisions(id,approval_id,actor_id,step_index,decision,comment) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,user.id,a.current_step,input.decision,input.comment]);
  if(input.decision==='clarify') {
   assert(input.comment.trim().length>=5,400,'Напишите вопрос для автора запроса (не менее 5 символов).');
   await db.query('UPDATE approvals SET clarification_question=$2,clarification_answer=NULL,clarification_requested_at=now(),clarification_answered_at=NULL,deferred_until=NULL WHERE id=$1',[id,input.comment]);
   await db.query("INSERT INTO comments(id,task_id,author_id,body,kind,approval_id) VALUES($1,$2,$3,$4,'clarification',$5)",[randomUUID(),task.id,user.id,`Уточнение по согласованию: ${input.comment}`,id]);
   await event(db,task.id,user.id,'approval_clarification_requested','Согласующий запросил уточнение',{approvalId:id,question:input.comment});
   await notify(db,task.id,a.requester_id,`По задаче #${task.id} нужен ответ: ${input.comment}`,`clarify:${id}:${Date.now()}`);
   await adapters.telegram.dispatch(db);return {state:'pending',clarification:'requested'};
  }
  if(input.decision==='later') {
   const cfg=await config(db); await db.query("UPDATE approvals SET deferred_until=now()+($2 * interval '1 minute') WHERE id=$1",[id,input.remindMinutes||cfg.config.reminderMinutes]);
   await event(db,task.id,user.id,'approval_later','Согласующий вернётся к решению позже',{approvalId:id,comment:input.comment}); return {state:'pending'};
  }
  if(input.decision==='reject') {
   await db.query("UPDATE approvals SET state='rejected',deferred_until=NULL WHERE id=$1",[id]);
   await event(db,task.id,user.id,'approval_rejected','В изменении отказано',{approvalId:id,comment:input.comment});
   await notify(db,task.id,a.requester_id,`По задаче #${task.id} отказано. ${input.comment}`,`rejected:${id}`);
  } else if(a.current_step<a.route.length-1) {
   await db.query('UPDATE approvals SET current_step=current_step+1,deferred_until=NULL WHERE id=$1',[id]);
   await event(db,task.id,user.id,'step_approved',`Этап согласован: ${a.route[a.current_step].label}`,{approvalId:id,comment:input.comment});
   await notify(db,task.id,a.route[a.current_step+1].userId,`Требуется ваше решение по задаче #${task.id}`,`approval:${id}:${a.current_step+1}`);
  } else {
   if(a.type==='deadline') assert(a.proposed_deadline&&new Date(a.proposed_deadline)>new Date(),409,'Предложенный срок уже прошёл. Откажите и создайте новый запрос.');
   const next=a.type==='deadline'?
    (await db.query('UPDATE tasks SET deadline=$2,transfer_count=transfer_count+1,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[task.id,a.proposed_deadline])).rows[0]:
    (await db.query("UPDATE tasks SET status='completed',completed_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[task.id])).rows[0];
   await adapters.tasks.applyApprovedChange(db,next,task.version);
   if(a.type==='completion')await db.query("UPDATE task_submissions SET state='accepted',reviewer_id=$2,remark=$3,decided_at=now() WHERE task_id=$1 AND state='review' AND withdrawn_at IS NULL",[task.id,user.id,input.comment||'Результат принят по маршруту согласования.']);
   await db.query("UPDATE approvals SET state='approved',deferred_until=NULL WHERE id=$1",[id]);
   await event(db,task.id,user.id,a.type==='deadline'?'deadline_changed':'task_completed',a.type==='deadline'?'Перенос согласован, крайний срок изменён':'Закрытие согласовано, задача завершена',{approvalId:id,before:task,after:next,comment:input.comment,reason:a.reason,plan:a.plan});
   // Re-evaluate the affected task in the same transaction; no stale violations in the UI.
   const cfg=await config(db), remaining=evaluate(next,cfg.config,new Date(),await visibleTasks(user,db));
   await db.query("UPDATE findings SET status='resolved' WHERE task_id=$1 AND NOT(rule=ANY($2))",[task.id,remaining.map(f=>f.rule)]);
   if(!remaining.length) await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[task.id]);
   await notify(db,task.id,a.requester_id,`Изменение по задаче #${task.id} согласовано и применено в локальной системе.`,`approved:${id}`);
  }
  await adapters.telegram.dispatch(db); return {state:input.decision==='reject'?'rejected':a.current_step===a.route.length-1?'approved':'pending'};
 });
}
async function answerClarificationCore(user:User,id:string,answer:string){
 return transaction(async db=>{
  const found=(await db.query('SELECT task_id FROM approvals WHERE id=$1',[id])).rows[0];assert(found,404,'Согласование не найдено.');
  await taskFor(db,found.task_id,user);
  const a=(await db.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE',[id])).rows[0] as Approval;
  assert(a.requester_id===user.id,403,'Ответить может автор запроса.');
  assert(a.state==='pending'&&a.clarification_requested_at&&!a.clarification_answered_at,409,'Здесь не ожидается уточнение.');
  await db.query('UPDATE approvals SET clarification_answer=$2,clarification_answered_at=now() WHERE id=$1',[id,answer]);
  await db.query("INSERT INTO comments(id,task_id,author_id,body,kind,approval_id) VALUES($1,$2,$3,$4,'clarification',$5)",[randomUUID(),a.task_id,user.id,`Ответ на уточнение: ${answer}`,id]);
  await event(db,a.task_id,user.id,'approval_clarification_answered','Автор запроса ответил на уточнение',{approvalId:id,answer});
  await notify(db,a.task_id,a.route[a.current_step].userId,`Получен ответ по задаче #${a.task_id}: ${answer}`,`clarification-answer:${id}:${Date.now()}`);
  await adapters.telegram.dispatch(db);return {state:'pending',clarification:'answered'};
 });
}
export async function remind(user:User,now=new Date()) {
 assert(canManage(user),403,'Недостаточно прав.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431002)'); const cfg=await config(db), ids=(await visibleTasks(user,db)).map(t=>t.id); let count=0;
  const controls=(await db.query("SELECT * FROM control_requests WHERE task_id=ANY($1) AND state='waiting' AND due_at<=$2",[ids,now])).rows as ControlRequest[];
  for(const candidate of controls) {
   const task=await taskFor(db,candidate.task_id,user,true);
   const c=(await db.query("SELECT * FROM control_requests WHERE id=$1 AND state='waiting' AND due_at<=$2 FOR UPDATE",[candidate.id,now])).rows[0] as ControlRequest|undefined;if(!c)continue; const escalated=c.reminders>=cfg.config.maxReminders;
   const recipient=escalated?(await routeFor(db,task,['branchManager']))[0].userId:c.assignee_id;
   await notify(db,c.task_id,recipient,`${escalated?'Эскалация руководителю':'Напоминание'}: нет объяснения по задаче #${c.task_id}`,`remind:${c.id}:${c.reminders}`);
   await db.query("UPDATE control_requests SET state=$2,reminders=reminders+1,due_at=$3 WHERE id=$1",[c.id,escalated?'escalated':'waiting',new Date(now.getTime()+cfg.config.reminderMinutes*60000)]);
   await event(db,c.task_id,user.id,escalated?'escalated':'reminder',escalated?'Отсутствие ответа передано руководителю':'Отправлено тестовое напоминание');count++;
  }
  const postponed=(await db.query("SELECT * FROM approvals WHERE task_id=ANY($1) AND state='pending' AND deferred_until<=$2",[ids,now])).rows as Approval[];
  for(const candidate of postponed){await taskFor(db,candidate.task_id,user,true);const a=(await db.query("SELECT * FROM approvals WHERE id=$1 AND state='pending' AND deferred_until<=$2 FOR UPDATE",[candidate.id,now])).rows[0] as Approval|undefined;if(!a)continue;await notify(db,a.task_id,a.route[a.current_step].userId,`Вы отложили решение по задаче #${a.task_id}. Вернитесь к согласованию.`,`defer:${a.id}:${a.deferred_until}`);await db.query('UPDATE approvals SET deferred_until=NULL WHERE id=$1',[a.id]);count++;}
  await adapters.telegram.dispatch(db);return {count};
 });
}
function scopeFor(user:User) { return globalAccess(user)?'company':user.role==='branch_manager'?`branch:${user.branch_id}`:`user:${user.id}`; }
export async function makeReport(user:User,kind='snapshot',slot='manual',capturedAt=new Date(),parameters:ReportParameters={}) {return generateReport(user,kind,slot,capturedAt,parameters);}
export async function listReports(user:User,input:{kind?:string;from?:string;to?:string;page:number}){
 return transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const args=[scopeFor(user),input.kind||null,input.from||null,input.to||null,!!(await config(db)).config.showPlanning];
  const condition='scope=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::date IS NULL OR day>=$3) AND ($4::date IS NULL OR day<=$4) AND ($5::boolean OR kind<>\'nextday\')';
  const total=Number((await db.query('SELECT count(*) n FROM reports WHERE '+condition,args)).rows[0].n);
  const items=(await db.query('SELECT id,day,scope,metrics,rules_version,created_at,kind,activity,slot,formula_version,parameters,summary FROM reports WHERE '+condition+' ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $6',[...args,input.page*20])).rows;
  return {items,total,page:input.page,pageSize:20};
 });
}
export async function getReport(user:User,id:string){const report=(await pool.query('SELECT * FROM reports WHERE id=$1 AND scope=$2',[id,scopeFor(user)])).rows[0];assert(report,404,'Отчёт не найден или недоступен.');return report;}
export async function saveRules(user:User,rules:Rules,expectedVersion:number) {
 assert(user.role==='admin',403,'Настройки меняет администратор.');
 for(const rule of rules.writtenRules||[])assert(parseWrittenRule(rule.text),400,'Неизвестная формулировка письменного правила: выберите поддерживаемый шаблон.');
 return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(431003)');const current=await config(db);assert(current.version===expectedVersion,409,'Настройки уже изменены. Обновите страницу.');const result=await db.query('INSERT INTO rule_versions(config,author_id) VALUES($1,$2) RETURNING version',[JSON.stringify(rules),user.id]);await event(db,null,user.id,'rules_changed','Обновлены правила контроля',{before:current.config,after:rules,version:result.rows[0].version});return result.rows[0];});
}
export async function simulateExternalChange(user:User,id:string,expectedVersion:number) {
 assert(user.role==='admin',403,'Только администратор может изменять тестовый источник.');
 return transaction(async db=>{const before=await taskFor(db,id,user,true);assert(before.version===expectedVersion,409,'Задача изменилась.');const after=(await db.query("UPDATE tasks SET description=description || E'\nУточнение из тестового источника.',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];await adapters.tasks.applyApprovedChange(db,after,before.version);await db.query("UPDATE approvals SET state='stale' WHERE task_id=$1 AND state='pending'",[id]);await event(db,id,user.id,'external_change','Изменение из mock-источника; активный запрос требует повторного согласования',{before,after});});
}

export async function addComment(...args:Parameters<typeof addCommentCore>){const taskId=args[1];return recordTaskAction(args[0],taskId,'Комментарий',()=>addCommentCore(...args));}

export async function answerControl(...args:Parameters<typeof answerControlCore>){const taskId=(await pool.query('SELECT task_id FROM control_requests WHERE id=$1',[args[1]])).rows[0]?.task_id;if(!taskId)return answerControlCore(...args);return recordTaskAction(args[0],taskId,'Ответ на запрос контроля',()=>answerControlCore(...args));}

export async function requestApproval(...args:Parameters<typeof requestApprovalCore>){const taskId=args[1];return recordTaskAction(args[0],taskId,'Запрос согласования',()=>requestApprovalCore(...args));}

export async function decide(...args:Parameters<typeof decideCore>){const taskId=(await pool.query('SELECT task_id FROM approvals WHERE id=$1',[args[1]])).rows[0]?.task_id;if(!taskId)return decideCore(...args);return recordTaskAction(args[0],taskId,'Решение по согласованию',()=>decideCore(...args));}

export async function answerClarification(...args:Parameters<typeof answerClarificationCore>){const taskId=(await pool.query('SELECT task_id FROM approvals WHERE id=$1',[args[1]])).rows[0]?.task_id;if(!taskId)return answerClarificationCore(...args);return recordTaskAction(args[0],taskId,'Ответ на уточнение',()=>answerClarificationCore(...args));}
