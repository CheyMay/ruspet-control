import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import type {Server} from 'node:http';
import type {User} from '../shared/types.js';
import type {NewAccount} from '../server/account-access.js';

let adminConnection:pg.Client,db:typeof import('../server/db.js'),accounts:typeof import('../server/account-access.js'),server:Server,base:string,admin:User;
const database='ruspet_accounts_test_'+randomBytes(6).toString('hex');
const cookies=new Map<string,string>(),originalPassword=randomBytes(18).toString('base64url');
before(async()=>{
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 adminConnection=new pg.Client({connectionString:current});await adminConnection.connect();await adminConnection.query(`CREATE DATABASE ${database}`);
 const url=new URL(current);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();
 db=await import('../server/db.js');await (await import('../scripts/migrate.js')).migrate();
 const fixture=await import('../scripts/seed.js');await fixture.seed();admin=fixture.demoUsers.find(u=>u.role==='admin')!;
 await db.pool.query('UPDATE users SET account_manage_access=true WHERE id=$1',[admin.id]);
 const {hashPassword}=await import('../server/passwords.js');
 for(const role of ['admin','director'])await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash) SELECT $1,id,$2 FROM users WHERE role=$1',[role,await hashPassword(originalPassword)]);
 // An alias must not count as a second person; disabled access must stay disabled.
 await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$2,$3)',['admin.alias',admin.id,await hashPassword(originalPassword)]);
 for(let i=0;i<10;i++){
  await db.pool.query("INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$1,'employee','Фикстура','Менеджер')",['fixture-person-'+i]);
  await db.pool.query("INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,status,priority,code,price) VALUES($1,'РЗМ* Проверка входа','','Фикстура',$2,$3,'active','normal','РЗМ*',10000)",['fixture-task-'+i,'fixture-person-'+i,admin.id]);
 }
 await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash,enabled) VALUES($1,$2,$3,false)',['disabled.fixture','fixture-person-9',await hashPassword(originalPassword)]);
 accounts=await import('../server/account-access.js');
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 for(const id of [admin.id,'director','anna']){const r=await fetch(base+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:id})});assert.equal(r.status,200);cookies.set(id,r.headers.get('set-cookie')!.split(';')[0]);}
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));await db?.pool.end();if(adminConnection){await adminConnection.query(`DROP DATABASE IF EXISTS ${database}`);await adminConnection.end();}});

test('batch reaches ten distinct users without resetting passwords; failed credential storage rolls back and concurrent reruns create no duplicates',async()=>{
 const before=(await db.pool.query('SELECT * FROM login_accounts ORDER BY username')).rows;
 const plan=await accounts.planAccounts(10);assert.equal(plan.active,2);assert.equal(plan.rows.length,8);assert(!plan.rows.some(u=>u.id==='fixture-person-9'));
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM login_accounts')).rows[0].n,before.length);
 await assert.rejects(()=>accounts.provisionAccounts(10,async()=>{throw Error('fixture storage failure')}),/fixture storage failure/);
 assert.deepEqual((await db.pool.query('SELECT * FROM login_accounts ORDER BY username')).rows,before);
 const saved:NewAccount[]=[];
 const result=await Promise.all([accounts.provisionAccounts(10,async a=>{saved.push(...a)}),accounts.provisionAccounts(10,async a=>{saved.push(...a)})]);
 assert.equal(result.reduce((n,r)=>n+r.created,0),8);assert.equal(saved.length,8);assert.equal(new Set(saved.map(a=>a.password)).size,8);
 assert.equal((await accounts.planAccounts(10)).rows.length,0);
 for(const old of before)assert.deepEqual((await db.pool.query('SELECT * FROM login_accounts WHERE username=$1',[old.username])).rows[0],old);
 const sessions=new Set<string>();
 for(const account of saved){
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:account.username,password:account.password})});assert.equal(response.status,200);
  const user=(await response.json()).user;assert.equal(user.id,account.userId);assert.equal(user.role,'employee');
  const cookie=response.headers.get('set-cookie')!.split(';')[0];sessions.add(cookie);
  const bootstrap=await fetch(base+'/api/bootstrap',{headers:{Cookie:cookie}});assert.equal(bootstrap.status,200);const data=await bootstrap.json();assert(data.tasks.every((t:{assignee_id:string;creator_id:string})=>t.assignee_id===account.userId||t.creator_id===account.userId));
  assert.equal((await fetch(base+'/api/system/access',{headers:{Cookie:cookie}})).status,403);
  const hash=(await db.pool.query('SELECT password_hash FROM login_accounts WHERE username=$1',[account.username])).rows[0].password_hash;assert(await (await import('../server/passwords.js')).verifyPassword(account.password,hash));
  const audit=JSON.stringify((await db.pool.query("SELECT data FROM task_events WHERE kind='account_created'")).rows);assert(!audit.includes(account.password));assert(!audit.includes(hash));
 }
 assert.equal(sessions.size,8);
 assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:originalPassword})})).status,200);
});

