import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Server} from 'node:http';
import pg from 'pg';
import type {User} from '../shared/types.js';

const name='ruspet_time_test_'+randomBytes(5).toString('hex');
let admin:pg.Client,db:typeof import('../server/db.js'),server:Server,base:string;
let owner:User,staff:User,ownerCookie:string,staffCookie:string;
let time:typeof import('../server/owner-time.js');

async function http(path:string,cookie='',method='GET',body?:unknown,headers:Record<string,string>={}){
 return fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',...headers},
  body:body===undefined?undefined:JSON.stringify(body)});
}

before(async()=>{
 const connection=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 admin=new pg.Client({connectionString:connection});await admin.connect();await admin.query(`CREATE DATABASE ${name}`);
 const url=new URL(connection);url.pathname='/'+name;
 process.env.DATABASE_URL=url.toString();
 process.env.DEMO_AUTH='true';
 db=await import('../server/db.js');
 await (await import('../scripts/migrate.js')).migrate();
 await db.pool.query(`INSERT INTO users(id,name,role,branch_id,position,root_access)
  VALUES ('owner-root','Владелец','admin','','Владелец',true),('staff-admin','Администратор','admin','','Администратор',false)`);
 const people=(await db.pool.query<User>('SELECT * FROM users')).rows;
 owner=people.find(user=>user.root_access)!;staff=people.find(user=>!user.root_access)!;
 const password=randomBytes(24).toString('base64url');
 const hash=await (await import('../server/passwords.js')).hashPassword(password);
 await db.pool.query("INSERT INTO login_accounts(username,user_id,password_hash) VALUES('root',$1,$3),('staff.admin',$2,$3)",[owner.id,staff.id,hash]);
 await db.pool.query("UPDATE telegram_settings SET enabled=true,delivery=false WHERE id=1");
 await db.pool.query("INSERT INTO telegram_runtime(id,username,last_poll_at) VALUES(1,'fixture_owner_bot',now()) ON CONFLICT(id) DO UPDATE SET username=excluded.username");
 await db.pool.query("INSERT INTO telegram_binding(chat_id,user_id) VALUES('84201',$1),('84202',$2)",[owner.id,staff.id]);
 time=await import('../server/owner-time.js');
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');
 await new Promise<void>(done=>server.once('listening',done));
 base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const login=async(username:string)=>{
  const response=await http('/api/auth/login','','POST',{username,password});
  assert.equal(response.status,200);
  return response.headers.getSetCookie().find(cookie=>cookie.startsWith('ruspet_session='))!.split(';')[0];
 };
 ownerCookie=await login('root');staffCookie=await login('staff.admin');
});
after(async()=>{
 if(server)await new Promise<void>(done=>server.close(()=>done()));
 await db?.pool.end();
 if(admin){await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();}
});

test('planner and owner credentials are private even from a regular admin',async()=>{
 assert.equal((await http('/time')).status,401);
 assert.equal((await http('/time',staffCookie)).status,403);
 assert.equal((await http('/time',ownerCookie)).status,200);
 assert.equal((await http('/api/time/month?month=2024-02',staffCookie)).status,403);
 assert.equal((await http('/api/time/report.csv?month=2024-02',staffCookie)).status,403);
 assert.equal((await http('/api/demo/login','','POST',{userId:owner.id})).status,403);
 assert.equal((await http('/api/bootstrap',staffCookie,'GET',undefined,{'X-Ruspet-View-As':owner.id})).status,403);
 assert.equal((await http('/api/telegram/pairing',staffCookie,'POST',{userId:owner.id})).status,403);
 assert.equal((await http('/api/system/access/'+owner.id+'/account',staffCookie,'POST',{username:'someone'})).status,403);
 const login=await import('../server/telegram-login.js');
 await assert.rejects(()=>login.setTelegramBinding(staff,owner.id,null),/владельца/);
 const directory=await (await import('../server/system-status.js')).accessDirectory(staff);
 assert.ok(!directory.some(row=>row.id===owner.id));
});

