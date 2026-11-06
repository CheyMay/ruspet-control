import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import type {Server} from 'node:http';
import type {User} from '../shared/types.js';
let adminConnection:pg.Client,db:typeof import('../server/db.js'),qr:typeof import('../server/telegram-login.js'),pilot:typeof import('../server/telegram-pilot.js'),server:Server,base:string,admin:User;
const database='ruspet_qr_test_'+randomBytes(5).toString('hex'),password=randomBytes(18).toString('base64url');
const realFetch=globalThis.fetch,sent:any[]=[];
let adminCookie:string;
async function request(path:string,method='GET',cookie='',body?:unknown){return realFetch(base+'/api'+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined})}
async function create(cookie=''){
 const response=await request('/auth/qr','POST',cookie,{});assert.equal(response.status,201);const data=await response.json();
 return {...data,cookie:response.headers.getSetCookie()[0].split(';')[0],approval:new URL(data.url).searchParams.get('start')!.slice(6)};
}
async function approve(r:any,id='81001') {await qr.telegramLoginScreen(r.approval,id);await qr.telegramLoginScreen(r.approval,id,'approve');}
async function consume(r:any,cookie=r.cookie){return request('/auth/qr/'+r.id+'/consume','POST',cookie,{})}
async function state(r:any){return (await (await request('/auth/qr/'+r.id,'GET',r.cookie)).json()).state}
before(async()=>{
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 adminConnection=new pg.Client({connectionString:current});await adminConnection.connect();await adminConnection.query(`CREATE DATABASE ${database}`);
 const url=new URL(current);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();process.env.PUBLIC_ORIGIN='https://qr.example';process.env.DEMO_AUTH='false';process.env.TELEGRAM_BOT_TOKEN='FICTIONAL-NOT-A-REAL-TOKEN';
 db=await import('../server/db.js');await(await import('../scripts/migrate.js')).migrate();
 const fixtures=await import('../scripts/seed.js');await fixtures.seed();admin=fixtures.demoUsers.find(u=>u.role==='admin')!;
 const hash=await(await import('../server/passwords.js')).hashPassword(password);
 for(const id of [admin.id,'anna','director'])await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$1,$2)',[id,hash]);
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=false WHERE id=1');
 await db.pool.query("INSERT INTO telegram_runtime(id,username,last_poll_at,heartbeat_at) VALUES(1,'fixture_qr_bot',now(),now()) ON CONFLICT(id) DO UPDATE SET username=excluded.username,last_poll_at=now(),error=NULL");
 qr=await import('../server/telegram-login.js');pilot=await import('../server/telegram-pilot.js');
 await qr.setTelegramBinding(admin,'anna','81001');await qr.setTelegramBinding(admin,'director','81002');
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const login=await request('/auth/login','POST','',{username:admin.id,password});assert.equal(login.status,200);adminCookie=login.headers.getSetCookie().find(c=>c.startsWith('ruspet_session='))!.split(';')[0];
 globalThis.fetch=async(url,init)=>{
  assert(String(url).startsWith('https://api.telegram.org/botFICTIONAL-NOT-A-REAL-TOKEN/'),'No real external requests allowed');
  const body=JSON.parse(String(init!.body));sent.push({url:String(url),...body});return new Response(JSON.stringify({ok:true,result:{message_id:100}}));
 };
});
after(async()=>{globalThis.fetch=realFetch;if(server)await new Promise<void>(r=>server.close(()=>r()));await db?.pool.end();if(adminConnection){await adminConnection.query(`DROP DATABASE IF EXISTS ${database}`);await adminConnection.end();}});

