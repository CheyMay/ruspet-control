import {readFile} from 'node:fs/promises';
const file=process.argv[2];if(!file)throw new Error('Укажите файл с доступами.');
const source=(await readFile(file,'utf8')).replaceAll('\r\n','\n');
const accounts=[...source.matchAll(/(?:Сотрудник: [^\n]*\nID: ([^\n]+)\nРоль: ([a-z_]+)\n)?Логин: ([a-z0-9._-]+)\nПароль: (\S+)/g)];
if(!accounts.length)throw new Error('В файле не найдены персональные входы.');
const sessions=new Set<string>();
for(const [,userId,role,username,password] of accounts){
 const r=await fetch('http://127.0.0.1:4310/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
 if(r.status!==200)throw new Error(`Вход ${username} не работает: ${r.status}`);
 const cookie=r.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw new Error('Нет сессии.');
 try{
  if(sessions.has(cookie))throw new Error('Сессии совпали.');sessions.add(cookie);
  const b=await fetch('http://127.0.0.1:4310/api/bootstrap',{headers:{Cookie:cookie}});if(!b.ok)throw new Error(`Нет данных для ${username}.`);
  const data=await b.json(),expectedRole=role||(['admin','director'].includes(username)?username:null);
  if(userId&&data.user.id!==userId||expectedRole&&data.user.role!==expectedRole)throw new Error(`Неверный пользователь или роль ${username}.`);
 }finally{await fetch('http://127.0.0.1:4310/api/auth/logout',{method:'POST',headers:{Cookie:cookie}});}
}
if((await fetch('http://127.0.0.1:4310/api/demo/users')).status!==403)throw new Error('Демонстрационный вход ещё включён.');
console.log(`Проверено независимых входов: ${sessions.size}. Демонстрационный выбор роли выключен. Проверочные сессии завершены.`);
