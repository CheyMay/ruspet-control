import {createHash,randomBytes} from 'node:crypto';
import {transaction,type Db} from './db.js';
import {assert} from './domain.js';
import {hashPassword} from './passwords.js';
import {event} from './service.js';
import type {User} from '../shared/types.js';

export type NewAccount={userId:string;name:string;role:User['role'];username:string;password:string};
const accountLock=431026;
export const suggestedLogin=(userId:string)=>'staff-'+createHash('sha256').update(userId).digest('hex').slice(0,16);
const validLogin=(username:string)=>/^[a-z0-9._-]{3,32}$/.test(username);
async function insertAccount(db:Db,user:User,username:string,actorId:string|null):Promise<NewAccount>{
 assert(validLogin(username),400,'Логин: 3–32 символа, латинские строчные буквы, цифры, точка, дефис или подчёркивание.');
 assert(!(await db.query('SELECT 1 FROM login_accounts WHERE user_id=$1 OR username=$2',[user.id,username])).rowCount,409,'У сотрудника уже есть вход либо этот логин занят. Обновите список.');
 const password=randomBytes(18).toString('base64url');
 await db.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$2,$3)',[username,user.id,await hashPassword(password)]);
 await event(db,null,actorId,'account_created','Создан персональный вход',{userId:user.id,username});
 return {userId:user.id,name:user.name,role:user.role,username,password};
}
export async function createUserAccount(actor:User,userId:string,username:string){
 assert(actor.role==='admin',403,'Входы сотрудников создаёт администратор.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock($1)',[accountLock]);
  const user=(await db.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
  assert(user,404,'Сотрудник не найден.');
  assert(!user.root_access,403,'Доступ владельца настраивается отдельно.');
  const current=(await db.query('SELECT * FROM login_accounts WHERE user_id=$1',[user.id])).rows;
  if(current.length===1&&!current[0].password_login&&current[0].enabled){
   assert(validLogin(username),400,'Некорректный логин.');
   assert(!(await db.query('SELECT 1 FROM login_accounts WHERE username=$1 AND user_id<>$2',[username,user.id])).rowCount,409,'Логин занят.');
   const password=randomBytes(18).toString('base64url');
   await db.query('UPDATE login_accounts SET username=$2,password_hash=$3,password_login=true WHERE user_id=$1',[user.id,username,await hashPassword(password)]);
   await event(db,null,actor.id,'account_created','Добавлен вход по паролю',{userId:user.id,username});return {userId:user.id,name:user.name,role:user.role,username,password};
  }
  return insertAccount(db,user,username,actor.id);
 });
}
async function accountPlan(db:Db,total:number){
 assert(Number.isInteger(total)&&total>=1&&total<=1000,400,'Число пользователей должно быть от 1 до 1000.');
 const active=Number((await db.query('SELECT count(DISTINCT user_id)::int n FROM login_accounts WHERE enabled')).rows[0].n),required=Math.max(0,total-active);
 // Disabled accounts stay disabled. Roles and employee records are never changed.
 const candidates=(await db.query<User>(`SELECT u.* FROM users u
 WHERE NOT u.root_access AND NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id)
 AND (u.role IN ('admin','director') OR u.role='employee' AND EXISTS(SELECT 1 FROM tasks t WHERE t.assignee_id=u.id))
 ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'director' THEN 1 ELSE 2 END,
 (SELECT count(*) FROM tasks t WHERE t.assignee_id=u.id) DESC,u.id LIMIT $1`,[required])).rows;
 assert(candidates.length===required,409,'Недостаточно сотрудников без входа. Создайте недостающие входы вручную в «Доступах сотрудников» или укажите меньшее число. Отключённые аккаунты не включаются автоматически.');
 const rows=candidates.map(person=>({...person,username:person.role==='admin'?'admin':person.role==='director'?'director':suggestedLogin(person.id)}));
 for(const person of rows)assert(!(await db.query('SELECT 1 FROM login_accounts WHERE username=$1',[person.username])).rowCount,409,'Предлагаемый логин занят. Создайте вход вручную в панели.');
 return {active,target:total,rows};
}
export async function planAccounts(total=10){return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock($1)',[accountLock]);return accountPlan(db,total);});}
/** Save credentials before commit: a file error rolls back the whole batch. */
export async function provisionAccounts(total:number,persist:(accounts:NewAccount[])=>Promise<void>){
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock($1)',[accountLock]);
  const plan=await accountPlan(db,total),accounts:NewAccount[]=[];
  for(const person of plan.rows)accounts.push(await insertAccount(db,person,person.username,null));
  if(accounts.length)await persist(accounts);
  return {created:accounts.length,active:plan.active+accounts.length};
 });
}
