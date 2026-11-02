import {readFile} from 'node:fs/promises';
const file=process.argv[2];if(!file)throw new Error('Укажите файл с доступами.');
const source=await readFile(file,'utf8');
const accounts=[...source.matchAll(/Логин: ([a-z0-9._-]+)\nПароль: (\S+)/g)];
if(accounts.length!==2)throw new Error('Ожидались два отдельных входа.');
const sessions:string[]=[];
for(const [,username,password] of accounts){
 const r=await fetch('http://127.0.0.1:4310/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
 if(r.status!==200)throw new Error(`Вход ${username} не работает: ${r.status}`);
 const cookie=r.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw new Error('Нет сессии.');sessions.push(cookie);
 const b=await fetch('http://127.0.0.1:4310/api/bootstrap',{headers:{Cookie:cookie}});if(!b.ok)throw new Error(`Нет данных для ${username}.`);
 const data=await b.json();if(data.user.role!==username)throw new Error(`Неверная роль ${username}.`);
}
if(sessions[0]===sessions[1])throw new Error('Сессии совпали.');
if((await fetch('http://127.0.0.1:4310/api/demo/users')).status!==403)throw new Error('Демонстрационный вход ещё включён.');
console.log('Два независимых входа работают; демонстрационный выбор роли выключен.');
