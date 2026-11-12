import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {transaction} from './db.js';
import {assert} from './domain.js';
import type {User} from '../shared/types.js';
const input=z.object({name:z.string().trim().min(1).max(200),position:z.string().trim().max(200),branchId:z.string().trim().min(1).max(100),
 role:z.enum(['admin','director','sales_head','branch_manager','employee']),expectedVersion:z.number().int().positive(),reason:z.string().trim().max(1000).optional()}).strict();
export async function updateEmployeeProfile(actor:User,id:string,body:unknown){
 assert(actor.role==='admin',403,'Данные и права сотрудников меняет администратор.');
 const value=input.parse(body);
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const before=(await db.query<User&{version:number}>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert(before,404,'Сотрудник не найден.');
  assert(!before.root_access,403,'Права владельца управляются отдельно.');
  assert(before.id!==actor.id||before.role===value.role,403,'Изменить вашу роль может другой администратор.');
  assert(before.version===value.expectedVersion,409,'Данные сотрудника изменились. Обновите список.');
  if(before.role==='admin'&&value.role!=='admin'){
   assert((await db.query("SELECT 1 FROM users WHERE role='admin' AND id<>$1 LIMIT 1",[id])).rowCount,409,'Нельзя изменить роль последнего администратора.');
   const hasLogin=(await db.query('SELECT 1 FROM login_accounts WHERE user_id=$1 AND enabled LIMIT 1',[id])).rowCount;
   if(hasLogin)assert((await db.query("SELECT 1 FROM users u JOIN login_accounts a ON a.user_id=u.id WHERE u.role='admin' AND u.id<>$1 AND a.enabled LIMIT 1",[id])).rowCount,409,'Сначала обеспечьте вход в панель другому администратору.');
  }
  if(before.name===value.name&&before.position===value.position&&before.branch_id===value.branchId&&before.role===value.role)return {user:before,changed:false};
  const after=(await db.query<User&{version:number}>('UPDATE users SET name=$2,position=$3,branch_id=$4,role=$5,version=version+1 WHERE id=$1 RETURNING *',[id,value.name,value.position,value.branchId,value.role])).rows[0];
  const related:Record<string,unknown>={};
  if(value.role==='employee'&&before.role!=='employee')related.reportingRemoved=(await db.query('DELETE FROM org_reporting WHERE manager_id=$1 RETURNING employee_id,manager_id',[id])).rows;
  if(before.role!==value.role||before.branch_id!==value.branchId){
   related.substitutionsRevoked=(await db.query('UPDATE org_substitutions SET revoked_at=now() WHERE revoked_at IS NULL AND ends_at>now() AND (manager_id=$1 OR deputy_id=$1) RETURNING id',[id])).rows;
   related.approvalsStale=(await db.query("UPDATE approvals SET state='stale' WHERE state='pending' AND EXISTS(SELECT 1 FROM jsonb_array_elements(route) s WHERE s->>'userId'=$1) RETURNING id",[id])).rows;
  }
  const reason=value.reason||'Администратор обновил данные сотрудника';
  const auditId=randomUUID();
  await db.query('INSERT INTO employee_profile_changes(id,user_id,actor_id,before_snapshot,after_snapshot,reason,related_changes) VALUES($1,$2,$3,$4,$5,$6,$7)',[auditId,id,actor.id,JSON.stringify(before),JSON.stringify(after),reason,JSON.stringify(related)]);
  await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,$2,'employee_profile_changed','Изменены данные сотрудника',$3)",[randomUUID(),actor.id,JSON.stringify({profileChangeId:auditId,userId:id,before,after,reason})]);
  return {user:after,changed:true};
 });
}
