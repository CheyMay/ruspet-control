import {randomUUID} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {assert,AppError} from './domain.js';
import {namesMatch,nameParts,normalPhone} from './staff-import.js';
import {suggestedLogin} from './account-access.js';
import type {User} from '../shared/types.js';
import type {BotScreen} from './bot.js';
const screen=(text:string,replyKeyboard:'contact'|'remove'='remove'):BotScreen=>({text,buttons:[],replyKeyboard});
const askContact=()=>screen('Подтвердите личность: нажмите «Поделиться своим номером». Бот сравнит номер вашего Telegram со справочником сотрудников. Вводить номер вручную не нужно. Если номер отличается от рабочего — отправьте /manual для проверки администратором.','contact');
export async function ensureLinkedAccount(user:User){
 await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431026)');
  if(!(await db.query('SELECT 1 FROM login_accounts WHERE user_id=$1',[user.id])).rowCount)
   await db.query("INSERT INTO login_accounts(username,user_id,password_hash,password_login) VALUES($1,$2,'',false)",[suggestedLogin(user.id),user.id]);
 });
}
async function finish(db:Db,request:any,staff:any,actor:User|null,selectedUserId?:string,forceNew=false){
 assert(staff?.enabled,409,'Выберите действующего сотрудника справочника.');
 const selected=selectedUserId||staff.user_id;
 const users=selected?(await db.query('SELECT * FROM users WHERE id=$1',[selected])).rows:(await db.query('SELECT * FROM users')).rows.filter(u=>namesMatch(u.name,staff.name));
 const sameNames=(await db.query('SELECT name FROM staff_directory WHERE enabled AND id<>$1',[staff.id])).rows.filter(s=>namesMatch(s.name,staff.name));
 assert(actor||(!sameNames.length||!!staff.user_id),409,'Требуется проверка администратора.');
 assert(forceNew||users.length<=1,409,'Уточните, к какому существующему сотруднику привязать заявку.');
 let user:User|undefined=forceNew?undefined:users[0];assert(!selected||user,404,'Пользователь не найден.');
 if(user){
  const accounts=(await db.query('SELECT enabled FROM login_accounts WHERE user_id=$1',[user.id])).rows;
  assert(!accounts.length||accounts.some(a=>a.enabled),403,'Вход сотрудника отключён. Сначала восстановите доступ отдельно.');
  const old=(await db.query('SELECT chat_id,user_id FROM telegram_binding WHERE user_id=$1 OR chat_id=$2',[user.id,request.chat_id])).rows;
  assert(!old.length||old.every(b=>b.chat_id===request.chat_id&&b.user_id===user!.id),409,'У сотрудника или Telegram уже есть другая привязка.');
 }
 assert(!(await db.query('SELECT 1 FROM telegram_binding WHERE chat_id=$1',[request.chat_id])).rowCount,409,'Telegram уже подключён. Обновите список.');
 await db.query('SELECT pg_advisory_xact_lock(431026)');
 if(!user){
  const id='staff-'+randomUUID();user=(await db.query<User>("INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,'employee',$3,$4) RETURNING *",[id,staff.name,staff.organisation,staff.department||'Сотрудник'])).rows[0];
 }
 if(!(await db.query('SELECT 1 FROM login_accounts WHERE user_id=$1',[user.id])).rowCount){
  await db.query("INSERT INTO login_accounts(username,user_id,password_hash,password_login) VALUES($1,$2,'',false)",[suggestedLogin(user.id),user.id]);
 }
 await db.query('INSERT INTO telegram_binding(chat_id,user_id) VALUES($1,$2)',[request.chat_id,user.id]);
 await db.query('UPDATE staff_directory SET user_id=$2 WHERE id=$1',[staff.id,user.id]);
 await db.query("UPDATE telegram_registrations SET state='approved',staff_id=$2,user_id=$3,reviewed_by=$4,decided_at=now() WHERE id=$1",[request.id,staff.id,user.id,actor?.id||null]);
 await db.query('DELETE FROM telegram_registration_blocks WHERE chat_id=$1',[request.chat_id]);
 await db.query('DELETE FROM telegram_pairings WHERE user_id=$1',[user.id]);
 await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,$2,'staff_connected','Telegram сотрудника подключён',$3)",[randomUUID(),actor?.id||user.id,JSON.stringify({userId:user.id,method:actor?'admin':'own_contact',registrationId:request.id})]);
 return user;
}
export async function onboardingMessage(message:any):Promise<BotScreen|null>{
 const chat=String(message.chat?.id||''),sender=message.from;
 if(message.chat?.type!=='private'||!sender||sender.is_bot||String(sender.id)!==chat||!/^[1-9]\d{0,15}$/.test(chat))return null;
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  const enabled=(await db.query('SELECT enabled FROM telegram_settings WHERE id=1')).rows[0]?.enabled;
  if(!enabled)return screen('Подключение к боту временно отключено. Обратитесь к администратору.');
  if((await db.query('SELECT 1 FROM telegram_binding WHERE chat_id=$1',[chat])).rowCount)return null;
  await db.query("UPDATE telegram_registrations SET state='cancelled' WHERE chat_id=$1 AND state IN ('name','contact','review') AND expires_at<=now()",[chat]);
  let request=(await db.query("SELECT * FROM telegram_registrations WHERE chat_id=$1 AND state IN ('name','contact','review') FOR UPDATE",[chat])).rows[0];
  const text=String(message.text||'').trim();
  if(text==='/cancel'){
   if(request)await db.query("UPDATE telegram_registrations SET state='cancelled',decided_at=now() WHERE id=$1",[request.id]);
   return screen('Подключение отменено. Для новой попытки отправьте /start.');
  }
  if(!request){
   if(text!=='/start'&&text!=='/menu')return screen('Для подключения отправьте /start.');
   if(!(await db.query('SELECT 1 FROM staff_directory WHERE enabled LIMIT 1')).rowCount)return screen('Справочник сотрудников ещё не загружен. Попросите администратора загрузить его в настройках.');
   const attempts=(await db.query("SELECT count(*)::int n FROM telegram_registrations WHERE chat_id=$1 AND created_at>now()-interval '1 day'",[chat])).rows[0].n;
   if(attempts>=5)return screen('Слишком много попыток подключения за сутки. Обратитесь к администратору.');
   request=(await db.query("INSERT INTO telegram_registrations(id,chat_id,state) VALUES($1,$2,'name') RETURNING *",[randomUUID(),chat])).rows[0];
   return screen('Здравствуйте! Напишите ваши имя и фамилию, как в справочнике сотрудников. Например: Иван Петров.');
  }
  if(request.state==='review')return screen('Заявка ожидает проверки администратора. После подтверждения отправьте /start — откроется ваше рабочее меню.');
  if(text==='/start'||text==='/menu')return request.state==='name'?screen('Напишите ваши имя и фамилию.'):askContact();
  if(request.state==='name'){
   if(!/^[\p{L}\s,\-]{3,150}$/u.test(text)||nameParts(text).length<2||nameParts(text).length>4)return screen('Нужны имя и фамилия словами. Например: Иван Петров.');
   await db.query("UPDATE telegram_registrations SET entered_name=$2,state='contact' WHERE id=$1",[request.id,text]);return askContact();
  }
  if(text==='/manual'||text==='Не могу поделиться номером'){
   await db.query("UPDATE telegram_registrations SET state='review' WHERE id=$1",[request.id]);return screen('Заявка передана администратору. Он подтвердит личность и выберет сотрудника. После подтверждения отправьте /start.');
  }
  const contact=message.contact;
  if(!contact||String(contact.user_id)!==chat||message.forward_origin||message.forward_date||message.via_bot)return askContact();
  const phone=normalPhone(contact.phone_number);if(!phone)return askContact();
  await db.query('UPDATE telegram_registrations SET own_contact_verified=true,phone_tail=$2 WHERE id=$1',[request.id,phone.slice(-4)]);
  const all=(await db.query('SELECT * FROM staff_directory WHERE enabled')).rows;
  const owners=all.filter(s=>s.phones.includes(phone)),candidate=owners.length===1&&namesMatch(request.entered_name,owners[0].name)?owners[0]:null;
  const blocked=(await db.query('SELECT 1 FROM telegram_registration_blocks WHERE chat_id=$1',[chat])).rowCount;
  if(candidate&&!blocked){
   try{await finish(db,request,candidate,null);return screen('Вы подключены! Ваш Telegram связан с учётной записью сотрудника. Отправьте /menu для работы с задачами. На сайте теперь можно входить через QR-код.');}
   catch(e){if(!(e instanceof AppError))throw e;}
  }
  await db.query("UPDATE telegram_registrations SET state='review',staff_id=$2 WHERE id=$1",[request.id,candidate?.id||null]);
  return screen('Автоматическое подтверждение не завершено. Заявка передана администратору; после проверки отправьте /start.');
 });
}
export async function listRegistrations(actor:User){
 assert(actor.role==='admin',403,'Заявки проверяет администратор.');
 const requests=(await pool.query("SELECT id,chat_id,entered_name,state,staff_id,own_contact_verified,phone_tail,created_at FROM telegram_registrations WHERE state='review' AND expires_at>now() ORDER BY created_at LIMIT 100")).rows;
 const staff=(await pool.query('SELECT id,name,organisation,department,user_id FROM staff_directory WHERE enabled ORDER BY name')).rows;
 const users=(await pool.query('SELECT id,name,role,branch_id FROM users ORDER BY name')).rows;
 return {requests,staff,users};
}
export async function reviewRegistration(actor:User,id:string,input:{action:'approve'|'reject';staffId?:string;userId?:string;forceNew?:boolean}){
 assert(actor.role==='admin',403,'Заявки проверяет администратор.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  const request=(await db.query("SELECT * FROM telegram_registrations WHERE id=$1 AND state='review' AND expires_at>now() FOR UPDATE",[id])).rows[0];assert(request,409,'Заявка уже обработана или устарела.');
  if(input.action==='reject')await db.query("UPDATE telegram_registrations SET state='rejected',reviewed_by=$2,decided_at=now() WHERE id=$1",[id,actor.id]);
  else{
   const staff=(await db.query('SELECT * FROM staff_directory WHERE id=$1',[input.staffId||request.staff_id])).rows[0];
   await finish(db,request,staff,actor,input.userId,input.forceNew);
  }
  return {ok:true};
 });
}
