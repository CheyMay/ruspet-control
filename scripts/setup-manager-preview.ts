import {readFileSync} from 'node:fs';
import {pool} from '../server/db.js';
import {migrate} from './migrate.js';
import {seed} from './seed.js';
import {hashPassword} from '../server/passwords.js';
import {testManagerAccess} from '../server/test-manager-access.js';
try{
 const target=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
 if(target.db!=='ruspet_manager_preview'||target.role!=='ruspetpreview')throw Error('Wrong preview target');
 const [password,adminPassword,extra]=readFileSync(0,'utf8').split('\n');
 const valid=(value:string)=>value.length>=12&&value.length<=200;
 if(!valid(password)||extra!==undefined||adminPassword!==undefined&&(!valid(adminPassword)||adminPassword===password))throw Error('Invalid password');
 await migrate();await seed();
 const result=await testManagerAccess({apply:true,password});
 if(adminPassword){
  const admin=await pool.query(`INSERT INTO login_accounts(username,user_id,password_hash)
   SELECT 'preview.admin',id,$1 FROM users WHERE id='admin' AND role='admin'
   ON CONFLICT (username) DO NOTHING`,[await hashPassword(adminPassword)]);
  if(admin.rowCount!==1)throw Error('Preview admin could not be created');
  console.log('Учебный администратор: preview.admin.');
 }
 await pool.query("DELETE FROM sessions; UPDATE telegram_settings SET enabled=false,delivery=false; UPDATE bitrix_live_config SET enabled=false;");
 console.log(`Тестовый менеджер: ${result.manager.name}. Логин: ${result.username}. Задач: ${result.manager.totals.total}.`);
 console.log('Данные учебные, рабочие задачи не изменены.');
}catch{console.error('Подготовка тестовой БД не подтверждена. Проверьте целевую БД, роль и длину пароля (12–200 символов).');process.exitCode=1;}
finally{await pool.end();}