test('administrator creates a specific staff login once; other roles, occupied names and disabled accounts are rejected without leaking credentials',async()=>{
 const create=async(user:string,id:string,username:string)=>fetch(base+'/api/system/access/'+id+'/account',{method:'POST',headers:{Cookie:cookies.get(user)||'','Content-Type':'application/json'},body:JSON.stringify({username})});
 assert.equal((await create('director','fixture-person-8','manual.fixture')).status,403);
 assert.equal((await create('anna','fixture-person-8','manual.fixture')).status,403);
 assert.equal((await create(admin.id,'does-not-exist','manual.fixture')).status,404);
 assert.equal((await create(admin.id,'fixture-person-8','admin')).status,409);
 assert.equal((await create(admin.id,'fixture-person-9','restore.disabled')).status,409);
 // A new named person does not need to have a task to receive a login manually.
 await db.pool.query("INSERT INTO users(id,name,role,branch_id,position) VALUES('manual-person','Фикстура ручного входа','employee','Фикстура','Менеджер')");
 const responses=await Promise.all([create(admin.id,'manual-person','manual.fixture'),create(admin.id,'manual-person','manual.fixture')]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);const success=await responses.find(r=>r.status===201)!.json();assert.equal(success.userId,'manual-person');assert.equal(success.password.length,24);
 const directory=await fetch(base+'/api/system/access',{headers:{Cookie:cookies.get(admin.id)!}});assert.equal(directory.status,200);const text=await directory.text();assert(!text.includes(success.password));assert(!text.includes('password_hash'));
 assert.equal((await db.pool.query("SELECT role FROM users WHERE id='manual-person'")).rows[0].role,'employee');
 await assert.rejects(()=>accounts.planAccounts(1000),/Недостаточно/);
});

async function request(path:string,cookie='',method='GET',body?:unknown){
 return fetch(base+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
}
async function signIn(username:string,password:string){
 const response=await request('/auth/login','','POST',{username,password});
 assert.equal(response.status,200);
 return response.headers.getSetCookie().find(item=>item.startsWith('ruspet_session='))!.split(';')[0];
}

test('personal credential change verifies the current password and keeps only the current session',async()=>{
 const {hashPassword}=await import('../server/passwords.js');
 await db.pool.query("INSERT INTO login_accounts(username,user_id,password_hash) VALUES('self.anna','anna',$1)",[await hashPassword(originalPassword)]);
 const active=await signIn('self.anna',originalPassword),other=await signIn('self.anna',originalPassword);
 const path='/auth/accounts/self.anna',password=randomBytes(20).toString('hex');
 const changes={username:'Self.ANNA.New',password,currentPassword:originalPassword};
 const list=await (await request('/auth/accounts',active)).json();
 const ownLogins=(await db.pool.query("SELECT username FROM login_accounts WHERE user_id='anna' AND enabled ORDER BY username")).rows;
 assert.deepEqual(list.accounts.map(({username}:{username:string})=>({username})),ownLogins);
 assert.equal((await request('/auth/accounts/director',active,'PUT',changes)).status,404);
 assert.equal((await request(path,active,'PUT',{...changes,currentPassword:'incorrect'})).status,403);
 assert.equal((await request(path,active,'PUT',{...changes,username:'director'})).status,409);
 assert.equal((await request(path,active,'PUT',changes)).status,200);
 assert.equal((await request('/auth/me',active)).status,200);
 assert.equal((await request('/auth/me',other)).status,401);
 assert.equal((await request('/auth/login','','POST',{username:'self.anna',password:originalPassword})).status,401);
 assert(await signIn('self.anna.new',password));
 const events=JSON.stringify((await db.pool.query("SELECT data FROM task_events WHERE kind='account_changed'")).rows);
 assert(!events.includes(password));assert(!events.includes(originalPassword));
});

test('the owner and a named delegate can manage employee logins while a regular administrator cannot',async()=>{
 await db.pool.query(`INSERT INTO users(id,name,role,branch_id,position,root_access,account_manage_access) VALUES
  ('fixture-owner','Владелец','admin','Тест','Тест',true,false),
  ('fixture-delegate','Уполномоченный сотрудник','employee','Тест','Тест',false,true),
  ('fixture-other-admin','Обычный администратор','admin','Тест','Тест',false,false)`);
 const {hashPassword}=await import('../server/passwords.js');
 const passwordHash=await hashPassword(originalPassword);
 for(const id of ['fixture-owner','fixture-delegate','fixture-other-admin'])
  await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$1,$2)',[id,passwordHash]);
 const owner=await signIn('fixture-owner',originalPassword),delegate=await signIn('fixture-delegate',originalPassword);
 const other=await signIn('fixture-other-admin',originalPassword);
 const rename={action:'rename',confirmed:true,username:'director.updated'};
 assert.equal((await request('/system/accounts',other)).status,403);
 assert.equal((await request('/system/access/director/account/director',other,'PUT',rename)).status,403);
 assert.equal((await request('/system/access/fixture-delegate/telegram',other,'PUT',{telegramId:'89901',confirmed:true})).status,403);
 const staffList=await (await request('/system/accounts',delegate)).json();
 assert(staffList.some((user:{id:string})=>user.id==='director'));
 assert(!staffList.some((user:{id:string})=>user.id==='fixture-owner'));
 assert.equal((await request('/system/access/fixture-owner/account/fixture-owner',delegate,'PUT',rename)).status,403);
 assert.equal((await request('/system/access/director/account/director',delegate,'PUT',rename)).status,200);
 const reset=await request('/system/access/director/account/director.updated',owner,'PUT',{action:'reset',confirmed:true});
 assert.equal(reset.status,200);
 assert(await signIn('director.updated',(await reset.json()).password));
});

