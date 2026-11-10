import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import pg from 'pg';
import type {Server} from 'node:http';
let db:typeof import('../server/db.js'),access:typeof import('../server/test-manager-access.js'),master:pg.Client,server:Server,base:string,previewProcess:ChildProcess|undefined;
const database='ruspet_manager_access_test_'+randomBytes(5).toString('hex'),password=randomBytes(18).toString('base64url');
let rootUrl:string,previewUrl:string;
let previewRoleCreated=false,previewDatabaseCreated=false;
const adminPassword=randomBytes(18).toString('base64url');
const tsxArgs=['--import','tsx'];
async function makeTasks(id:string,title='РЗМ* Учебная задача'){
 const statuses=['active','active','review','completed','active','active','active','active','active'];
 for(let i=0;i<statuses.length;i++)await db.pool.query(`INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,status,priority,code,deadline,price)
 VALUES($1,$2,'Учебные данные','Тест',$3,'admin',$4,'normal','РЗМ*',now()+($5::int*interval '1 day'),10000)`,[id+'-'+i,title,id,statuses[i],i===0?-1:i===1?0:1]);
}
before(async()=>{
 rootUrl=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;master=new pg.Client({connectionString:rootUrl});await master.connect();await master.query(`CREATE DATABASE ${database}`);const url=new URL(rootUrl);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();process.env.DEMO_AUTH='false';
 db=await import('../server/db.js');await(await import('../scripts/migrate.js')).migrate();await(await import('../scripts/seed.js')).seed();access=await import('../server/test-manager-access.js');
 for(const [id,name]of [['choice','Учебнов Иван'],['pilot-name','Шевченко Виталий'],['pilot-other','Другой Пилот'],['pilot-member','Участник Пилота'],['disabled','Отключённый Менеджер'],['checklists','Владелец Чеклистов']]){
  await db.pool.query("INSERT INTO users VALUES($1,$2,'employee','Тест','Фикстура')",[id,name]);await makeTasks(id,id==='checklists'?'Чек-лист проверки':'РЗМ* Учебная задача');
 }
 await db.pool.query("UPDATE bitrix_pilot_selection SET expected_name='Другой Пилот' WHERE ordinal=1");
 await db.pool.query("INSERT INTO bitrix_pilot_members VALUES('pilot-member','manager')");
 await db.pool.query("INSERT INTO login_accounts(username,user_id,password_hash,enabled) VALUES('disabled.fixture','disabled','not-a-password',false)");
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
after(async()=>{
 if(previewProcess&&previewProcess.exitCode===null&&previewProcess.signalCode===null){const exited=new Promise<void>(r=>previewProcess!.once('exit',()=>r()));previewProcess.kill('SIGTERM');await exited}
 if(server)await new Promise<void>(r=>server.close(()=>r()));await db?.pool.end();
 if(master){await master.query(`DROP DATABASE IF EXISTS ${database}`);if(previewDatabaseCreated)await master.query('DROP DATABASE ruspet_manager_preview');if(previewRoleCreated)await master.query('DROP ROLE ruspetpreview');await master.end()}
});

test('manager selection excludes fixed names, configured pilot users, disabled access, hidden checklists and live-linked tasks',async()=>{
 const plan=await access.testManagerAccess();assert.equal(plan.manager.userId,'choice');assert.equal(plan.created,false);assert.equal(plan.manager.role,'employee');
 const before=await db.pool.query('SELECT count(*)::int n FROM login_accounts');assert.equal(before.rows[0].n,1);
 await db.pool.query("INSERT INTO bitrix_task_snapshots(external_id,snapshot) VALUES(98765,'{}')");
 await db.pool.query("INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version,live_enabled) VALUES('choice-0',98765,'{}',1,true)");
 assert.notEqual((await access.testManagerAccess()).manager.userId,'choice');await db.pool.query("UPDATE bitrix_task_links SET live_enabled=false WHERE task_id='choice-0'");
});

test('test access is explicit, idempotent and restricted to employee permissions without modifying tasks or other passwords',async()=>{
 const before=(await db.pool.query('SELECT * FROM tasks ORDER BY id')).rows;
 await assert.rejects(()=>access.testManagerAccess({apply:true,password}),/working-data/);
 await assert.rejects(()=>access.testManagerAccess({apply:true,allowWorkingData:true,password:'short'}),/12/);
 const results=await Promise.all([access.testManagerAccess({apply:true,allowWorkingData:true,password}),access.testManagerAccess({apply:true,allowWorkingData:true,password})]);assert.equal(results.filter(r=>r.created).length,1);
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'test.manager',password})});assert.equal(login.status,200);assert.equal((await login.json()).user.role,'employee');
 const cookie=login.headers.getSetCookie().find(c=>c.startsWith('ruspet_session='))!.split(';')[0];
 const bootstrap=await(await fetch(base+'/api/bootstrap',{headers:{Cookie:cookie}})).json();assert.equal(bootstrap.user.id,'choice');assert(bootstrap.tasks.every((t:any)=>t.assignee_id==='choice'||t.creator_id==='choice'));
 assert.equal((await fetch(base+'/api/system/access',{headers:{Cookie:cookie}})).status,403);
 await access.testManagerAccess({apply:true,allowWorkingData:true,password:'a-different-password-that-must-not-reset'});
 const encoded=(await db.pool.query("SELECT password_hash FROM login_accounts WHERE username='test.manager'")).rows[0].password_hash;assert(await(await import('../server/passwords.js')).verifyPassword(password,encoded));
 assert.deepEqual((await db.pool.query('SELECT * FROM tasks ORDER BY id')).rows,before);
 const audit=JSON.stringify((await db.pool.query("SELECT data FROM task_events WHERE kind='test_manager_access_created'")).rows);assert(!audit.includes(password));assert(!audit.includes(encoded));
 await db.pool.query("INSERT INTO bitrix_pilot_members VALUES('choice','manager')");await assert.rejects(()=>access.testManagerAccess(),/теперь участвует/);await db.pool.query("DELETE FROM bitrix_pilot_members WHERE user_id='choice'");
});

