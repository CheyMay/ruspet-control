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
export async function event(db:Db,taskId:string|null,actor:string|null,kind:string,message:string,data:object={}) {
 await db.query('INSERT INTO task_events(id,task_id,actor_id,kind,message,data) VALUES ($1,$2,$3,$4,$5,$6)',[randomUUID(),taskId,actor,kind,message,JSON.stringify(data)]);
}
export async function notify(db:Db,taskId:string|null,recipient:string,body:string,key:string) {
 await db.query('INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING',[randomUUID(),taskId,recipient,body,key]);
}
export async function config(db:Db=pool):Promise<{version:number;config:Rules}> { return (await db.query('SELECT * FROM rule_versions ORDER BY version DESC LIMIT 1')).rows[0]; }
export async function visibleTasks(user:User,db:Db=pool):Promise<Task[]> { return (await db.query('SELECT * FROM tasks ORDER BY deadline ASC NULLS LAST,id')).rows.filter(t=>canSee(user,t)); }
async function taskFor(db:Db,id:string,user:User,lock=false):Promise<Task> {
 const task=(await db.query(`SELECT * FROM tasks WHERE id=$1${lock?' FOR UPDATE':''}`,[id])).rows[0];
 assert(task && canSee(user,task),404,'Задача не найдена или недоступна.'); return task;
}
export async function bootstrap(user:User) {
 return transaction(async db=>{
 await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const tasks=await visibleTasks(user,db), ids=tasks.map(t=>t.id), cfg=await config(db);
 const approvals=(await db.query('SELECT * FROM approvals WHERE task_id=ANY($1) ORDER BY created_at DESC',[ids])).rows;
 const controls=(await db.query('SELECT * FROM control_requests WHERE task_id=ANY($1) ORDER BY created_at DESC',[ids])).rows;
 const users=(await db.query('SELECT * FROM users ORDER BY name')).rows.filter((u:User)=>globalAccess(user)||u.branch_id===user.branch_id||u.id===user.id||tasks.some(t=>t.creator_id===u.id)||approvals.some((a:Approval)=>a.route.some(s=>s.userId===u.id)));
 const available=(await db.query('SELECT * FROM tasks')).rows.filter(t=>canAccess(user,t));
 const selection={total:available.length,included:tasks.length,checklist:available.filter(t=>exclusionReason(t)==='checklist').length,unfinishedAnalysis:available.filter(t=>exclusionReason(t)==='unfinished_analysis').length};
 return {selection,user,users,tasks,approvals,controls,submissions:(await db.query('SELECT * FROM task_submissions WHERE task_id=ANY($1) ORDER BY submitted_at DESC',[ids])).rows,rules:cfg.config,rulesVersion:cfg.version,serverTime:new Date().toISOString(),metrics:metrics(tasks,approvals,controls),source:(await db.query('SELECT file_name,sheet_name,row_count,imported_at,assumptions FROM import_batches ORDER BY imported_at DESC LIMIT 1')).rows[0]||null,
 findings:(await db.query("SELECT * FROM findings WHERE task_id=ANY($1) AND status='open'",[ids])).rows,
 events:(await db.query('SELECT * FROM task_events WHERE task_id=ANY($1) OR (task_id IS NULL AND $2) ORDER BY created_at DESC LIMIT 250',[ids,globalAccess(user)])).rows,
 notifications:(await db.query('SELECT * FROM outbox WHERE (recipient_id=$1 OR ($2 AND (task_id=ANY($3) OR (task_id IS NULL AND $4)))) AND (task_id IS NULL OR task_id=ANY($3)) ORDER BY created_at DESC LIMIT 150',[user.id,canManage(user),ids,globalAccess(user)])).rows,
 reports:(await db.query('SELECT id,day,scope,metrics,rules_version,created_at,kind,activity,slot,formula_version FROM reports WHERE scope=$1 ORDER BY created_at DESC LIMIT 100',[scopeFor(user)])).rows};
 });
}
export async function detail(user:User,id:string) {
 const task=await taskFor(pool,id,user);
 return {task,submissions:(await pool.query('SELECT * FROM task_submissions WHERE task_id=$1 ORDER BY round DESC',[id])).rows,comments:(await pool.query('SELECT * FROM comments WHERE task_id=$1 ORDER BY created_at',[id])).rows,events:(await pool.query('SELECT * FROM task_events WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows,approvals:(await pool.query('SELECT * FROM approvals WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows,decisions:(await pool.query('SELECT d.* FROM decisions d JOIN approvals a ON a.id=d.approval_id WHERE a.task_id=$1 ORDER BY d.created_at',[id])).rows,controls:(await pool.query('SELECT * FROM control_requests WHERE task_id=$1 ORDER BY created_at DESC',[id])).rows};
}
export async function addComment(user:User,id:string,body:string) {
 return transaction(async db=>{ await taskFor(db,id,user); await db.query('INSERT INTO comments(id,task_id,author_id,body) VALUES($1,$2,$3,$4)',[randomUUID(),id,user.id,body]); await event(db,id,user.id,'comment','Добавлен комментарий',{body}); });
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
export async function answerControl(user:User,id:string,input:{reason:string;progress:string;plan:string}) {
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
  const u=users.find(u=>selector==='branchManager'?u.role==='branch_manager'&&u.branch_id===task.branch_id:selector==='creator'?u.id===task.creator_id:u.role===(selector==='salesHead'?'sales_head':'director'));
  assert(u,422,`Не назначен согласующий: ${labels[selector]}`); return {userId:u.id,label:labels[selector]};
 });
}
export async function requestApproval(user:User,id:string,input:{type:'deadline'|'completion';reason:string;plan:string;proposedDeadline?:string;expectedVersion:number}) {
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
export async function decide(user:User,id:string,input:{decision:'approve'|'reject'|'later'|'clarify';comment:string;expectedStep?:number;remindMinutes?:number}) {
 return transaction(async db=>{
  const first=(await db.query('SELECT task_id FROM approvals WHERE id=$1',[id])).rows[0]; assert(first,404,'Согласование не найдено.');
  const task=await taskFor(db,first.task_id,user,true);
  const a=(await db.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE',[id])).rows[0] as Approval;
  assert(input.expectedStep===undefined||input.expectedStep===a.current_step,409,'Этот этап уже завершён. Откройте актуальное решение.');
  assert(a.state==='pending',409,'Решение уже принято или запрос устарел.');
  assert(a.route[a.current_step].userId===user.id,403,'Сейчас решение принимает другой согласующий.');
  assert(!a.clarification_requested_at||a.clarification_answered_at,409,'Сначала дождитесь ответа на уточнение.');
  if(a.task_version!==task.version) {
   await db.query("UPDATE approvals SET state='stale' WHERE id=$1",[id]); await event(db,task.id,user.id,'approval_stale','Согласование остановлено: задача изменилась',{approvalId:id});
   return {state:'stale'};
  }
  await db.query('INSERT INTO decisions(id,approval_id,actor_id,step_index,decision,comment) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,user.id,a.current_step,input.decision,input.comment]);
  if(input.decision==='clarify') {
   assert(input.comment.trim().length>=5,400,'Напишите вопрос для автора запроса (не менее 5 символов).');
   await db.query('UPDATE approvals SET clarification_question=$2,clarification_answer=NULL,clarification_requested_at=now(),clarification_answered_at=NULL,deferred_until=NULL WHERE id=$1',[id,input.comment]);
   await db.query("INSERT INTO comments(id,task_id,author_id,body,kind) VALUES($1,$2,$3,$4,'clarification')",[randomUUID(),task.id,user.id,`Уточнение по согласованию: ${input.comment}`]);
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
   if(a.type==='completion')await db.query("UPDATE task_submissions SET state='accepted',reviewer_id=$2,remark=$3,decided_at=now() WHERE task_id=$1 AND state='review'",[task.id,user.id,input.comment||'Результат принят по маршруту согласования.']);
   await db.query("UPDATE approvals SET state='approved',deferred_until=NULL WHERE id=$1",[id]);
   await event(db,task.id,user.id,a.type==='deadline'?'deadline_changed':'task_completed',a.type==='deadline'?'Перенос согласован, крайний срок изменён':'Закрытие согласовано, задача завершена',{approvalId:id,before:task,after:next,comment:input.comment});
   // Re-evaluate the affected task in the same transaction; no stale violations in the UI.
   const cfg=await config(db), remaining=evaluate(next,cfg.config,new Date(),await visibleTasks(user,db));
   await db.query("UPDATE findings SET status='resolved' WHERE task_id=$1 AND NOT(rule=ANY($2))",[task.id,remaining.map(f=>f.rule)]);
   if(!remaining.length) await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[task.id]);
   await notify(db,task.id,a.requester_id,`Изменение по задаче #${task.id} согласовано и применено в локальной системе.`,`approved:${id}`);
  }
  await adapters.telegram.dispatch(db); return {state:input.decision==='reject'?'rejected':a.current_step===a.route.length-1?'approved':'pending'};
 });
}
export async function answerClarification(user:User,id:string,answer:string){
 return transaction(async db=>{
  const found=(await db.query('SELECT task_id FROM approvals WHERE id=$1',[id])).rows[0];assert(found,404,'Согласование не найдено.');
  await taskFor(db,found.task_id,user);
  const a=(await db.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE',[id])).rows[0] as Approval;
  assert(a.requester_id===user.id,403,'Ответить может автор запроса.');
  assert(a.state==='pending'&&a.clarification_requested_at&&!a.clarification_answered_at,409,'Здесь не ожидается уточнение.');
  await db.query('UPDATE approvals SET clarification_answer=$2,clarification_answered_at=now() WHERE id=$1',[id,answer]);
  await db.query("INSERT INTO comments(id,task_id,author_id,body,kind) VALUES($1,$2,$3,$4,'clarification')",[randomUUID(),a.task_id,user.id,`Ответ на уточнение: ${answer}`]);
  await event(db,a.task_id,user.id,'approval_clarification_answered','Автор запроса ответил на уточнение',{approvalId:id,answer});
  await notify(db,a.task_id,a.route[a.current_step].userId,`Получен ответ по задаче #${a.task_id}: ${answer}`,`clarification-answer:${id}:${Date.now()}`);
  await adapters.telegram.dispatch(db);return {state:'pending',clarification:'answered'};
 });
}
export async function remind(user:User,now=new Date()) {
 assert(canManage(user),403,'Недостаточно прав.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431002)'); const cfg=await config(db), ids=(await visibleTasks(user,db)).map(t=>t.id); let count=0;
  const controls=(await db.query("SELECT * FROM control_requests WHERE task_id=ANY($1) AND state='waiting' AND due_at<=$2 FOR UPDATE",[ids,now])).rows as ControlRequest[];
  for(const c of controls) {
   const task=await taskFor(db,c.task_id,user); const escalated=c.reminders>=cfg.config.maxReminders;
   const recipient=escalated?(await routeFor(db,task,['branchManager']))[0].userId:c.assignee_id;
   await notify(db,c.task_id,recipient,`${escalated?'Эскалация руководителю':'Напоминание'}: нет объяснения по задаче #${c.task_id}`,`remind:${c.id}:${c.reminders}`);
   await db.query("UPDATE control_requests SET state=$2,reminders=reminders+1,due_at=$3 WHERE id=$1",[c.id,escalated?'escalated':'waiting',new Date(now.getTime()+cfg.config.reminderMinutes*60000)]);
   await event(db,c.task_id,user.id,escalated?'escalated':'reminder',escalated?'Отсутствие ответа передано руководителю':'Отправлено тестовое напоминание');count++;
  }
  const postponed=(await db.query("SELECT * FROM approvals WHERE task_id=ANY($1) AND state='pending' AND deferred_until<=$2 FOR UPDATE",[ids,now])).rows as Approval[];
  for(const a of postponed){await notify(db,a.task_id,a.route[a.current_step].userId,`Вы отложили решение по задаче #${a.task_id}. Вернитесь к согласованию.`,`defer:${a.id}:${a.deferred_until}`);await db.query('UPDATE approvals SET deferred_until=NULL WHERE id=$1',[a.id]);count++;}
  await adapters.telegram.dispatch(db);return {count};
 });
}
function scopeFor(user:User) { return globalAccess(user)?'company':user.role==='branch_manager'?`branch:${user.branch_id}`:`user:${user.id}`; }
export async function makeReport(user:User,kind='snapshot',slot='manual',capturedAt=new Date()) {
 assert(['snapshot','today','overdue','review','daily','nextday'].includes(kind),400,'Неизвестный тип отчёта.');
 assert(canManage(user),403,'Отчёты формируют руководители.');
 return transaction(async db=>{
  // A consistent, immutable snapshot. Repeated same-day generation returns the original.
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  const now=capturedAt,day=moscowDay(now),scope=scopeFor(user),old=(await db.query('SELECT * FROM reports WHERE day=$1 AND scope=$2 AND kind=$3 AND slot=$4',[day,scope,kind,slot])).rows[0]; if(old) return old;
  let next=new Date(day+'T12:00:00+03:00');do{next=new Date(next.getTime()+86400000);}while([0,6].includes(next.getUTCDay()));
  const allTasks=await visibleTasks(user,db),tasks=kind==='nextday'?allTasks.filter(t=>t.status==='active'&&(plannedMinutesOn(t,moscowDay(next))||0)>0):['today','overdue','review'].includes(kind)?allTasks.filter(t=>taskQueue(t,now)===kind):allTasks, ids=tasks.map(t=>t.id),cfg=await config(db);
  const a=(await db.query('SELECT * FROM approvals WHERE task_id=ANY($1)',[ids])).rows;
  const c=(await db.query('SELECT * FROM control_requests WHERE task_id=ANY($1)',[ids])).rows;
  const m=metrics(tasks,a,c,now);
  const activityRows=(await db.query("SELECT kind,count(*)::int n FROM task_events WHERE task_id=ANY($1) AND (created_at AT TIME ZONE 'Europe/Moscow')::date=$2::date GROUP BY kind",[ids,day])).rows;
  const counts=Object.fromEntries(activityRows.map(r=>[r.kind,r.n]));const activity={completed:counts.task_completed||0,transfers:counts.deadline_changed||0,rejected:counts.approval_rejected||0,answers:counts.explanation||0,returned:counts.review_returned||0};
  const previous=(await db.query('SELECT id,created_at,rows,analysis FROM reports WHERE scope=$1 AND kind=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[scope,kind])).rows[0]||null;
  const users=(await db.query('SELECT * FROM users')).rows,source=(await db.query('SELECT * FROM import_batches ORDER BY imported_at DESC LIMIT 1')).rows[0]||null;
  const analysis=reportAnalysis(tasks,users,now,previous,source);
  if(kind==='nextday'){
   analysis.targetDay=moscowDay(next);analysis.excludedWithoutPlan=allTasks.filter(t=>{if(t.status!=='active')return false;const p=plannedInterval(t);return !p.start||!p.end||new Date(p.end)<=new Date(p.start)}).length;
   analysis.notes.unshift(`План на ${analysis.targetDay}. Из всех задач в работе ${analysis.excludedWithoutPlan} не имеют полного корректного плана и не могут попасть в этот отчёт.`);
  }
  const report=(await db.query('INSERT INTO reports(id,day,scope,metrics,rows,rules_version,kind,activity,slot,formula_version,analysis) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[randomUUID(),day,scope,JSON.stringify(m),JSON.stringify(tasks),cfg.version,kind,JSON.stringify(activity),slot,'v4-task-selection',JSON.stringify(analysis)])).rows[0];
  await notify(db,null,user.id,'Готов отчёт за '+day+': '+tasks.length+' задач; просрочено '+m.overdue+', срок сегодня '+m.today+', на приёмке '+m.review+'.','report:'+report.id);return report;
 });
}
export async function listReports(user:User,input:{kind?:string;from?:string;to?:string;page:number}){
 return transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const args=[scopeFor(user),input.kind||null,input.from||null,input.to||null];
  const condition='scope=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::date IS NULL OR day>=$3) AND ($4::date IS NULL OR day<=$4)';
  const total=Number((await db.query('SELECT count(*) n FROM reports WHERE '+condition,args)).rows[0].n);
  const items=(await db.query('SELECT id,day,scope,metrics,rules_version,created_at,kind,activity,slot,formula_version FROM reports WHERE '+condition+' ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $5',[...args,input.page*20])).rows;
  return {items,total,page:input.page,pageSize:20};
 });
}
export async function getReport(user:User,id:string){const report=(await pool.query('SELECT * FROM reports WHERE id=$1 AND scope=$2',[id,scopeFor(user)])).rows[0];assert(report,404,'Отчёт не найден или недоступен.');return report;}
export async function saveRules(user:User,rules:Rules,expectedVersion:number) {
 assert(user.role==='admin',403,'Настройки меняет администратор.');
 return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(431003)');const current=await config(db);assert(current.version===expectedVersion,409,'Настройки уже изменены. Обновите страницу.');const result=await db.query('INSERT INTO rule_versions(config,author_id) VALUES($1,$2) RETURNING version',[JSON.stringify(rules),user.id]);await event(db,null,user.id,'rules_changed','Обновлены правила контроля',{before:current.config,after:rules,version:result.rows[0].version});return result.rows[0];});
}
export async function simulateExternalChange(user:User,id:string,expectedVersion:number) {
 assert(user.role==='admin',403,'Только администратор может изменять тестовый источник.');
 return transaction(async db=>{const before=await taskFor(db,id,user,true);assert(before.version===expectedVersion,409,'Задача изменилась.');const after=(await db.query("UPDATE tasks SET description=description || E'\nУточнение из тестового источника.',version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];await adapters.tasks.applyApprovedChange(db,after,before.version);await db.query("UPDATE approvals SET state='stale' WHERE task_id=$1 AND state='pending'",[id]);await event(db,id,user.id,'external_change','Изменение из mock-источника; активный запрос требует повторного согласования',{before,after});});
}
