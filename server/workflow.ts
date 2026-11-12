import {lockDelegationChain} from './delegation-lock.js';
import {taskEditAccess,useTaskEditPermission} from './task-edit-permissions.js';
import {findDelegationClients,resolveCompanyResponsibility} from './company-responsibility.js';
import {actingManager,delegatesFor} from './org.js';
import {recordTaskAction,recordTaskBarrier} from './undo-record.js';
import {createHash,randomUUID} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {assert,canRequest,canSee,canManage,globalAccess} from './domain.js';
import {event,notify,notifyTaskAssignment,refreshTaskFindings} from './service.js';
import {getCompany} from './okb.js';
import {MockTaskProvider} from './providers.js';
import type {Task,User} from '../shared/types.js';
import type {TaskInput} from './task-input.js';
export type {TaskInput} from './task-input.js';
const provider=new MockTaskProvider();
export async function validateTaskAssignment(db:Db,u:User,input:TaskInput,id?:string,currentOwner?:string,creator?:string){
 const owner=(await db.query('SELECT * FROM users WHERE id=$1',[input.assigneeId])).rows[0] as User|undefined;
 assert(owner,400,'Исполнитель не найден.');assert(owner.id===currentOwner||creator===u.id||globalAccess(u)||owner.id===u.id||(u.role==='branch_manager'&&owner.branch_id===u.branch_id),403,'Этот исполнитель вне вашей области доступа.');
 if(input.plannedStart&&input.plannedEnd)assert(new Date(input.plannedEnd)>=new Date(input.plannedStart),400,'Плановое окончание раньше начала.');
 if(input.parentId){assert(input.parentId!==id,400,'Задача не может быть своим родителем.');const parent=(await db.query('SELECT * FROM tasks WHERE id=$1',[input.parentId])).rows[0];assert(parent&&canSee(u,parent),400,'Родительская задача не найдена или недоступна.');
 const chain=(await db.query('WITH RECURSIVE tree AS (SELECT id,parent_id,ARRAY[id] path FROM tasks WHERE id=$1 UNION ALL SELECT t.id,t.parent_id,tree.path||t.id FROM tasks t JOIN tree ON t.id=tree.parent_id WHERE NOT(t.id=ANY(tree.path))) SELECT id FROM tree',[input.parentId])).rows;assert(!chain.some(t=>t.id===id),400,'Возникнет цикл родительских задач.');}
 return owner!;
}
export async function createTask(u:User,input:TaskInput){return transaction(db=>insertTask(db,u,input));}
export async function createTaskCopy(actor:User,id:string,requestId:string,input:TaskInput){
 return transaction(async db=>{
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['task-copy:'+actor.id+':'+requestId]);
  const source=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
  assert(source&&canSee(actor,source),404,'Задача недоступна.');
  const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const receipt=(await db.query('SELECT source_id,task_id,fingerprint FROM task_copy_receipts WHERE actor_id=$1 AND request_id=$2',[actor.id,requestId])).rows[0];
  if(receipt){
   assert(receipt.source_id===id&&receipt.fingerprint===fingerprint,409,'Копия уже сохранена как #'+receipt.task_id+'. Откройте её для дальнейших изменений.');
   return {id:receipt.task_id};
  }
  const created=await insertTask(db,actor,{...input,companyId:input.companyId===undefined?source.company_id:input.companyId},{kind:'copy',task:source});
  await db.query('INSERT INTO task_copy_receipts(actor_id,request_id,source_id,task_id,fingerprint) VALUES($1,$2,$3,$4,$5)',[actor.id,requestId,id,created.id,fingerprint]);
  return created;
 });
}
async function insertTask(db:Db,u:User,input:TaskInput,origin?:{kind:'delegation'|'copy';task:Task},performer=u){
 const delegated=origin?.kind==='delegation'?origin.task:null,copy=origin?.kind==='copy'?origin.task:null;
 if(input.companyId&&!delegated&&input.companyId!==copy?.company_id)await getCompany(u,input.companyId);
 const owner=delegated?(await db.query<User>('SELECT * FROM users WHERE id=$1',[input.assigneeId])).rows[0]:await validateTaskAssignment(db,u,input),id='L-'+randomUUID().slice(0,8);
 assert(input.price!==undefined&&Number.isFinite(input.price)&&input.price>=0,400,'Цена новой задачи обязательна.');
 const task=(await db.query("INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,price,deadline,original_deadline,planned_start,planned_end,status,priority,code,important,customer_risk,parent_id,custom_fields,company_id,delegated_from_id) VALUES($1,$2,$3,$4,$5,$6,$14,$7,$7,$8,$9,'active',$18,$10,$11,$12,$13,$15,$16,$17) RETURNING *",[id,input.title,input.description,owner.branch_id,owner.id,u.id,input.deadline,input.plannedStart,input.plannedEnd,input.title.split(/\s/)[0],input.important,input.customerRisk,input.parentId,input.price,JSON.stringify(input.customFields??[]),input.companyId??null,delegated?.id??null,copy?.priority??'normal'])).rows[0];
 const message=delegated?'Создано поручение из задачи #'+delegated.id:copy?'Создана копия задачи #'+copy.id:'Создана локальная задача';
 await db.query('INSERT INTO mock_provider_tasks(id,snapshot,revision) VALUES($1,$2,1)',[id,JSON.stringify(task)]);await refreshTaskFindings(db,task,u);
 await event(db,id,performer.id,'created',message,{after:task,delegatedFrom:delegated?.id,copiedFrom:copy?.id});
 await notifyTaskAssignment(db,task,performer.id,delegated?'Вам делегировали задачу':'Вам поставили задачу');
 await recordTaskBarrier(db,performer,id,delegated?'Делегирование задачи':'Создание задачи');return {id};
}

