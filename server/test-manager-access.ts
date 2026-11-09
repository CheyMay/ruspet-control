import {randomUUID} from 'node:crypto';
import {transaction,type Db} from './db.js';
import {assert,moscowDay} from './domain.js';
import {hashPassword} from './passwords.js';
import {exclusionReason} from '../shared/task-selection.js';
const username='test.manager';
const normalize=(name:string)=>name.toLowerCase().replace(/ё/g,'е').replace(/[,\s]+/g,' ').trim().split(' ').sort().join(' ');
async function selectManager(db:Db){
 const users=(await db.query("SELECT * FROM users WHERE role='employee' ORDER BY id")).rows;
 const accounts=(await db.query('SELECT username,user_id,enabled FROM login_accounts')).rows;
 const pilot=new Set((await db.query('SELECT user_id FROM bitrix_pilot_members')).rows.map(r=>r.user_id));
 const excluded=new Set(['Виталий Шевченко','Александр Чекальский',...(await db.query('SELECT expected_name FROM bitrix_pilot_selection')).rows.map(r=>r.expected_name)].map(normalize));
 const tasks=(await db.query('SELECT id,title,assignee_id,creator_id,status,deadline FROM tasks')).rows.filter(t=>!exclusionReason(t));
 const linked=new Set((await db.query('SELECT task_id FROM bitrix_task_links WHERE live_enabled')).rows.map(t=>t.task_id));
 const today=moscowDay();
 const candidates=users.flatMap(user=>{
  if(pilot.has(user.id)||excluded.has(normalize(user.name))||/шевченко|чекальский/i.test(user.name))return [];
  const logins=accounts.filter(a=>a.user_id===user.id);if(logins.length&&!logins.some(a=>a.enabled))return [];
  const visible=tasks.filter(t=>t.assignee_id===user.id||t.creator_id===user.id);
  if(visible.some(t=>linked.has(t.id)))return [];
  const own=visible.filter(t=>t.assignee_id===user.id),active=own.filter(t=>t.status!=='completed');if(!active.length)return [];
  const totals={total:own.length,active:active.length,review:own.filter(t=>t.status==='review').length,completed:own.filter(t=>t.status==='completed').length,
   overdue:active.filter(t=>t.deadline&&moscowDay(t.deadline)<today).length,today:active.filter(t=>t.deadline&&moscowDay(t.deadline)===today).length};
  const coverage=[totals.review,totals.completed,totals.overdue,totals.today].filter(Boolean).length;
  return [{userId:user.id,name:user.name,role:user.role,branch:user.branch_id,totals,coverage}];
 }).sort((a,b)=>b.coverage-a.coverage||b.totals.active-a.totals.active||a.userId.localeCompare(b.userId));
 const existing=accounts.find(a=>a.username===username);
 if(existing){
  const marked=(await db.query("SELECT 1 FROM task_events WHERE kind='test_manager_access_created' AND data->>'username'=$1 AND data->>'userId'=$2 LIMIT 1",[username,existing.user_id])).rowCount;
  assert(marked,409,'Логин test.manager уже занят другим входом. Он не изменён.');
  assert(existing.enabled,409,'Тестовый вход отключён. Автоматически включать его нельзя.');
  const candidate=candidates.find(c=>c.userId===existing.user_id);assert(candidate,409,'Прежний тестовый менеджер теперь участвует в пилоте, связан с Битриксом либо недоступен. Вход не изменён.');
  return {username,existing:true,manager:candidate};
 }
 assert(candidates.length,409,'Нет подходящего менеджера вне пилота с активными задачами и без действующих связей Битрикса.');
 return {username,existing:false,manager:candidates[0]};
}
export async function testManagerAccess(input:{apply?:boolean;password?:string;allowWorkingData?:boolean}={}){
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431025)');await db.query('SELECT pg_advisory_xact_lock(431026)');
  const plan=await selectManager(db);if(!input.apply||plan.existing)return {...plan,created:false};
  const name=(await db.query('SELECT current_database() AS name')).rows[0].name;
  assert(input.allowWorkingData||name==='ruspet_manager_preview',409,'Для рабочей базы нужен явный флаг --working-data. Изменения задач под этим входом будут настоящими.');
  assert(typeof input.password==='string'&&input.password.length>=12&&input.password.length<=200,400,'Пароль должен содержать 12–200 символов.');
  await db.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$2,$3)',[username,plan.manager.userId,await hashPassword(input.password)]);
  await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,NULL,'test_manager_access_created','Создан тестовый вход менеджера',$2)",[randomUUID(),JSON.stringify({username,userId:plan.manager.userId,workingData:name!=='ruspet_manager_preview'})]);
  return {...plan,created:true};
 });
}
