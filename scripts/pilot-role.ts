import 'dotenv/config';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';
import {pool,transaction} from '../server/db.js';
import {assert,AppError} from '../server/domain.js';
const {values}=parseArgs({options:{user:{type:'string'},role:{type:'string'},branch:{type:'string'},confirm:{type:'boolean'}}});
try{
 assert(values.user&&values.role&&['employee','branch_manager','sales_head','director'].includes(values.role),400,'Параметры: --user ID --role employee|branch_manager|sales_head|director [--branch филиал] [--confirm]');
 await transaction(async db=>{
  const user=(await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[values.user])).rows[0];assert(user&&user.role!=='admin',400,'Нужен существующий профиль; администратора этот скрипт не меняет.');
  const branch=values.branch?.trim()||user.branch_id;
  console.log({id:user.id,name:user.name,before:{role:user.role,branch:user.branch_id},after:{role:values.role,branch}});
  if(!values.confirm){console.log('Предварительный просмотр. Сохранение — с --confirm.');return;}
  assert(!(await db.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0].enabled,409,'Приостановите пилот перед изменением ролей.');
  await db.query('UPDATE users SET role=$2,branch_id=$3 WHERE id=$1',[user.id,values.role,branch]);
  await db.query('DELETE FROM sessions WHERE user_id=$1',[user.id]);
  await db.query('UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND receipt IS NULL',[user.id]);
  await db.query('DELETE FROM bot_sessions WHERE actor_id=$1',[user.id]);
  await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,NULL,'pilot_role_configured','Настроена роль участника пилота оператором сервера',$2)",[randomUUID(),JSON.stringify({userId:user.id,before:{role:user.role,branch:user.branch_id},after:{role:values.role,branch}})]);
  console.log('Роль сохранена. Задачи и пароли не изменены; войдите заново.');
 });
}catch(e){console.error(e instanceof AppError?e.message:'Не удалось настроить роль. Изменения не подтверждены.');process.exitCode=1;}finally{await pool.end();}
