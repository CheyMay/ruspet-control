import {readFileSync} from 'node:fs';
import {pool} from '../server/db.js';
import {migrate} from './migrate.js';
import {seed} from './seed.js';
import {testManagerAccess} from '../server/test-manager-access.js';
try{
 const target=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
 if(target.db!=='ruspet_manager_preview'||target.role!=='ruspetpreview')throw Error('Wrong preview target');
 const password=readFileSync(0,'utf8');if(password.length<12||password.length>200)throw Error('Invalid password');
 await migrate();await seed();
 const result=await testManagerAccess({apply:true,password});
 await pool.query("DELETE FROM sessions; UPDATE telegram_settings SET enabled=false,delivery=false; UPDATE bitrix_live_config SET enabled=false;");
 console.log(`Тестовый менеджер: ${result.manager.name}. Логин: ${result.username}. Задач: ${result.manager.totals.total}.`);
 console.log('Используйте пароль, который ввели. Данные учебные, рабочие задачи не изменены.');
}catch{console.error('Подготовка тестовой БД не подтверждена. Проверьте целевую БД, роль и длину пароля (12–200 символов).');process.exitCode=1;}
finally{await pool.end();}
