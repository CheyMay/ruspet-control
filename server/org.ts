import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,type Db} from './db.js';
import {assert,canManage,canSee,globalAccess} from './domain.js';
import type {Task,User} from '../shared/types.js';

const personId=z.string().trim().min(1).max(100);
function requireOrgAdmin(actor:User){
 assert(actor.role==='admin'||actor.role==='director',403,'Оргструктуру настраивает администратор или директор.');
}
export async function orgDirectory(actor:User){
 requireOrgAdmin(actor);
 const [people,substitutions]=await Promise.all([
  pool.query('SELECT u.id,u.name,u.role,u.branch_id,r.manager_id FROM users u LEFT JOIN org_reporting r ON r.employee_id=u.id WHERE NOT u.root_access ORDER BY u.name,u.id'),
  pool.query('SELECT * FROM org_substitutions WHERE revoked_at IS NULL AND ends_at>now() ORDER BY starts_at,id LIMIT 100')
 ]);
 return {people:people.rows,substitutions:substitutions.rows};
}
export async function setManager(actor:User,employeeId:string,input:unknown){
 requireOrgAdmin(actor);
 const {managerId}=z.object({managerId:personId.nullable()}).parse(input);
 await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const employee=(await db.query<User>('SELECT * FROM users WHERE id=$1',[employeeId])).rows[0];
  assert(employee,404,'Сотрудник не найден.');
  assert(!employee.root_access,403,'Владелец управляется отдельно.');
  if(!managerId){await db.query('DELETE FROM org_reporting WHERE employee_id=$1',[employeeId]);return;}
  const manager=(await db.query<User>('SELECT * FROM users WHERE id=$1',[managerId])).rows[0];
  assert(manager&&!manager.root_access&&canManage(manager),400,'Выберите сотрудника с ролью руководителя.');
  assert(employee.id!==manager.id,400,'Сотрудник не может руководить собой.');
  const chain=(await db.query(`WITH RECURSIVE chain(id) AS (SELECT $1::text UNION SELECT o.manager_id
    FROM org_reporting o JOIN chain c ON c.id=o.employee_id) SELECT 1 FROM chain WHERE id=$2`,[managerId,employeeId])).rowCount;
  assert(!chain,409,'Такая связь создаст цикл в оргструктуре.');
  await db.query('INSERT INTO org_reporting(employee_id,manager_id) VALUES($1,$2) ON CONFLICT(employee_id) DO UPDATE SET manager_id=excluded.manager_id',[employeeId,managerId]);
 });
}
export async function saveSubstitution(actor:User,input:unknown){
 requireOrgAdmin(actor);
 const date=z.iso.datetime({offset:true});
 const value=z.object({managerId:personId,deputyId:personId,startsAt:date,endsAt:date}).parse(input);
 assert(value.managerId!==value.deputyId&&Date.parse(value.endsAt)>Math.max(Date.now(),Date.parse(value.startsAt)),400,'Проверьте участников и период замещения.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const people=(await db.query<User>('SELECT * FROM users WHERE id=ANY($1)',[[value.managerId,value.deputyId]])).rows;
  const manager=people.find(p=>p.id===value.managerId),deputy=people.find(p=>p.id===value.deputyId);
  assert(manager&&deputy&&!manager.root_access&&!deputy.root_access&&canManage(manager)&&canManage(deputy),400,'У обоих участников должна быть роль руководителя.');
  assert(globalAccess(deputy)||!globalAccess(manager)&&deputy.branch_id===manager.branch_id,400,'Заместителю нужна действующая область доступа руководителя.');
  const overlap=(await db.query('SELECT 1 FROM org_substitutions WHERE manager_id=$1 AND revoked_at IS NULL AND starts_at<$3 AND ends_at>$2',[manager.id,value.startsAt,value.endsAt])).rowCount;
  assert(!overlap,409,'У руководителя уже есть замещение на этот период.');
  const id=randomUUID();
  await db.query('INSERT INTO org_substitutions(id,manager_id,deputy_id,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)',[id,manager.id,deputy.id,value.startsAt,value.endsAt]);
  return {id};
 });
}
export async function revokeSubstitution(actor:User,id:string){
 requireOrgAdmin(actor);
 await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const result=await db.query('UPDATE org_substitutions SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',[id]);
  assert(result.rowCount,404,'Действующее замещение не найдено.');
 });
}
export async function actingManager(actor:User,task:Task,db:Db=pool):Promise<User|null>{
 if(!canManage(actor)||!canSee(actor,task)||task.status!=='active')return null;
 if(task.assignee_id===actor.id)return actor;
 return (await db.query<User>(`SELECT u.* FROM org_substitutions s JOIN users u ON u.id=s.manager_id
  WHERE s.manager_id=$1 AND s.deputy_id=$2 AND s.revoked_at IS NULL AND now()>=s.starts_at AND now()<s.ends_at
  AND u.role<>'employee' LIMIT 1`,[task.assignee_id,actor.id])).rows[0]??null;
}
export async function delegatesFor(manager:User,db:Db=pool){
 const people=(await db.query<User&{manager_id:string|null}>(`SELECT u.*,r.manager_id FROM users u
  LEFT JOIN org_reporting r ON r.employee_id=u.id ORDER BY u.name,u.id`)).rows;
 const hasReports=people.some(p=>p.manager_id===manager.id);
 return people.filter(p=>{
  if(p.id===manager.id||p.role==='admin'||p.role==='director')return false;
  if(p.manager_id||hasReports)return p.manager_id===manager.id;
  if(manager.role==='admin'||manager.role==='director')return true;
  if(manager.role==='sales_head')return p.role==='employee'||p.role==='branch_manager';
  return manager.role==='branch_manager'&&p.role==='employee'&&manager.branch_id===p.branch_id&&!!manager.branch_id&&manager.branch_id!=='Не указан';
 });
}
export async function myDelegations(actor:User){
 assert(canManage(actor),403,'Очередь поручений доступна руководителю.');
 const rows=(await pool.query<Task&{source_task:Task;assignee_name:string;manager_name:string}>(`SELECT t.*,row_to_json(source) source_task,
  employee.name assignee_name,manager.name manager_name FROM tasks t
  JOIN tasks source ON source.id=t.delegated_from_id JOIN users employee ON employee.id=t.assignee_id JOIN users manager ON manager.id=t.creator_id
  WHERE t.creator_id=$1 OR EXISTS(SELECT 1 FROM org_substitutions s WHERE s.manager_id=t.creator_id AND s.deputy_id=$1
   AND s.revoked_at IS NULL AND now()>=s.starts_at AND now()<s.ends_at)
  ORDER BY (t.status='completed'), t.deadline ASC NULLS LAST,t.updated_at DESC,t.id LIMIT 500`,[actor.id])).rows;
 return rows.filter(row=>canSee(actor,row)).map(row=>({id:row.id,title:row.title,sourceId:canSee(actor,row.source_task)?row.delegated_from_id:null,sourceTitle:canSee(actor,row.source_task)?row.source_task.title:null,
  status:row.status,deadline:row.deadline,assignee:row.assignee_name,manager:row.manager_name,substitution:row.creator_id!==actor.id}));
}
