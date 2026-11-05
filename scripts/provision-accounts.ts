import 'dotenv/config';
import {parseArgs} from 'node:util';
import {open,realpath,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pool} from '../server/db.js';
import {planAccounts,provisionAccounts,type NewAccount} from '../server/account-access.js';
import {AppError} from '../server/domain.js';

// Defaults to a read-only plan. Apply on the server using its own DATABASE_URL.
async function main(){
 const {values}=parseArgs({options:{apply:{type:'boolean',default:false},total:{type:'string',default:'10'},output:{type:'string'}}});
 const total=Number(values.total);
 if(!values.apply){
  const plan=await planAccounts(total);
  console.log(`Сейчас пользователей с активным входом: ${plan.active}. Цель: ${plan.target}. Будет создано: ${plan.rows.length}.`);
  for(const person of plan.rows)console.log(`${person.name} · ${person.role} · ${person.username}`);
  console.log('Пароли и база не изменены. Для создания добавьте --apply --output /opt/ruspet/.access/новый-файл.txt');return;
 }
 const path=values.output;
 if(!path||dirname(resolve(path))!=='/opt/ruspet/.access')throw new AppError(400,'Нужен новый файл непосредственно в /opt/ruspet/.access/.');
 const folder=await realpath(dirname(path)),info=await stat(folder);
 if(folder!==dirname(path)||(info.mode&0o077)!==0)throw new AppError(400,'Каталог .access должен быть обычным каталогом с правами 700.');
 const result=await provisionAccounts(total,async(accounts:NewAccount[])=>{
  const file=await open(path,'wx',0o600);
  try{
   const lines=['РУСПЭТ · новые персональные входы','Существующие пароли сохранены. Передайте каждому сотруднику только его данные.','',...accounts.map(a=>`Сотрудник: ${a.name}\nID: ${a.userId}\nРоль: ${a.role}\nЛогин: ${a.username}\nПароль: ${a.password}\n`)];
   await file.writeFile(lines.join('\n'),'utf8');await file.sync();
  }finally{await file.close();}
 });
 console.log(`Создано входов: ${result.created}. Пользователей с активным входом: ${result.active}.`);
 if(result.created)console.log(`Новые доступы сохранены в ${path}. Пароли в терминал не выводятся.`);
}
try{await main();}catch(e){
 console.error(e instanceof AppError?e.message:'Создание не подтверждено. Проверьте параметры, подключение, права каталога и наличие файла доступов. Если файл появился, сохраните его и сверьте список входов перед повтором.');process.exitCode=1;
}finally{await pool.end();}
