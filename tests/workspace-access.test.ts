import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Server} from 'node:http';
import pg from 'pg';
import type {User} from '../shared/types.js';
import {canOpenWorkspacePage} from '../shared/workspace-access.js';

const name='ruspet_workspace_test_'+randomBytes(5).toString('hex'),realFetch=globalThis.fetch;
let db:typeof import('../server/db.js'),master:pg.Client,server:Server,base:string,employee:User;
const cookies=new Map<string,string>();
async function http(path:string,as:string,method='GET',body?:unknown){
 return realFetch(base+'/api'+path,{method,headers:{Cookie:cookies.get(as)||'','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
}
before(async()=>{
 const connection=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 master=new pg.Client({connectionString:connection});await master.connect();await master.query(`CREATE DATABASE ${name}`);
 const url=new URL(connection);url.pathname='/'+name;process.env.DATABASE_URL=url.toString();
 process.env.DEMO_AUTH='false';process.env.BITRIX_WRITE_ENABLED='false';
 db=await import('../server/db.js');await(await import('../scripts/migrate.js')).migrate();
 const fixtures=await import('../scripts/seed.js');await fixtures.seed();
 employee=fixtures.demoUsers.find(user=>user.id==='anna')!;
 await db.pool.query("INSERT INTO users(id,name,role,branch_id,position,root_access) VALUES('owner-root','Владелец','admin','','Владелец',true)");
 const password=randomBytes(24).toString('base64url');
 const hash=await(await import('../server/passwords.js')).hashPassword(password);
 for(const [user,login] of [['owner-root','root'],['admin','admin'],['anna','anna'],['olga','olga']]){
  await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$2,$3)',[login,user,hash]);
 }
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');
 await new Promise<void>(done=>server.once('listening',done));
 base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const username of ['root','admin','anna','olga']){
  const response=await http('/auth/login','','POST',{username,password});
  assert.equal(response.status,200);
  cookies.set(username,response.headers.getSetCookie().find(cookie=>cookie.startsWith('ruspet_session='))!.split(';')[0]);
 }
});
after(async()=>{
 globalThis.fetch=realFetch;
 if(server)await new Promise<void>(done=>server.close(()=>done()));
 await db?.pool.end();
 if(master){await master.query(`DROP DATABASE IF EXISTS ${name}`);await master.end();}
});

test('manager sections, employee profile edits and owner-only integration respect role boundaries',async()=>{
 assert.equal(canOpenWorkspacePage(employee,'tasks'),true);
 for(const page of ['org','people','reports','checks','okb','processes','journal'] as const)assert.equal(canOpenWorkspacePage(employee,page),false);
 const body={name:employee.name,position:'Новая должность',branchId:employee.branch_id,role:'employee',expectedVersion:1};
 assert.equal((await http('/org','anna')).status,403);
 assert.equal((await http('/system/access','anna')).status,403);
 assert.equal((await http('/system/access/anna','anna','PATCH',body)).status,403);
 assert.equal((await http('/system/access/owner-root','admin','PATCH',body)).status,403);
 assert.equal((await http('/system/access/anna','admin','PATCH',body)).status,200);
 assert.equal((await http('/system/access/anna','admin','PATCH',body)).status,409);
 assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM employee_profile_changes')).rows[0].n,1);
 assert.equal((await http('/owner/bitrix/exchange','admin','PUT',{enabled:false,confirmed:true})).status,403);
 await db.pool.query('UPDATE bitrix_live_config SET enabled=true WHERE id=1');
 assert.equal((await http('/owner/bitrix/exchange','root','PUT',{enabled:false,confirmed:true})).status,200);
 assert.equal((await db.pool.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0].enabled,false);
 assert.equal((await http('/owner/bitrix/exchange','root','PUT',{enabled:true,confirmed:true})).status,409);
 assert.equal((await http('/system/access/owner-root/account/root','admin','PUT',{action:'disable',confirmed:true})).status,403);
 assert.equal((await http('/system/access/olga/account/olga','admin','PUT',{action:'disable',confirmed:true})).status,200);
 assert.equal((await http('/auth/me','olga')).status,401);
 const reset=await http('/system/access/anna/account/anna','admin','PUT',{action:'reset',confirmed:true});
 assert.equal(reset.status,200);
 const {password}=await reset.json();
 assert.equal((await http('/auth/me','anna')).status,401);
 const login=await http('/auth/login','','POST',{username:'anna',password});
 assert.equal(login.status,200);
 cookies.set('anna',login.headers.getSetCookie().find(cookie=>cookie.startsWith('ruspet_session='))!.split(';')[0]);
});

test('personal read state is shared with the bot and Telegram sends at most one batch in 30 minutes',async()=>{
 const bot=await import('../server/bot.js'),pilot=await import('../server/telegram-pilot.js');
 await db.pool.query('UPDATE outbox SET read_at=now()');
 const {visibleTasks}=await import('../server/service.js');
 const [task]=await visibleTasks(employee);
 const insert=async(recipient:string,body:string,createdAt:string,taskId:string|null=null)=>{
  const id=randomUUID();
  await db.pool.query('INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,taskId,recipient,body,'fixture:'+id,createdAt]);
  return id;
 };
 const first=await insert('anna','Первое событие по задаче','2026-10-31T05:52:00Z',task.id);
 const other=await insert('olga','Чужое личное уведомление','2026-10-31T05:54:00Z');
 assert.equal((await http('/notifications/read','anna','POST',{ids:[other]}).then(r=>r.json())).count,0);
 const view=await bot.botView(employee,'preview-test',{op:'notices'});
 assert.match(view.text,/Первое событие/);assert.doesNotMatch(view.text,/Чужое/);
 const button=view.buttons.flat().find(item=>item.text==='Отметить показанные прочитанными')!;
 await bot.botClick(employee,'preview-test',button.token);
 const rows=await http('/notifications','anna').then(r=>r.json());
 assert.ok(rows.find((item:{id:string})=>item.id===first).read_at);
 await insert('anna','Второе событие по задаче','2026-10-31T05:53:00Z',task.id);
 await insert('anna','Третье событие по задаче','2026-10-31T05:54:00Z',task.id);
 await db.pool.query("UPDATE telegram_settings SET enabled=true,delivery=true,enabled_at='2026-10-30T00:00:00Z' WHERE id=1");
 await db.pool.query("INSERT INTO telegram_binding(user_id,chat_id,paired_at) VALUES('anna','84001','2026-10-30T00:00:00Z')");
 process.env.TELEGRAM_BOT_TOKEN='FIXTURE_ONLY';delete process.env.TELEGRAM_PROXY_URL;
 const sent:string[]=[];
 globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://api.telegram.org/botFIXTURE_ONLY/sendMessage');
  sent.push(JSON.parse(String(options?.body)).text);
  return new Response(JSON.stringify({ok:true,result:{message_id:100+sent.length}}));
 };
 try{
  await pilot.deliver(new Date('2026-10-31T05:59:00Z'));assert.equal(sent.length,0);
  await pilot.deliver(new Date('2026-10-31T06:29:00Z'));assert.equal(sent.length,1);
  assert.match(sent[0],/Третье событие.*ещё 1/);assert.doesNotMatch(sent[0],/Первое событие/);
  await insert('anna','Следующее событие','2026-10-31T06:29:30Z');
  await pilot.deliver(new Date('2026-10-31T06:30:00Z'));assert.equal(sent.length,1);
  await pilot.deliver(new Date('2026-10-31T06:59:00Z'));assert.equal(sent.length,2);
  await http('/notifications/preferences','anna','PUT',{telegramDigest:false});
  await insert('anna','Только в панели','2026-10-31T07:00:00Z');
  await pilot.deliver(new Date('2026-10-31T07:30:00Z'));assert.equal(sent.length,2);
  assert.match(await http('/notifications?unread=true','anna').then(r=>r.text()),/Только в панели/);
 }finally{globalThis.fetch=realFetch;}
});
