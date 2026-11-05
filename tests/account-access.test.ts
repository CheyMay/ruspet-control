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