test('backfill hours, retain checklist, protect concurrent work and export a whole leap month',async()=>{
 const before=await (await http('/api/time/month?month=2026-11',ownerCookie)).json();
 assert.equal(before.days[12].plan.length,10);
 assert.equal(before.days[12].plan.flatMap((block:{items:unknown[]})=>block.items).length,18);
 const plan=[{title:'Работа',start:'09:30',end:'10:00',items:[{id:'a',text:'Проверка',done:true}]}];
 assert.equal((await http('/api/time/days/2024-02-29/plan',ownerCookie,'PUT',plan)).status,200);
 const first=await http('/api/time/days/2024-02-29/work',ownerCookie,'PUT',{minutes:450,note:'=2+2',loggedAt:null});
 assert.equal(first.status,200);
 assert.equal((await first.json()).minutes,450);
 const stale=await http('/api/time/days/2024-02-29/work',ownerCookie,'PUT',{minutes:0,note:'',loggedAt:null});
 assert.equal(stale.status,409);
 const zero=await http('/api/time/days/2024-02-28/work',ownerCookie,'PUT',{minutes:0,note:'Выходной',loggedAt:null});
 assert.equal(zero.status,200);
 const {days}=await (await http('/api/time/month?month=2024-02',ownerCookie)).json();
 assert.equal(days.length,29);
 assert.equal(days[0].minutes,null);
 assert.equal(days[27].minutes,0);
 assert.deepEqual(days[28].plan,plan);
 const csv=await (await http('/api/time/report.csv?month=2024-02',ownerCookie)).text();
 assert.match(csv,/"2024-02-29";"7:30";"'=2\+2"/);
 assert.match(csv,/"2024-02-28";"0:00";"Выходной"/);
 assert.match(csv,/"Итого";"7:30"/);
});

test('21:00 Moscow claims one owner prompt, and a late reply goes to the original day once',async()=>{
 const sent:{chat:string;text:string}[]=[];
 const send=async(chat:string,text:string)=>{sent.push({chat,text});return 4321;};
 await time.sendOwnerTimePrompt(new Date('2024-03-01T17:59:59Z'),send);
 assert.equal(sent.length,0);
 const at21=new Date('2024-03-01T18:00:00Z');
 await Promise.all([time.sendOwnerTimePrompt(at21,send),time.sendOwnerTimePrompt(at21,send)]);
 assert.equal(sent.length,1);
 assert.equal(sent[0].chat,'84201');
 assert.match(sent[0].text,/01\.03\.2024/);
 const answer={message_id:4322,date:Date.parse('2024-03-02T06:00:00Z')/1000,text:'7,5\nОтчёт — готов',
  chat:{id:84201,type:'private'},from:{id:84201},reply_to_message:{message_id:4321,from:{is_bot:true}}};
 assert.equal(await time.ownerTimeReply(staff,answer),null);
 assert.equal(await time.ownerTimeReply(owner,{...answer,from:{id:84202}}),null);
 assert.match((await time.ownerTimeReply(owner,answer))!,/01\.03\.2024/);
 const {days}=await (await http('/api/time/month?month=2024-03',ownerCookie)).json();
 assert.equal(days[0].minutes,450);
 assert.equal(days[0].note,'Отчёт — готов');
 assert.equal(days[1].minutes,null);
 assert.equal((await http('/api/time/days/2024-03-01/work',ownerCookie,'PUT',{minutes:480,note:'Правка',loggedAt:days[0].loggedAt})).status,200);
 assert.match((await time.ownerTimeReply(owner,answer))!,/уже обработан/);
 const updated=await (await http('/api/time/month?month=2024-03',ownerCookie)).json();
 assert.equal(updated.days[0].minutes,480);
 assert.equal((await http('/api/time/reminders',ownerCookie,'PUT',{enabled:false})).status,200);
 await time.sendOwnerTimePrompt(new Date('2024-03-02T18:00:00Z'),send);
 assert.equal(sent.length,1);
});
