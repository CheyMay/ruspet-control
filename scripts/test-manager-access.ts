import {parseArgs} from 'node:util';
import {readFileSync} from 'node:fs';
import {pool} from '../server/db.js';
import {testManagerAccess} from '../server/test-manager-access.js';
import {AppError} from '../server/domain.js';
try{
 const {values}=parseArgs({options:{apply:{type:'boolean'},'working-data':{type:'boolean'},'password-stdin':{type:'boolean'}}});
 if(values.apply&&!values['password-stdin'])throw new AppError(400,'Пароль передаётся через stdin с флагом --password-stdin, не через аргументы или чат.');
 const result=await testManagerAccess({apply:values.apply,allowWorkingData:values['working-data'],password:values['password-stdin']?readFileSync(0,'utf8'):undefined});
 console.log(JSON.stringify(result,null,2));
 if(!values.apply)console.log('Это предварительный просмотр: вход ещё не создан.');
 else if(result.existing)console.log('Этот тестовый вход уже есть. Прежний пароль сохранён.');
 else console.log('Вход создан. Используйте пароль, который ввели в терминале. Пароль не выводится и не сохраняется в файле.');
}catch(e){console.error(e instanceof AppError?e.message:'Операция не подтверждена. Проверьте версию схемы и доступ к БД. Пароль и служебные ошибки не выводятся.');process.exitCode=1;}
finally{await pool.end();}
