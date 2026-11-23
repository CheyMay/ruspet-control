import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {transaction} from './db.js';
import {assert} from './domain.js';
import type {User} from '../shared/types.js';
import {mayManageStaffIdentity,protectedStaffRole} from '../shared/workspace-access.js';
import {namesMatch} from './staff-import.js';
const fields=z.object({name:z.string().trim().min(1).max(200),position:z.string().trim().max(200),branchId:z.string().trim().min(1).max(100),
 role:z.enum(['admin','director','sales_head','branch_manager','employee']),reason:z.string().trim().max(1000).optional()});
const input=fields.extend({expectedVersion:z.number().int().positive()}).strict();
const newProfile=fields.extend({staffId:z.uuid().optional()}).strict();

export async function createEmployeeProfile(actor:User,body:unknown){
 assert(actor.role==='admin',403,'Профили создаёт администратор.');
 const value=newProfile.parse(body);
 assert(actor.root_access||!protectedStaffRole(value.role),403,'Руководящие права такого уровня назначает владелец.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  const staff=value.staffId?(await db.query('SELECT * FROM staff_directory WHERE id=$1 AND enabled FOR UPDATE',[value.staffId])).rows[0]:null;
  assert(!value.staffId||staff&&!staff.user_id&&namesMatch(staff.name,value.name),409,'Проверьте имя и связь со справочником.');
  const people=(await db.query<Pick<User,'id'|'name'>>('SELECT id,name FROM users ORDER BY id')).rows;
  assert(!people.some(person=>namesMatch(person.name,value.name)||person.name.toLocaleLowerCase('ru-RU')===value.name.toLocaleLowerCase('ru-RU')),
   409,'В системе уже есть сотрудник с таким именем. Найдите его в списке и обновите существующий профиль.');
  const id='staff-'+randomUUID();
  const {rows:[user]}=await db.query<User>('INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,$4,$5) RETURNING *',
   [id,value.name,value.role,value.branchId,value.position]);
  if(staff)await db.query('UPDATE staff_directory SET user_id=$2,updated_at=now() WHERE id=$1',[staff.id,id]);
  const data={userId:id,name:user.name,role:user.role,staffId:value.staffId??null,reason:value.reason||'Создание профиля'};
  await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,$2,'employee_profile_created','Создан профиль сотрудника',$3)",
   [randomUUID(),actor.id,JSON.stringify(data)]);
  return {user};
 });
}
export async function linkStaffProfile(actor:User,staffId:string,userId:string){
 assert(actor.role==='admin',403,'Справочник настраивает администратор.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  const staff=(await db.query('SELECT name,user_id FROM staff_directory WHERE id=$1 AND enabled FOR UPDATE',[staffId])).rows[0];
  const user=(await db.query<User>('SELECT * FROM users WHERE id=$1',[userId])).rows[0];
  assert(staff&&!staff.user_id&&user&&namesMatch(staff.name,user.name),409,'Проверьте имя или обновите справочник.');
  assert(mayManageStaffIdentity(actor,user),403,'Этот профиль настраивает владелец.');
  await db.query('UPDATE staff_directory SET user_id=$2,updated_at=now() WHERE id=$1',[staffId,userId]);
  await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,$2,'staff_profile_linked','Запись справочника сопоставлена с профилем',$3)",
   [randomUUID(),actor.id,JSON.stringify({staffId,userId})]);
  return {user};
 });
}

export async function updateEmployeeProfile(actor:User,id:string,body:unknown){
 assert(actor.role==='admin',403,'Данные и права сотрудников меняет администратор.');
 const value=input.parse(body);
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const before=(await db.query<User&{version:number}>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert(before,404,'Сотрудник не найден.');
  assert(mayManageStaffIdentity(actor,before),403,'Этот профиль меняет владелец.');
  assert(actor.root_access||before.role===value.role||!protectedStaffRole(value.role),403,'Руководящие права такого уровня назначает владелец.');
  assert(before.id!==actor.id||before.role===value.role,403,'Вашу роль меняет владелец.');
  assert(before.version===value.expectedVersion,409,'Данные сотрудника изменились. Обновите список.');
  if(before.role!==value.role&&value.role!=='director'&&value.role!=='sales_head'){
   const approver=await db.query('SELECT 1 FROM approval_hierarchy WHERE sales_head_id=$1',[id]);
   assert(!approver.rowCount,409,'Сначала назначьте другого руководителя продаж в настройках маршрута согласований.');
  }
  if(before.role==='admin'&&value.role!=='admin'){
   assert((await db.query("SELECT 1 FROM users WHERE role='admin' AND id<>$1 LIMIT 1",[id])).rowCount,409,'Нельзя изменить роль последнего администратора.');
   const hasLogin=(await db.query('SELECT 1 FROM login_accounts WHERE user_id=$1 AND enabled LIMIT 1',[id])).rowCount;
   if(hasLogin)assert((await db.query("SELECT 1 FROM users u JOIN login_accounts a ON a.user_id=u.id WHERE u.role='admin' AND u.id<>$1 AND a.enabled LIMIT 1",[id])).rowCount,409,'Сначала обеспечьте вход в панель другому администратору.');
  }
  if(before.name===value.name&&before.position===value.position&&before.branch_id===value.branchId&&before.role===value.role)return {user:before,changed:false};
  const approvalBranchLead=value.role==='admin'&&before.branch_id===value.branchId&&
   (before.role==='branch_manager'||before.role==='admin'&&!!before.approval_branch_lead);
  const after=(await db.query<User&{version:number}>(`UPDATE users SET name=$2,position=$3,branch_id=$4,role=$5,
   company_branch_access=company_branch_access AND $5='branch_manager',approval_branch_lead=$6,version=version+1 WHERE id=$1 RETURNING *`,
   [id,value.name,value.position,value.branchId,value.role,approvalBranchLead])).rows[0];
  const related:Record<string,unknown>={};
  if(before.role!==value.role||before.branch_id!==value.branchId){
   related.substitutionsRevoked=(await db.query('UPDATE org_substitutions SET revoked_at=now() WHERE revoked_at IS NULL AND ends_at>now() AND (manager_id=$1 OR deputy_id=$1) RETURNING id',[id])).rows;
   related.approvalsStale=(await db.query(`UPDATE approvals a SET state='stale' FROM tasks t
    WHERE a.task_id=t.id AND a.state='pending' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.route) s WHERE s->>'userId'=$1)
    AND NOT(a.type='completion' AND t.creator_id=$1 AND t.assignee_id<>$1 AND jsonb_array_length(a.route)=1)
    RETURNING a.id`,[id])).rows;
  }
  const reason=value.reason||'Администратор обновил данные сотрудника';
  const auditId=randomUUID();
  await db.query('INSERT INTO employee_profile_changes(id,user_id,actor_id,before_snapshot,after_snapshot,reason,related_changes) VALUES($1,$2,$3,$4,$5,$6,$7)',[auditId,id,actor.id,JSON.stringify(before),JSON.stringify(after),reason,JSON.stringify(related)]);
  await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,$2,'employee_profile_changed','Изменены данные сотрудника',$3)",[randomUUID(),actor.id,JSON.stringify({profileChangeId:auditId,userId:id,before,after,reason})]);
  return {user:after,changed:true};
 });
}