export async function canDelegateTask(actor:User,task:Task){
 return !!await actingManager(actor,task);
}
export async function delegationLinks(actor:User,id:string){
 const task=(await pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 assert(task&&canSee(actor,task),404,'Задача недоступна.');
 const links=(await pool.query<Task>(`SELECT * FROM tasks WHERE id=$1 OR delegated_from_id=$2
  ORDER BY (status='completed'),updated_at DESC,id LIMIT 50`,[task.delegated_from_id??null,id])).rows
  .filter(item=>canSee(actor,item)).map(item=>({id:item.id,title:item.title,status:item.status,assignee_id:item.assignee_id}));
 return {canDelegate:await canDelegateTask(actor,task),source:links.find(item=>item.id===task.delegated_from_id)??null,copies:links.filter(item=>item.id!==task.delegated_from_id)};
}
function availableDelegate(actor:User,manager:User,person:User){
 return person.id!==actor.id&&(actor.id===manager.id||globalAccess(actor)||actor.branch_id===person.branch_id);
}
async function delegationContext(actor:User,id:string,db:Db){
 const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 assert(task&&canSee(actor,task),404,'Задача недоступна.');
 const manager=await actingManager(actor,task,db);
 assert(manager,403,'Делегировать можно свою задачу в работе или задачу руководителя, которого вы замещаете.');
 const people=(await delegatesFor(manager,db)).filter(person=>availableDelegate(actor,manager,person));
 return {task,people};
}
export async function delegationTargets(actor:User,id:string,companyId?:string,db:Db=pool){
 const {task,people}=await delegationContext(actor,id,db);
 const responsibility=await resolveCompanyResponsibility(task,people,db,companyId);
 if(companyId&&!globalAccess(actor))assert(responsibility.managerId,403,'Выберите клиента, с которым работает ваш подчинённый.');
 return {version:task.version,people,responsibility};
}
export async function delegationClients(actor:User,id:string,query:string,db:Db=pool){
 const {task,people}=await delegationContext(actor,id,db);
 if(task.company_id)return [];
 return findDelegationClients(task,people,query,globalAccess(actor),db);
}
export async function delegateTask(actor:User,id:string,input:{assigneeId?:string;companyId?:string;responsibilityToken?:string;expectedVersion:number;instruction?:string;deadline?:string|null}){
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock_shared(431036)');
  await lockDelegationChain(db,id);
  const source=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert(source&&canSee(actor,source),404,'Задача недоступна.');
  const manager=await actingManager(actor,source,db);
  assert(manager,403,'Делегировать можно свою задачу в работе или задачу руководителя, которого вы замещаете.');
  assert(source.version===input.expectedVersion,409,'Задача изменилась. Откройте её заново.');
  const available=(await delegatesFor(manager,db)).filter(p=>availableDelegate(actor,manager,p));
  const responsibility=input.assigneeId&&!input.companyId?null:await resolveCompanyResponsibility(source,available,db,input.companyId);
  assert(!input.assigneeId||!input.responsibilityToken,400,'Выберите автоматическое назначение или укажите исполнителя.');
  assert(!input.responsibilityToken||input.responsibilityToken===responsibility?.token,409,'Ответственный компании изменился. Откройте делегирование заново.');
  if(input.companyId&&!globalAccess(actor))assert(responsibility?.managerId,403,'Выберите клиента, с которым работает ваш подчинённый.');
  if(!input.assigneeId){
   assert(responsibility?.managerId,422,responsibility?.reason||'Выберите исполнителя вручную.');
  }
  const target=available.find(p=>p.id===(input.assigneeId||responsibility?.managerId));
  assert(target,403,'Выберите подчинённого из доступного списка.');
  const existing=(await db.query("SELECT id FROM tasks WHERE delegated_from_id=$1 AND assignee_id=$2 AND status<>'completed' LIMIT 1",[id,target.id])).rows[0];
  if(existing)assert(false,409,'У сотрудника уже есть открытое поручение #'+existing.id+'.');
  const instruction=input.instruction?.trim()??'';
  const deadline=input.deadline===undefined?source.deadline:input.deadline;
  const copy=await insertTask(db,manager,{title:source.title,description:instruction?[source.description,'Уточнение руководителя: '+instruction].filter(Boolean).join('\n\n'):source.description,
   assigneeId:target.id,price:0,deadline,plannedStart:null,plannedEnd:null,important:source.important,
   customerRisk:null,parentId:source.id,companyId:source.company_id||responsibility?.companyId||null,customFields:source.custom_fields},
   {kind:'delegation',task:source},actor);
  await event(db,source.id,actor.id,'task_delegated','Создано поручение #'+copy.id+' для '+target.name,
   {delegatedTaskId:copy.id,assigneeId:target.id,instruction,onBehalfOf:manager.id,responsibility});
  return copy;
 });
}
async function editTaskCore(u:User,id:string,input:TaskInput,version:number,reason:string){return transaction(async db=>{
 await db.query('SELECT pg_advisory_xact_lock(431011)');
 const before=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0] as Task;
 assert(before&&canSee(u,before),404,'Задача недоступна.');assert(reason?.trim().length>=5&&reason.length<=4000,400,'Укажите причину изменения, минимум 5 символов.');assert(before.status==='active',409,'Редактировать можно только задачу в работе.');assert(before.version===version,409,'Задача изменилась. Обновите карточку.');
 const editPermissionId=await useTaskEditPermission(db,u,before);
 assert(input.deadline===before.deadline,400,'Крайний срок меняется через запрос согласования.');
 const owner=await validateTaskAssignment(db,u,input,id,before.assignee_id,before.creator_id);
 const companyId=input.companyId===undefined?before.company_id??null:input.companyId;
 if(companyId!==(before.company_id??null)){
  assert(globalAccess(u),403,'Связь с ОКБ меняет руководство.');
  if(companyId)await getCompany(u,companyId);
 }
 const after=(await db.query('UPDATE tasks SET title=$2,description=$3,assignee_id=$4,branch_id=$5,planned_start=$6,planned_end=$7,important=$8,customer_risk=$9,parent_id=$10,code=$11,price=COALESCE($12,price),custom_fields=COALESCE($13,custom_fields),company_id=$14,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,input.title,input.description,owner.id,owner.branch_id,input.plannedStart,input.plannedEnd,input.important,input.customerRisk,input.parentId,input.title.split(/\s/)[0],input.price??null,input.customFields===undefined?null:JSON.stringify(input.customFields),companyId])).rows[0];
 await provider.applyApprovedChange(db,after,before.version);await db.query("UPDATE approvals SET state='stale' WHERE task_id=$1 AND state='pending'",[id]);
 if(before.assignee_id!==after.assignee_id){
  await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[id]);
  await notifyTaskAssignment(db,after,u.id,'Вам назначили задачу');
 }
 await refreshTaskFindings(db,after,u);
 await event(db,id,u.id,'task_edited','Изменены параметры задачи, проверки обновлены.',{before,after,reason,editPermissionId});return {id};
});}
async function reviewTaskCore(u:User,id:string,action:'submit'|'accept'|'return',comment:string,version:number){return transaction(async db=>{
 const before=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0] as Task;assert(before&&canSee(u,before),404,'Задача недоступна.');assert(before.version===version,409,'Задача изменилась. Обновите карточку.');
 const reviewer=u.id===before.creator_id||u.role==='admin'||u.role==='director'||(canManage(u)&&(globalAccess(u)||u.branch_id===before.branch_id));
 if(action==='submit'){assert(canRequest(u,before),403,'Нет права сдавать задачу.');assert(before.status==='active',409,'Задача уже передана или завершена.');}
 else {assert(reviewer,403,'Решение принимает постановщик или руководитель.');assert(before.status==='review',409,'Задача не ожидает приёмки.');assert(u.id!==before.assignee_id,403,'Нельзя принимать собственную работу.');}
 if(action!=='accept')assert(comment.trim().length>=5,400,'Укажите результат или причину возврата, минимум 5 символов.');
 assert(!(await db.query("SELECT 1 FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rowCount,409,'Сначала завершите активное согласование.');
 const status=action==='submit'?'review':action==='accept'?'completed':'active';
 const after=(await db.query("UPDATE tasks SET status=$2,completed_at=CASE WHEN $2='completed' THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id,status])).rows[0];
 await provider.applyApprovedChange(db,after,before.version);
 if(action==='submit')await db.query("INSERT INTO task_submissions(id,task_id,round,result,author_id,state) SELECT $1,$2,coalesce(max(round),0)+1,$3,$4,'review' FROM task_submissions WHERE task_id=$2",[randomUUID(),id,comment,u.id]);
 else await db.query("UPDATE task_submissions SET state=$2,reviewer_id=$3,remark=$4,decided_at=now() WHERE task_id=$1 AND state='review' AND withdrawn_at IS NULL",[id,action==='accept'?'accepted':'returned',u.id,comment||null]);
 const labels={submit:'Работа передана на приёмку',accept:'Результат принят, задача завершена',return:'Задача возвращена в работу'};
 if(comment.trim())await db.query("INSERT INTO comments(id,task_id,author_id,body,kind) VALUES($1,$2,$3,$4,'review')",[randomUUID(),id,u.id,comment]);
 await event(db,id,u.id,action==='accept'?'task_completed':action==='submit'?'review_submitted':'review_returned',labels[action],{before,after,comment});
 await refreshTaskFindings(db,after,u);
 if(action==='accept')await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[id]);
 await notify(db,id,action==='submit'?before.creator_id:before.assignee_id,`${labels[action]} · #${id}${comment.trim()?': '+comment:''}`,`review:${id}:${after.version}`);return {state:status};
});}

export async function taskAssignees(u:User,id:string,db:Db=pool){
 const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 assert(task&&canSee(u,task),404,'Задача недоступна.');
 assert((await taskEditAccess(u,task,db)).canEdit,403,'Нет права редактировать задачу.');
 return (await db.query<User>('SELECT id,name,role,branch_id,position FROM users ORDER BY name')).rows
  .filter(person=>u.id===task.creator_id||globalAccess(u)||person.id===task.assignee_id||person.id===u.id||u.role==='branch_manager'&&person.branch_id===u.branch_id);
}

export async function editTask(...args:Parameters<typeof editTaskCore>){return recordTaskAction(args[0],args[1],'Изменение параметров задачи',()=>editTaskCore(...args));}

export async function reviewTask(...args:Parameters<typeof reviewTaskCore>){return recordTaskAction(args[0],args[1],'Приёмка / сдача результата',()=>reviewTaskCore(...args));}
