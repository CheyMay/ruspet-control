import {createHash,randomBytes} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {assert} from './domain.js';
import {hashPassword,verifyPassword} from './passwords.js';
import {event} from './service.js';
import type {User} from '../shared/types.js';
import {mayManageStaffAccounts} from '../shared/workspace-access.js';

export type NewAccount={userId:string;name:string;role:User['role'];username:string;password:string};
export const accountLock=431026;
export const suggestedLogin=(userId:string)=>'staff-'+createHash('sha256').update(userId).digest('hex').slice(0,16);
export async function ensureLinkedAccount(user:Pick<User,'id'|'root_access'>){
 if(user.root_access)return;
 await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock($1)',[accountLock]);
  if(!(await db.query('SELECT 1 FROM login_accounts WHERE user_id=$1',[user.id])).rowCount)
   await db.query("INSERT INTO login_accounts(username,user_id,password_hash,password_login) VALUES($1,$2,'',false)",[suggestedLogin(user.id),user.id]);
 });
}
const validLogin=(username:string)=>/^[a-z0-9._-]{3,32}$/.test(username);
type Account={username:string;enabled:boolean;password_login:boolean};
type AccountAction={action:'enable'|'disable'|'reset'}|{action:'rename';username:string};
async function assertLoginAvailable(db:Db,username:string,current?:string){
 assert(validLogin(username),400,'Логин: 3–32 символа, латинские строчные буквы, цифры, точка, дефис или подчёркивание.');
 if(username!==current)assert(!(await db.query('SELECT 1 FROM login_accounts WHERE username=$1',[username])).rowCount,409,'Логин занят.');
}
async function invalidateAccountSessions(db:Db,userId:string,keepSession?:string){
 await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash IS DISTINCT FROM $2',[userId,keepSession??null]);
 await db.query("UPDATE telegram_login_requests SET state='cancelled' WHERE user_id=$1 AND state IN ('pending','approved')",[userId]);
}
async function accountSession(db:Db,userId:string,tokenHash:string){
 const session=(await db.query<{recent_telegram:boolean}>(`SELECT (s.auth_method='telegram' AND s.authenticated_at>now()-interval '10 minutes') IS TRUE AS recent_telegram
  FROM sessions s WHERE s.user_id=$1 AND s.token_hash=$2 AND s.expires_at>now()
  AND (s.auth_method<>'telegram' OR (EXISTS(SELECT 1 FROM telegram_binding b WHERE b.id=s.telegram_binding_id AND b.user_id=s.user_id)
   AND EXISTS(SELECT 1 FROM telegram_settings WHERE id=1 AND enabled)))`,[userId,tokenHash])).rows[0];
 assert(session,401,'Сессия завершена. Войдите снова.');
 return session;
}
export async function ownAccounts(actor:User,tokenHash:string){
 const session=await accountSession(pool,actor.id,tokenHash);
 const accounts=(await pool.query<Account>('SELECT username,enabled,password_login FROM login_accounts WHERE user_id=$1 AND enabled ORDER BY username',[actor.id])).rows;
 return {accounts,recentTelegram:session.recent_telegram};
}
export async function updateOwnAccount(actor:User,tokenHash:string,currentLogin:string,input:{username:string;password?:string;currentPassword?:string}){
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  await db.query('SELECT pg_advisory_xact_lock($1)',[accountLock]);
  const session=await accountSession(db,actor.id,tokenHash);
  const current=(await db.query<Account&{password_hash:string}>('SELECT username,enabled,password_login,password_hash FROM login_accounts WHERE user_id=$1 AND username=$2 AND enabled FOR UPDATE',[actor.id,currentLogin])).rows[0];
  assert(current,404,'Активный вход не найден.');
  if(current.password_login)assert(input.currentPassword&&await verifyPassword(input.currentPassword,current.password_hash),403,'Текущий пароль неверный.');
  else assert(!actor.root_access&&session.recent_telegram&&input.password,409,'Подтвердите вход через Telegram заново и задайте пароль.');
  await assertLoginAvailable(db,input.username,currentLogin);
  if(input.username!==currentLogin||input.password){
   await db.query(`UPDATE login_accounts SET username=$3,password_hash=COALESCE($4,password_hash),password_login=true WHERE user_id=$1 AND username=$2`,
    [actor.id,currentLogin,input.username,input.password?await hashPassword(input.password):null]);
   if(input.password)await invalidateAccountSessions(db,actor.id,tokenHash);
   await event(db,null,actor.id,'account_changed','Обновлены личные данные входа',{userId:actor.id,username:input.username,action:'self_update'});
  }
  return {username:input.username};
 });
}
export async function staffAccounts(actor:User){
 assert(mayManageStaffAccounts(actor),403,'Входы сотрудников настраивает владелец или уполномоченный сотрудник.');
 const {rows}=await pool.query<{id:string;name:string;accounts:Account[]}>(`SELECT u.id,u.name,COALESCE((SELECT json_agg(a ORDER BY a.username) FROM
  (SELECT username,enabled,password_login FROM login_accounts WHERE user_id=u.id) a),'[]'::json) AS accounts
  FROM users u WHERE NOT u.root_access AND u.id<>$1 ORDER BY u.name,u.id`,[actor.id]);
 return rows.map(user=>({...user,suggestedLogin:suggestedLogin(user.id)}));
}
async function insertAccount(db:Db,user:User,username:string,actorId:string|null):Promise<NewAccount>{
 assert(validLogin(username),400,'Логин: 3–32 символа, латинские строчные буквы, цифры, точка, дефис или подчёркивание.');
 assert(!(await db.query('SELECT 1 FROM login_accounts WHERE user_id=$1 OR username=$2',[user.id,username])).rowCount,409,'У сотрудника уже есть вход либо этот логин занят. Обновите список.');
 const password=randomBytes(18).toString('base64url');
 await db.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$2,$3)',[username,user.id,await hashPassword(password)]);
 await event(db,null,actorId,'account_created','Создан персональный вход',{userId:user.id,username});
 return {userId:user.id,name:user.name,role:user.role,username,password};
}
export async function createUserAccount(actor:User,userId:string,username:string){
 assert(mayManageStaffAccounts(actor),403,'Входы сотрудников настраивает владелец или уполномоченный сотрудник.');
 assert(userId!==actor.id,403,'Свой вход измените в личных настройках.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  await db.query('SELECT pg_advisory_xact_lock($1)',[accountLock]);
  const user=(await db.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
  assert(user,404,'Сотрудник не найден.');
  assert(!user.root_access,403,'Вход владельца доступен в его личных настройках.');
  const current=(await db.query('SELECT * FROM login_accounts WHERE user_id=$1',[user.id])).rows;
  if(current.length===1&&!current[0].password_login&&current[0].enabled){
   assert(validLogin(username),400,'Некорректный логин.');
   assert(!(await db.query('SELECT 1 FROM login_accounts WHERE username=$1 AND user_id<>$2',[username,user.id])).rowCount,409,'Логин занят.');
   const password=randomBytes(18).toString('base64url');
   await db.query('UPDATE login_accounts SET username=$2,password_hash=$3,password_login=true WHERE user_id=$1',[user.id,username,await hashPassword(password)]);
   await invalidateAccountSessions(db,user.id);
   await event(db,null,actor.id,'account_created','Добавлен вход по паролю',{userId:user.id,username});return {userId:user.id,name:user.name,role:user.role,username,password};
  }
  return insertAccount(db,user,username,actor.id);
 });
}
export async function changeUserAccount(actor:User,userId:string,username:string,input:AccountAction){
 assert(mayManageStaffAccounts(actor),403,'Входы сотрудников настраивает владелец или уполномоченный сотрудник.');
 assert(userId!==actor.id,403,'Свой вход измените в личных настройках.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  await db.query('SELECT pg_advisory_xact_lock($1)',[accountLock]);
  const target=(await db.query('SELECT id,name,role,root_access FROM users WHERE id=$1',[userId])).rows[0];
  assert(target,404,'Сотрудник не найден.');
  assert(!target.root_access,403,'Вход владельца доступен в его личных настройках.');
  const account=(await db.query('SELECT enabled,password_login FROM login_accounts WHERE user_id=$1 AND username=$2 FOR UPDATE',[userId,username])).rows[0];
  assert(account,404,'Вход сотрудника не найден.');
  const {action}=input;
  const password=action==='reset'?randomBytes(18).toString('base64url'):undefined;
  const nextLogin=input.action==='rename'?input.username:username;
  if(password){
   assert(account.enabled&&account.password_login,409,'Сброс доступен для активного входа с паролем.');
   await db.query('UPDATE login_accounts SET password_hash=$3 WHERE user_id=$1 AND username=$2',[userId,username,await hashPassword(password)]);
  }else if(action==='rename'){
   await assertLoginAvailable(db,nextLogin,username);
   await db.query('UPDATE login_accounts SET username=$3 WHERE user_id=$1 AND username=$2',[userId,username,nextLogin]);
  }else{
   await db.query('UPDATE login_accounts SET enabled=$3 WHERE user_id=$1 AND username=$2',[userId,username,action==='enable']);
  }
  if(action==='reset'||action==='disable')await invalidateAccountSessions(db,userId);
  const message={enable:'Вход сотрудника включён',disable:'Вход сотрудника отключён',reset:'Пароль сотрудника обновлён',rename:'Логин сотрудника изменён'}[action];
  await event(db,null,actor.id,'account_changed',message,{userId,username:nextLogin,action});
  return {name:target.name,username:nextLogin,password};
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
