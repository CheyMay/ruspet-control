import {pool,transaction,type Db} from './db.js';
import {assert,canSee} from './domain.js';
import {branchCovers,canApproveBranch,unassignedBranch} from '../shared/branches.js';
import {lockDelegationChain} from './delegation-lock.js';
import {event} from './service.js';
import {taskCode} from '../shared/queues.js';
import type {Task,User} from '../shared/types.js';

type Hierarchy={branch_manager_id:string;sales_head_id:string;sales_head_approves_all:boolean;direct_assignee_ids:string[]|null};
export async function approvalHierarchy(db:Db,forNewRequest=false){
 return (await db.query<Hierarchy>('SELECT * FROM approval_hierarchy WHERE id=1'+(forNewRequest?' FOR SHARE':''))).rows[0]??null;
}
export const inControlScope=(hierarchy:Hierarchy|null,assigneeId:string)=>hierarchy?.direct_assignee_ids?.includes(assigneeId)??true;
export const approvalScope=(hierarchy:Hierarchy|null)=>hierarchy?.direct_assignee_ids?
 {assigneeIds:hierarchy.direct_assignee_ids,approverId:hierarchy.sales_head_id}:null;
const codeRequiresReview=(task:Task)=>taskCode(task.title).code.replace(/[*#]$/u,'').includes('В');
async function hasWatch(db:Db,taskId:string,directorId:string){
 return !!(await db.query('SELECT 1 FROM task_approval_watch WHERE task_id=$1 AND user_id=$2',[taskId,directorId])).rowCount;
}
export async function approvalWatch(actor:User,task:Task,db:Db=pool){
 const hierarchy=await approvalHierarchy(db);
 if(!hierarchy||hierarchy.direct_assignee_ids)return null;
 return {manual:await hasWatch(db,task.id,hierarchy.sales_head_id),byCode:codeRequiresReview(task),canChange:actor.id===hierarchy.sales_head_id};
}
export async function setApprovalWatch(actor:User,id:string,enabled:boolean){
 return transaction(async db=>{
  await lockDelegationChain(db,id);
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert(task&&canSee(actor,task),404,'Задача недоступна.');
  const hierarchy=await approvalHierarchy(db);
  assert(!hierarchy?.direct_assignee_ids,409,'Контроль сейчас определяется списком сотрудников.');
  assert(hierarchy?.sales_head_id===actor.id,403,'Отметку контроля ставит руководитель продаж.');
  assert(task.status!=='completed',409,'Задача уже завершена.');
  const was=await hasWatch(db,id,actor.id);
  if(was===enabled)return {enabled};
  if(enabled)await db.query('INSERT INTO task_approval_watch(task_id,user_id) VALUES($1,$2) ON CONFLICT(task_id) DO UPDATE SET user_id=excluded.user_id,created_at=now()',[id,actor.id]);
  else await db.query('DELETE FROM task_approval_watch WHERE task_id=$1 AND user_id=$2',[id,actor.id]);
  await event(db,id,actor.id,'approval_watch_changed',enabled?'Руководитель продаж взял задачу на контроль':'Руководитель продаж снял отметку контроля',{enabled});
  return {enabled};
 });
}

export async function setApprovalHierarchy(actor:User,branchId:string,salesId:string,approveAll?:boolean,directAssigneeIds?:string[]|null){
 assert(actor.role==='admin',403,'Маршрут настраивает администратор.');
 assert(branchId!==salesId,400,'Для двух этапов нужны разные сотрудники.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const current=(await db.query<Hierarchy>('SELECT * FROM approval_hierarchy WHERE id=1 FOR UPDATE')).rows[0];
  const scope=directAssigneeIds===undefined?current?.direct_assignee_ids??null:directAssigneeIds;
  const direct=scope&&[...new Set(scope)].sort();
  if(direct){
   const eligible=(await db.query("SELECT id FROM users WHERE id=ANY($1) AND role='employee' AND NOT root_access",[direct])).rowCount;
   assert(direct.length>0&&eligible===direct.length,400,'Выберите сотрудников для прямого согласования.');
  }
  const people=(await db.query<User>('SELECT * FROM users WHERE id=ANY($1) ORDER BY id FOR NO KEY UPDATE',[[branchId,salesId]])).rows;
  const branch=people.find(person=>person.id===branchId),sales=people.find(person=>person.id===salesId);
  assert(branch&&(direct||canApproveBranch(branch)),400,'Выберите руководителя подразделения для первого этапа.');
  assert(sales&&!sales.root_access&&(sales.role==='director'||sales.role==='sales_head'),400,'Второй этап — директор или руководитель продаж.');
  const all=approveAll??current?.sales_head_approves_all??false;
  const revoked=await db.query('UPDATE users SET company_branch_access=false,version=version+1 WHERE company_branch_access');
  const sameScope=JSON.stringify(current?.direct_assignee_ids??null)===JSON.stringify(direct);
  if(current?.branch_manager_id===branchId&&current.sales_head_id===salesId&&current.sales_head_approves_all===all&&sameScope&&!revoked.rowCount)return current;
  await db.query(`INSERT INTO approval_hierarchy(id,branch_manager_id,sales_head_id,sales_head_approves_all,direct_assignee_ids) VALUES(1,$1,$2,$3,$4)
   ON CONFLICT(id) DO UPDATE SET branch_manager_id=excluded.branch_manager_id,sales_head_id=excluded.sales_head_id,
   sales_head_approves_all=excluded.sales_head_approves_all,direct_assignee_ids=excluded.direct_assignee_ids`,[branchId,salesId,all,direct]);
  if(direct&&(!sameScope||current?.sales_head_id!==salesId))await applyDirectScope(db,actor.id,salesId,direct);
  if(!direct&&all&&!current?.sales_head_approves_all){
   const updated=await db.query<{id:string;task_id:string}>(`UPDATE approvals a SET route=a.route || $2::jsonb
    FROM tasks t WHERE a.task_id=t.id AND a.task_version=t.version AND t.status<>'completed'
    AND a.state='pending' AND a.canceled_at IS NULL AND a.requester_id<>$1
    AND (a.type<>'completion' OR t.assignee_id<>$1)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a.route) step WHERE step->>'userId'=$1)
    RETURNING a.id,a.task_id`,[salesId,JSON.stringify([{userId:salesId,label:'Руководитель продаж'}])]);
   for(const approval of updated.rows)await event(db,approval.task_id,actor.id,'approval_route_extended',
    'В маршрут добавлено согласование руководителем продаж',{approvalId:approval.id,salesId});
  }
  await event(db,null,actor.id,'approval_hierarchy_changed','Настроен маршрут согласования задач',{branchId,salesId,approveAll:all,directAssigneeIds:direct});
  return {branch_manager_id:branchId,sales_head_id:salesId,sales_head_approves_all:all,direct_assignee_ids:direct};
 });
}
const directRoute=(salesId:string)=>[{userId:salesId,label:'Руководитель продаж'}];
async function applyDirectScope(db:Db,actorId:string,salesId:string,assignees:string[]){
 const route=JSON.stringify(directRoute(salesId));
 const {rows}=await db.query<{id:string;task_id:string;eligible:boolean;previous_route:unknown}>(`WITH candidates AS (
   SELECT a.id,a.route AS previous_route,t.assignee_id=ANY($1) AND a.requester_id<>$2
    AND (a.type<>'completion' OR t.assignee_id<>$2) AS eligible
   FROM approvals a JOIN tasks t ON t.id=a.task_id
   WHERE a.state='pending' AND a.canceled_at IS NULL AND a.task_version=t.version AND t.status<>'completed'
   AND (NOT (t.assignee_id=ANY($1)) OR a.route<>$3::jsonb OR a.requester_id=$2)
   FOR UPDATE OF a
  )
  UPDATE approvals a SET route=CASE WHEN c.eligible THEN $3::jsonb ELSE a.route END,
   current_step=CASE WHEN c.eligible THEN 0 ELSE a.current_step END,
   state=CASE WHEN c.eligible THEN 'pending' ELSE 'stale' END,
   canceled_at=CASE WHEN c.eligible THEN NULL ELSE now() END,
   deferred_until=NULL,action_revision=action_revision+1
  FROM candidates c WHERE a.id=c.id
  RETURNING a.id,a.task_id,c.eligible,c.previous_route`,[assignees,salesId,route]);
 for(const approval of rows){
  await db.query("UPDATE outbox SET withdrawn_at=now() WHERE task_id=$1 AND withdrawn_at IS NULL AND dedupe_key LIKE $2",[
   approval.task_id,'approval:'+approval.id+':%']);
  await event(db,approval.task_id,actorId,approval.eligible?'approval_route_changed':'approval_scope_canceled',
   approval.eligible?'Согласование назначено руководителю продаж':'Запрос выведен из управленческого согласования',
   {approvalId:approval.id,previousRoute:approval.previous_route,route:approval.eligible?directRoute(salesId):null});
 }
 await db.query("UPDATE outbox o SET withdrawn_at=now() FROM control_requests c WHERE o.dedupe_key='control:'||c.id AND NOT(c.assignee_id=ANY($1)) AND o.withdrawn_at IS NULL",[assignees]);
 await db.query("UPDATE control_requests SET state='resolved' WHERE state IN ('waiting','escalated') AND NOT(assignee_id=ANY($1))",[assignees]);
 await db.query("UPDATE findings f SET status='resolved' FROM tasks t WHERE t.id=f.task_id AND f.status='open' AND NOT(t.assignee_id=ANY($1))",[assignees]);
}

export async function hierarchyRoute(db:Db,hierarchy:Hierarchy,task:Task,requesterId:string,type:'deadline'|'completion'){
 const people=(await db.query<User>(`SELECT * FROM users WHERE NOT root_access
  AND (role IN ('branch_manager','admin') OR id=$1 OR id=$2)`,[hierarchy.sales_head_id,task.creator_id])).rows;
 const head=people.find(person=>person.id===hierarchy.sales_head_id);
 assert(head&&(head.role==='director'||head.role==='sales_head'),422,'Назначьте руководителя продаж для согласования.');
 const eligible=(person:User)=>person.id!==requesterId&&(type!=='completion'||person.id!==task.assignee_id);
 if(hierarchy.direct_assignee_ids){
  assert(inControlScope(hierarchy,task.assignee_id),422,'Управленческое согласование для этой задачи не требуется.');
  assert(eligible(head),422,'Согласовать собственный запрос нельзя.');
  return directRoute(head.id);
 }
 const legacy=people.find(person=>person.id===hierarchy.branch_manager_id&&person.role==='branch_manager'&&person.company_branch_access);
 assert(legacy||task.branch_id!==unassignedBranch,422,'Укажите филиал задачи перед согласованием. Обратитесь к администратору.');
 const first=legacy??branchApprover(people,task,hierarchy.branch_manager_id);
 const creator=people.find(person=>person.id===task.creator_id&&person.id!==head.id&&eligible(person)&&canSee(person,task));
 const primary=first&&eligible(first)?{userId:first.id,label:'Руководитель филиала'}:
  creator?{userId:creator.id,label:'Постановщик'}:null;
 const headStep=eligible(head)&&(hierarchy.sales_head_approves_all||!primary||codeRequiresReview(task)||await hasWatch(db,task.id,head.id));
 const route=[...(primary?[primary]:[]),...(headStep?[{userId:head.id,label:'Руководитель продаж'}]:[])];
 assert(route.length,422,'Для этого запроса нужен другой согласующий. Обратитесь к администратору.');
 return route;
}

export function branchApprover(people:User[],task:Task,preferredId?:string){
 const scoped=people.filter(person=>canApproveBranch(person)&&branchCovers(person.branch_id,task.branch_id));
 const longest=Math.max(0,...scoped.map(person=>person.branch_id.length));
 const closest=scoped.filter(person=>person.branch_id.length===longest);
 const preferred=closest.find(person=>person.id===preferredId);
 assert(preferred||closest.length<=1,422,'У филиала несколько согласующих. Уточните оргструктуру у администратора.');
 return preferred??closest[0];
}
