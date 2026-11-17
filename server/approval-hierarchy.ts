import {pool,transaction,type Db} from './db.js';
import {assert,canSee} from './domain.js';
import {branchCovers,canApproveBranch,unassignedBranch} from '../shared/branches.js';
import {lockDelegationChain} from './delegation-lock.js';
import {event} from './service.js';
import {taskCode} from '../shared/queues.js';
import type {Task,User} from '../shared/types.js';

type Hierarchy={branch_manager_id:string;sales_head_id:string};
export async function approvalHierarchy(db:Db){
 return (await db.query<Hierarchy>('SELECT branch_manager_id,sales_head_id FROM approval_hierarchy WHERE id=1')).rows[0]??null;
}
const codeRequiresReview=(task:Task)=>taskCode(task.title).code.replace(/[*#]$/u,'').includes('В');
async function hasWatch(db:Db,taskId:string,directorId:string){
 return !!(await db.query('SELECT 1 FROM task_approval_watch WHERE task_id=$1 AND user_id=$2',[taskId,directorId])).rowCount;
}
export async function approvalWatch(actor:User,task:Task,db:Db=pool){
 const hierarchy=await approvalHierarchy(db);
 if(!hierarchy)return null;
 return {manual:await hasWatch(db,task.id,hierarchy.sales_head_id),byCode:codeRequiresReview(task),canChange:actor.id===hierarchy.sales_head_id};
}
export async function setApprovalWatch(actor:User,id:string,enabled:boolean){
 return transaction(async db=>{
  await lockDelegationChain(db,id);
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert(task&&canSee(actor,task),404,'Задача недоступна.');
  const hierarchy=await approvalHierarchy(db);
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

export async function setApprovalHierarchy(actor:User,branchId:string,salesId:string){
 assert(actor.role==='admin',403,'Маршрут настраивает администратор.');
 assert(branchId!==salesId,400,'Для двух этапов нужны разные сотрудники.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const people=(await db.query<User>('SELECT * FROM users WHERE id=ANY($1) ORDER BY id FOR UPDATE',[[branchId,salesId]])).rows;
  const branch=people.find(person=>person.id===branchId),sales=people.find(person=>person.id===salesId);
  assert(branch&&canApproveBranch(branch),400,'Выберите руководителя подразделения для первого этапа.');
  assert(sales&&!sales.root_access&&(sales.role==='director'||sales.role==='sales_head'),400,'Второй этап — директор или руководитель продаж.');
  const current=await approvalHierarchy(db);
  const revoked=await db.query('UPDATE users SET company_branch_access=false,version=version+1 WHERE company_branch_access');
  if(current?.branch_manager_id===branchId&&current.sales_head_id===salesId&&!revoked.rowCount)return current;
  await db.query(`INSERT INTO approval_hierarchy(id,branch_manager_id,sales_head_id) VALUES(1,$1,$2)
   ON CONFLICT(id) DO UPDATE SET branch_manager_id=excluded.branch_manager_id,sales_head_id=excluded.sales_head_id`,[branchId,salesId]);
  await event(db,null,actor.id,'approval_hierarchy_changed','Настроен маршрут согласования задач',{branchId,salesId});
  return {branch_manager_id:branchId,sales_head_id:salesId};
 });
}

export async function hierarchyRoute(db:Db,hierarchy:Hierarchy,task:Task,requesterId:string,type:'deadline'|'completion'){
 const people=(await db.query<User>(`SELECT * FROM users WHERE NOT root_access
  AND (role IN ('branch_manager','admin') OR id=$1 OR id=$2)`,[hierarchy.sales_head_id,task.creator_id])).rows;
 const head=people.find(person=>person.id===hierarchy.sales_head_id);
 assert(head&&(head.role==='director'||head.role==='sales_head'),422,'Назначьте руководителя продаж для согласования.');
 const eligible=(person:User)=>person.id!==requesterId&&(type!=='completion'||person.id!==task.assignee_id);
 const legacy=people.find(person=>person.id===hierarchy.branch_manager_id&&person.role==='branch_manager'&&person.company_branch_access);
 assert(legacy||task.branch_id!==unassignedBranch,422,'Укажите филиал задачи перед согласованием. Обратитесь к администратору.');
 const first=legacy??branchApprover(people,task,hierarchy.branch_manager_id);
 const creator=people.find(person=>person.id===task.creator_id&&person.id!==head.id&&eligible(person)&&canSee(person,task));
 const primary=first&&eligible(first)?{userId:first.id,label:'Руководитель филиала'}:
  creator?{userId:creator.id,label:'Постановщик'}:null;
 const headStep=eligible(head)&&(!primary||codeRequiresReview(task)||await hasWatch(db,task.id,head.id));
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