test('preview setup refuses the working target before migration or seeding',async()=>{
 const count=(await db.pool.query('SELECT count(*)::int n FROM tasks')).rows[0].n;
 const child=spawnSync(process.execPath,[...tsxArgs,'scripts/setup-manager-preview.ts'],{cwd:process.cwd(),env:{...process.env,DOTENV_CONFIG_PATH:'/tmp/nonexistent-manager-preview.env'},input:password,encoding:'utf8'});
 assert.notEqual(child.status,0);assert(!child.stdout?.includes(password));assert(!child.stderr?.includes(password));assert.equal((await db.pool.query('SELECT count(*)::int n FROM tasks')).rows[0].n,count);
});

test('isolated preview keeps admin view read-only and allows the test manager to work in scope',async()=>{
 const rolePassword=randomBytes(18).toString('base64url');
 await master.query(`CREATE ROLE ruspetpreview LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
 previewRoleCreated=true;
 await master.query('CREATE DATABASE ruspet_manager_preview OWNER ruspetpreview');previewDatabaseCreated=true;
 const url=new URL(rootUrl);url.pathname='/ruspet_manager_preview';url.username='ruspetpreview';url.password=rolePassword;previewUrl=url.toString();
 const env={...process.env,DATABASE_URL:previewUrl,DOTENV_CONFIG_PATH:'/tmp/nonexistent-manager-preview.env',DEMO_AUTH:'false',TELEGRAM_WORKER_DISABLED:'true',BITRIX_WRITE_ENABLED:'false',TASK_PROVIDER:'mock'};
 const setup=spawnSync(process.execPath,[...tsxArgs,'scripts/setup-manager-preview.ts'],{env,input:password+'\n'+adminPassword,encoding:'utf8'});assert.equal(setup.status,0,setup.stderr);assert(!setup.stdout.includes(password));assert(!setup.stdout.includes(adminPassword));
 const observer=new pg.Client({connectionString:previewUrl});await observer.connect();
 try{
 assert.equal((await observer.query('SELECT count(*)::int n FROM tasks')).rows[0].n,24);assert.equal((await observer.query('SELECT enabled FROM telegram_settings')).rows[0].enabled,false);
 previewProcess=spawn(process.execPath,[...tsxArgs,'scripts/manager-preview-server.ts'],{env,stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('preview startup timeout')),10000);
  previewProcess!.stdout!.on('data',chunk=>{if(String(chunk).includes('Manager preview listening on loopback port 4320')){clearTimeout(timer);resolve();}});
  previewProcess!.once('exit',()=>{clearTimeout(timer);reject(Error('preview exited before listening'));});
 });
 const login=await fetch('http://127.0.0.1:4320/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'test.manager',password})});assert.equal(login.status,200);const user=(await login.json()).user;assert.equal(user.role,'employee');assert(!/Шевченко|Чекальский/i.test(user.name));
 const cookie=login.headers.getSetCookie().find(c=>c.startsWith('ruspet_session='))!.split(';')[0];
 const urlBase='http://127.0.0.1:4320/api';
 const adminLogin=await fetch(urlBase+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'preview.admin',password:adminPassword})});
 assert.equal(adminLogin.status,200);assert.equal((await adminLogin.json()).user.role,'admin');
 const adminCookie=adminLogin.headers.getSetCookie().find(c=>c.startsWith('ruspet_session='))!.split(';')[0];
 const asEmployee={'Cookie':adminCookie,'X-Ruspet-View-As':encodeURIComponent(user.id)};
 const own=await(await fetch(urlBase+'/bootstrap',{headers:{Cookie:cookie}})).json();
 const as=await fetch(urlBase+'/bootstrap',{headers:asEmployee});assert.equal(as.status,200);
 const preview=await as.json();assert.equal(preview.user.id,user.id);assert.equal(preview.managerPreview,true);
 assert.deepEqual(preview.tasks,own.tasks);assert(preview.tasks.length>0&&preview.tasks.length<24);
 const other=(await observer.query("SELECT id,assignee_id FROM tasks WHERE assignee_id<>$1 LIMIT 1",[user.id])).rows[0];
 assert.equal((await fetch(urlBase+'/tasks/'+own.tasks[0].id,{headers:asEmployee})).status,200);
 assert.equal((await fetch(urlBase+'/tasks/'+other.id,{headers:asEmployee})).status,404);
 assert.equal((await fetch(urlBase+'/bootstrap',{headers:{...asEmployee,'X-Ruspet-View-As':other.assignee_id}})).status,200);
 assert.equal((await fetch(urlBase+'/bootstrap',{headers:{...asEmployee,'X-Ruspet-View-As':'nonexistent'}})).status,404);
 assert.equal((await fetch(urlBase+'/bootstrap',{headers:{...asEmployee,Cookie:cookie}})).status,403);
 assert.equal((await fetch(urlBase+'/bootstrap',{headers:{'X-Ruspet-View-As':user.id}})).status,401);
 assert.equal((await fetch(urlBase+'/system/access',{headers:asEmployee})).status,403);
 assert.equal((await fetch(urlBase+'/auth/logout',{method:'POST',headers:asEmployee})).status,403);
 assert.equal((await fetch(urlBase+'/tasks/'+own.tasks[0].id+'/comments',{method:'POST',headers:{...asEmployee,'Content-Type':'application/json'},body:JSON.stringify({body:'Запись из режима просмотра'})})).status,403);
 assert.equal((await(await fetch(urlBase+'/auth/me',{headers:{Cookie:adminCookie}})).json()).role,'admin');
 assert.equal((await fetch(urlBase+'/system/access',{headers:{Cookie:adminCookie}})).status,200);
 const screen=await fetch('http://127.0.0.1:4320/api/bot/screen',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(screen.status,200);assert((await screen.json()).text.includes('Мои задачи'));
 const writeHeaders={Cookie:cookie,'Content-Type':'application/json'};
 const comment=JSON.stringify({body:'Учебный комментарий менеджера'});
 assert.equal((await fetch(urlBase+'/tasks/'+other.id+'/comments',{method:'POST',headers:writeHeaders,body:comment})).status,404);
 assert.equal((await fetch(urlBase+'/tasks/'+own.tasks[0].id+'/comments',{method:'POST',headers:writeHeaders,body:comment})).status,200);
 const detail=await(await fetch(urlBase+'/tasks/'+own.tasks[0].id,{headers:asEmployee})).json();
 assert(detail.comments.some((item:{author_id:string;body:string})=>item.author_id===user.id&&item.body==='Учебный комментарий менеджера'));
 assert.deepEqual(await(await fetch('http://127.0.0.1:4320/api/auth/qr/config')).json(),{available:false});
 assert.equal((await observer.query("SELECT count(*)::int n FROM users WHERE role IN ('admin','director','sales_head','branch_manager')")).rows[0].n,5);
 }finally{await observer.end();}
});