test('a Telegram-only login can add a password from a recent bound session',async()=>{
 const {createHash}=await import('node:crypto');
 await db.pool.query("INSERT INTO users(id,name,role,branch_id,position) VALUES('fixture-telegram','Тестовый Telegram','employee','Тест','Тест')");
 await db.pool.query("INSERT INTO login_accounts(username,user_id,password_hash,password_login) VALUES('telegram.fixture','fixture-telegram','',false)");
 await db.pool.query('UPDATE telegram_settings SET enabled=true WHERE id=1');
 const binding=(await db.pool.query("INSERT INTO telegram_binding(chat_id,user_id) VALUES('89902','fixture-telegram') RETURNING id")).rows[0].id;
 const token=randomBytes(32).toString('hex'),tokenHash=createHash('sha256').update(token).digest('hex');
 const cookie='ruspet_session='+token,path='/auth/accounts/telegram.fixture';
 const changes={username:'telegram.updated',password:randomBytes(20).toString('hex')};
 await db.pool.query(`INSERT INTO sessions(token_hash,user_id,auth_method,telegram_binding_id,expires_at,authenticated_at)
  VALUES($1,'fixture-telegram','telegram',$2,now()+interval '1 hour',now()-interval '20 minutes')`,[tokenHash,binding]);
 assert.equal((await request(path,cookie,'PUT',changes)).status,409);
 await db.pool.query('UPDATE sessions SET authenticated_at=now() WHERE token_hash=$1',[tokenHash]);
 assert.equal((await request(path,cookie,'PUT',changes)).status,200);
 assert(await signIn(changes.username,changes.password));
});

test('the migration grants access only to the uniquely verified profile',async()=>{
 const migration=await readFile('server/migrations/063_account_settings.sql','utf8');
 await db.transaction(async client=>{
  await client.query(`CREATE TEMP TABLE users(id text,name text,root_access boolean DEFAULT false,staff_undo_access boolean DEFAULT false) ON COMMIT DROP;
   CREATE TEMP TABLE sessions(id text) ON COMMIT DROP;
   CREATE TEMP TABLE telegram_pairings(user_id text) ON COMMIT DROP;
   INSERT INTO users VALUES ('known','Руднева Надежда',false,true),('same-name','Надежда Руднева',false,false),('other','Надежда Тестовая',false,true);
   INSERT INTO telegram_pairings VALUES ('known'),('same-name');`);
  await client.query(migration);
  assert.deepEqual((await client.query('SELECT id FROM users WHERE account_manage_access')).rows,[{id:'known'}]);
  assert.deepEqual((await client.query('SELECT user_id FROM telegram_pairings')).rows,[{user_id:'same-name'}]);
 });
});
