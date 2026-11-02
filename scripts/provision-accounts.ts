import 'dotenv/config';
import {randomInt} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pool} from '../server/db.js';
import {hashPassword} from '../server/passwords.js';

// Run once on the server with an output path outside the repository.
const path=process.argv[2];
if(!path||!path.startsWith('/root/'))throw new Error('Укажите защищённый файл внутри /root/.');
const words=['Kedr','Volna','Sosna','Bereg','Maysky','Reka','Yantar','List','Ozero','Lipa','Kamen','Klen'];
const accounts=[{username:'admin',role:'admin'},{username:'director',role:'director'}] as const;
const lines=['РУСПЭТ · отдельные входы','Сохраните пароли в защищённом месте. Учётные записи сейчас привязаны к тестовым ролям.',''];
try{
 for(const item of accounts){
  const users=(await pool.query('SELECT id FROM users WHERE role=$1',[item.role])).rows;
  if(users.length!==1)throw new Error(`Нужно ровно одно назначение роли ${item.role}; найдено ${users.length}.`);
  const password=`${words[randomInt(words.length)]}${words[randomInt(words.length)]}${randomInt(1000,10000)}`;
  await pool.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$2,$3) ON CONFLICT(username) DO UPDATE SET user_id=excluded.user_id,password_hash=excluded.password_hash,enabled=true',[item.username,users[0].id,await hashPassword(password)]);
  lines.push(`Логин: ${item.username}\nПароль: ${password}\n`);
 }
 await writeFile(path,lines.join('\n'),{mode:0o600,flag:'wx'});
 console.log(`Созданы ${accounts.length} отдельных входа. Файл сохранён: ${path}`);
}finally{await pool.end();}