test('QR opens exact private bot flow; only explicit confirmation gives the requesting browser a standard session with existing rights',async()=>{
 const r=await create();assert.match(r.url,/^https:\/\/t.me\/fixture_qr_bot\?start=login_[A-Za-z0-9_-]{32}$/);assert.match(r.image,/^data:image\/svg\+xml;base64,/);
 assert.match(r.code,/^\d{6}$/);assert.equal((await consume(r)).status,409);assert.equal((await consume(r,'')).status,403);
 assert.equal((await request('/auth/qr/'+r.id)).status,403);
 const other=await create();assert.equal((await consume(r,other.cookie)).status,404);
 await pilot.handlePilotUpdate({message:{message_id:1,chat:{id:81001,type:'private'},from:{id:81001},text:'/start login_'+r.approval}});
 const screen=sent.at(-1);assert(screen.text.includes(r.code));assert(screen.text.includes('https://qr.example'));assert.equal(screen.reply_markup.inline_keyboard[0][0].callback_data,'ql_a_'+r.approval);
 assert.equal(await state(r),'pending');assert.equal((await consume(r)).status,409);
 await pilot.handlePilotUpdate({callback_query:{id:'fixture-callback',from:{id:81001},data:'ql_a_'+r.approval,message:{message_id:100,chat:{id:81001,type:'private'}}}});
 assert.equal(await state(r),'approved');
 const responses=await Promise.all([consume(r),consume(r)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 const success=responses.find(r=>r.status===200)!;assert.equal((await success.json()).user.id,'anna');
 const cookie=success.headers.getSetCookie()[0];assert(cookie.includes('HttpOnly'));assert(cookie.includes('Secure'));assert(cookie.includes('SameSite=Strict'));assert(cookie.includes('Path=/'));
 const session=cookie.split(';')[0];const me=await request('/auth/me','GET',session);assert.equal((await me.json()).id,'anna');assert.equal((await request('/system/access','GET',session)).status,403);
 assert.equal(await state(r),'consumed');assert.equal((await consume(r)).status,409);
 await qr.telegramLoginScreen(r.approval,'81001','approve');assert.equal((await consume(r)).status,409);
 const audit=JSON.stringify((await db.pool.query("SELECT data FROM task_events WHERE kind='telegram_qr_login'")).rows);assert(!audit.includes(r.approval));assert(!audit.includes(session.split('=')[1]));
 const stored=JSON.stringify((await db.pool.query('SELECT * FROM telegram_login_requests WHERE id=$1',[r.id])).rows);assert(!stored.includes(r.approval));assert(!stored.includes(r.cookie.split('=')[1]));
 const publicState=await(await request('/auth/qr/'+r.id,'GET',r.cookie)).text();assert(!publicState.includes('anna'));assert(!publicState.includes(r.approval));
});

test('unknown, group, missing or mismatched Telegram senders cannot authorize; account is fixed when scanned',async()=>{
 const r=await create();const count=sent.length;
 for(const message of [{chat:{id:81001,type:'group'},from:{id:81001}},{chat:{id:81001,type:'private'}},{chat:{id:81001,type:'private'},from:{id:81002}},{chat:{id:81001,type:'private'},from:{id:81001,is_bot:true}}])await pilot.handlePilotUpdate({message:{...message,text:'/start login_'+r.approval}});
 assert.equal(sent.length,count);assert.equal(await state(r),'pending');
 await assert.rejects(()=>qr.telegramLoginScreen(r.approval,'89999'),/администратор/);
 await assert.rejects(()=>qr.telegramLoginScreen(r.approval,'81001','approve'),/Сначала/);
 await qr.telegramLoginScreen(r.approval,'81001');
 await assert.rejects(()=>qr.telegramLoginScreen(r.approval,'81002'),/другим сотрудником/);
 await pilot.handlePilotUpdate({callback_query:{id:'mismatch',from:{id:81002},data:'ql_a_'+r.approval,message:{message_id:100,chat:{id:81001,type:'private'}}}});
 assert.equal(await state(r),'pending');
 await qr.telegramLoginScreen(r.approval,'81001','deny');assert.equal(await state(r),'denied');assert.equal((await consume(r)).status,409);
 await qr.telegramLoginScreen(r.approval,'81001','approve');assert.equal(await state(r),'denied');
});

test('expiry, regeneration, explicit cancellation and logout invalidate outstanding approvals',async()=>{
 const r=await create();await approve(r);await db.pool.query("UPDATE telegram_login_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[r.id]);
 assert.equal(await state(r),'expired');assert.equal((await consume(r)).status,409);await assert.rejects(()=>qr.telegramLoginScreen(r.approval,'81001'),/устарел/);
 const previous=await create(),fresh=await create(previous.cookie);assert.equal(previous.cookie,fresh.cookie);assert.equal(await state(previous),'cancelled');
 await approve(fresh);assert.equal((await request('/auth/qr/'+fresh.id,'DELETE',fresh.cookie)).status,200);assert.equal((await consume(fresh)).status,409);
 const logout=await create();await approve(logout);assert.equal((await request('/auth/logout','POST',logout.cookie,{})).status,200);assert.equal(await state(logout),'cancelled');
 const pass=await create();await approve(pass);assert.equal((await request('/auth/login','POST',pass.cookie,{username:admin.id,password})).status,200);assert.equal(await state(pass),'cancelled');
});

test('enabled web account and current binding are rechecked for approval, consumption and every QR session request',async()=>{
 const r=await create();await qr.telegramLoginScreen(r.approval,'81001');
 await db.pool.query("UPDATE login_accounts SET enabled=false WHERE user_id='anna'");await assert.rejects(()=>qr.telegramLoginScreen(r.approval,'81001','approve'),/администратор/);
 await db.pool.query("UPDATE login_accounts SET enabled=true WHERE user_id='anna'");await qr.telegramLoginScreen(r.approval,'81001','approve');
 await db.pool.query("UPDATE login_accounts SET enabled=false WHERE user_id='anna'");assert.equal((await consume(r)).status,403);
 await db.pool.query("UPDATE login_accounts SET enabled=true WHERE user_id='anna'");const success=await consume(r),session=success.headers.getSetCookie()[0].split(';')[0];assert.equal(success.status,200);
 await db.pool.query("UPDATE login_accounts SET enabled=false WHERE user_id='anna'");assert.equal((await request('/auth/me','GET',session)).status,401);assert.equal((await request('/bootstrap','GET',session)).status,401);
 await db.pool.query("UPDATE login_accounts SET enabled=true WHERE user_id='anna'");
 const pending=await create();await approve(pending);
 const revoke=await request('/system/access/anna/telegram','PUT',adminCookie,{telegramId:null,confirmed:true});assert.equal(revoke.status,200);
 assert.equal((await request('/auth/me','GET',session)).status,401);assert.equal(await state(pending),'cancelled');assert.equal((await consume(pending)).status,409);
 await qr.setTelegramBinding(admin,'anna','81001');assert.equal((await consume(pending)).status,409);
 const suspended=await create();await approve(suspended);await db.pool.query('UPDATE telegram_settings SET enabled=false WHERE id=1');assert.equal((await consume(suspended)).status,403);await db.pool.query('UPDATE telegram_settings SET enabled=true WHERE id=1');
});

test('manual binding is admin-only, validates numeric private IDs, rejects reassignment and revokes old invitations',async()=>{
 const employee=(await db.pool.query("SELECT * FROM users WHERE id='anna'")).rows[0] as User;
 await assert.rejects(()=>qr.setTelegramBinding(employee,'anna',null),/администратор/);
 for(const invalid of ['@fixture','-100123','0','4503599627370496','1.2'])await assert.rejects(()=>qr.setTelegramBinding(admin,'anna',invalid),/числовой/);
 await assert.rejects(()=>qr.setTelegramBinding(admin,'missing','81003'),/не найден/);
 await assert.rejects(()=>qr.setTelegramBinding(admin,'anna','81002'),/прежнюю/);
 await assert.rejects(()=>qr.setTelegramBinding(admin,admin.id,'81002'),/другому/);
 assert.equal((await request('/system/access/anna/telegram','PUT',adminCookie,{telegramId:null})).status,400);
 const invite=await(await request('/telegram/pairing','POST',adminCookie,{userId:'anna'})).json();assert(invite.url);
 await qr.setTelegramBinding(admin,'anna',null);assert.equal((await db.pool.query("SELECT count(*)::int n FROM telegram_pairings WHERE user_id='anna'")).rows[0].n,0);
 await qr.setTelegramBinding(admin,'anna','81001');
 const directory=await(await request('/system/access','GET',adminCookie)).json();assert.equal(directory.find((p:any)=>p.id==='anna').telegram_id,'81001');
 const r=await create();await approve(r);const login=await consume(r),cookie=login.headers.getSetCookie()[0].split(';')[0];
 assert.equal((await request('/system/access/director/telegram','PUT',cookie,{telegramId:null,confirmed:true})).status,403);
});

test('bot failures preserve the Telegram method and a safe reason instead of swallowing all 400 responses',async()=>{
 const saved=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: BUTTON_URL_INVALID https://private.example/FICTIONAL-SECRET'}),{status:400});
 try{
  await assert.rejects(()=>pilot.handlePilotUpdate({message:{message_id:23,chat:{id:81001,type:'private'},from:{id:81001},text:'/menu'}}),error=>{
   assert(error instanceof Error);assert.match(error.message,/sendMessage · 400:.*PUBLIC_ORIGIN/);assert(!error.message.includes('FICTIONAL-SECRET'));return true;
  });
 }finally{globalThis.fetch=saved}
});

test('unavailable worker and foreign origins fail closed; password route remains available; challenge creation is rate limited',async()=>{
 await db.pool.query("UPDATE telegram_runtime SET last_poll_at=now()-interval '4 minutes' WHERE id=1");assert.deepEqual(await(await request('/auth/qr/config')).json(),{available:false});assert.equal((await request('/auth/qr','POST','',{})).status,503);
 assert.equal((await request('/auth/login','POST','',{username:admin.id,password})).status,200);
 await db.pool.query('UPDATE telegram_runtime SET last_poll_at=now() WHERE id=1');
 assert.equal((await realFetch(base+'/api/auth/qr',{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'})).status,403);
 const r=await create();const cross=await realFetch(base+'/api/auth/qr/'+r.id+'/consume',{method:'POST',headers:{Origin:'https://foreign.example',Cookie:r.cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(cross.status,403);
 let limited=false;for(let i=0;i<31;i++){const response=await request('/auth/qr','POST',r.cookie,{});if(response.status===429){limited=true;break;}assert.equal(response.status,201)}assert(limited);
});
