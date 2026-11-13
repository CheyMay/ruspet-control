import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import pg from 'pg';
import type {Server} from 'node:http';
import type {User} from '../shared/types.js';
let db:typeof import('../server/db.js'),staff:typeof import('../server/staff-import.js'),onboard:typeof import('../server/telegram-onboarding.js'),pilot:typeof import('../server/telegram-pilot.js'),qr:typeof import('../server/telegram-login.js'),master:pg.Client,server:Server,base:string,admin:User,anna:User,file:Buffer,cookie:string;
const database='ruspet_staff_test_'+randomBytes(5).toString('hex'),realFetch=globalThis.fetch,sent:any[]=[],password=randomBytes(18).toString('base64url');
const header=['Отдел','Фамилия, имя','Почта корпоративная','Почта только для гугл таблиц','Номер телефона','Bitrix24 ID'];
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function workbook(sheets:{name:string;rows:string[][]}[]){
 const files:Record<string,Uint8Array>={
  '[Content_Types].xml':strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')+'</Types>'),
  '_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
  'xl/workbook.xml':strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+sheets.map((s,i)=>`<sheet name="${xml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')+'</sheets></workbook>'),
  'xl/_rels/workbook.xml.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')+'</Relationships>')
 };
 sheets.forEach((s,i)=>files[`xl/worksheets/sheet${i+1}.xml`]=strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+s.rows.map((row,n)=>`<row r="${n+1}">`+row.map((v,c)=>`<c r="${String.fromCharCode(65+c)}${n+1}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`).join('')+'</row>').join('')+'</sheetData></worksheet>'));
 return Buffer.from(zipSync(files));
}
const msg=(id:number,text?:string,contact?:any)=>({chat:{id,type:'private'},from:{id},text,contact});
async function identify(id:number,name:string){await onboard.onboardingMessage(msg(id,'/start'));return onboard.onboardingMessage(msg(id,name))}
async function contact(id:number,phone:string){return onboard.onboardingMessage(msg(id,undefined,{user_id:id,phone_number:phone}))}
async function http(path:string,method='GET',auth=cookie,body?:unknown){return realFetch(base+'/api'+path,{method,headers:{Cookie:auth,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined})}
before(async()=>{
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;master=new pg.Client({connectionString:current});await master.connect();await master.query(`CREATE DATABASE ${database}`);const url=new URL(current);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();process.env.DEMO_AUTH='false';process.env.PUBLIC_ORIGIN='https://staff.example';process.env.TELEGRAM_BOT_TOKEN='FICTIONAL';process.env.TELEGRAM_PROXY_URL='https://fixture-staff-bridge.example';process.env.TELEGRAM_PROXY_SECRET='fixture-secret';
 db=await import('../server/db.js');await(await import('../scripts/migrate.js')).migrate();const seed=await import('../scripts/seed.js');await seed.seed();admin=seed.demoUsers.find(u=>u.role==='admin')!;anna=seed.demoUsers.find(u=>u.id==='anna')!;
 await db.pool.query("INSERT INTO users(id,name,role,branch_id,position) VALUES('disabled-staff','Закрытов Олег','employee','Тест','Тест')");
 for(const user of [admin,anna,{id:'disabled-staff'}])await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash,enabled) VALUES($1,$1,$2,$3)',[user.id,await(await import('../server/passwords.js')).hashPassword(password),user.id!=='disabled-staff']);
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=false WHERE id=1');await db.pool.query("INSERT INTO telegram_runtime(id,username,last_poll_at) VALUES(1,'fixture_staff_bot',now()) ON CONFLICT(id) DO UPDATE SET username=excluded.username,last_poll_at=now()");
 staff=await import('../server/staff-import.js');onboard=await import('../server/telegram-onboarding.js');pilot=await import('../server/telegram-pilot.js');qr=await import('../server/telegram-login.js');
 file=workbook([{name:'Общий список',rows:[header,['Тест','Не Импортировать','','','70000000999','']]},{name:'РП',rows:[header,['Продажи',anna.name,'TEST@example.invalid','','+7 (000) 000-00-01','1001'],['Директор','Петров Иван','','','70000000002','1002'],['Отдел','Сидоров Антон','','','70000000003','1003'],['Отдел','Кузнецов Виктор','','','70000000003','1004'],['Отдел','Тёзкин Павел','','','70000000004','1005'],['Отдел','Закрытов Олег','','','70000000006','1006'],['Отдел','Безномеров Игорь','','','','1007']]},{name:'АП',rows:[header,['Отдел','Тёзкин Павел','','','70000000005','1008']]}]);
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const login=await http('/auth/login','POST','',{username:admin.id,password});cookie=login.headers.getSetCookie().find(v=>v.startsWith('ruspet_session='))!.split(';')[0];
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://fixture-staff-bridge.example');const envelope=JSON.parse(String(init!.body));assert(envelope.body);sent.push(envelope);return new Response(JSON.stringify({ok:true,result:{message_id:42}}))};
});
after(async()=>{globalThis.fetch=realFetch;if(server)await new Promise<void>(r=>server.close(()=>r()));await db?.pool.end();if(master){await master.query(`DROP DATABASE IF EXISTS ${database}`);await master.end()}});

test('XLSX import previews before writes, ignores the duplicated combined sheet, preserves existing roles and never logs contacts',async()=>{
 assert(!staff.namesMatch('Иван Иван','Петров Иван'));assert(staff.namesMatch('Тезкин Павел','Павел Тёзкин'));
 const upload=(auth:string,digest?:string)=>realFetch(base+'/api/system/staff/import'+(digest?'?confirmed='+digest:''),{method:'POST',headers:{Cookie:auth,'Content-Type':'application/octet-stream'},body:new Uint8Array(file)});
 assert.equal((await upload('')).status,401);
 const login=await http('/auth/login','POST','',{username:anna.id,password}),employee=login.headers.getSetCookie().find(v=>v.startsWith('ruspet_session='))!.split(';')[0];assert.equal((await upload(employee)).status,403);
 const preview=await upload(cookie);assert.equal(preview.status,200);const plan=await preview.json();assert.equal(plan.count,8);assert(!JSON.stringify(plan).includes('70000000001'));assert(!JSON.stringify(plan).includes('TEST@'));
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM staff_directory')).rows[0].n,0);
 assert.equal((await upload(cookie,'f'.repeat(64))).status,409);assert.equal((await upload(cookie,plan.digest)).status,200);assert.equal((await upload(cookie,plan.digest)).status,200);
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM staff_directory')).rows[0].n,8);
 assert.equal((await db.pool.query('SELECT user_id FROM staff_directory WHERE name=$1',[anna.name])).rows[0].user_id,anna.id);
 assert.equal((await db.pool.query('SELECT role FROM users WHERE id=$1',[anna.id])).rows[0].role,anna.role);
 const audit=JSON.stringify((await db.pool.query("SELECT data FROM task_events WHERE kind='staff_import'")).rows);assert(!audit.includes('70000000001'));assert(!audit.includes('example.invalid'));
 const malformed=Buffer.from('not an xlsx');await assert.rejects(()=>staff.importStaff(admin,malformed),/XLSX/);
 const bomb=Buffer.from(file),central=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bomb.writeUInt32LE(32*1024*1024,central+24);await assert.rejects(()=>staff.parseStaffFile(bomb),/распакованный/);
});

test('/start asks names, requests the own contact via Telegram and connects the existing account; QR uses that identity',async()=>{
 await pilot.handlePilotUpdate({message:msg(82001,'/start')});assert(sent.at(-1).body.text.includes('имя и фамилию'));
 await pilot.handlePilotUpdate({message:msg(82001,anna.name.split(' ').reverse().join(' '))});assert.equal(sent.at(-1).body.reply_markup.keyboard[0][0].request_contact,true);
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM telegram_binding WHERE chat_id='82001'")).rows[0].n,0);
 await pilot.handlePilotUpdate({message:msg(82001,undefined,{user_id:82001,phone_number:'80000000001'})});assert.equal(sent.at(-1).body.reply_markup.remove_keyboard,true);
 assert.equal((await db.pool.query("SELECT user_id FROM telegram_binding WHERE chat_id='82001'")).rows[0].user_id,anna.id);
 const start=await http('/auth/qr','POST','',{}),r=await start.json(),browser=start.headers.getSetCookie()[0].split(';')[0],approval=new URL(r.url).searchParams.get('start')!.slice(6);
 await qr.telegramLoginScreen(approval,'82001');await qr.telegramLoginScreen(approval,'82001','approve');
 const consume=await http('/auth/qr/'+r.id+'/consume','POST',browser,{});assert.equal(consume.status,200);assert.equal((await consume.json()).user.id,anna.id);
});

test('phone verification creates a Telegram-only employee account once, never infers a privileged role from department, and admin can add a password',async()=>{
 await identify(82002,'Иван Петров');const results=await Promise.all([contact(82002,'70000000002'),contact(82002,'70000000002')]);assert(results.some(r=>r?.text.includes('Вы подключены')));
 const user=(await db.pool.query("SELECT u.* FROM users u JOIN telegram_binding b ON b.user_id=u.id WHERE b.chat_id='82002'")).rows[0];assert.equal(user.role,'employee');
 const accounts=(await db.pool.query('SELECT * FROM login_accounts WHERE user_id=$1',[user.id])).rows;assert.equal(accounts.length,1);assert.equal(accounts[0].password_login,false);assert.equal(accounts[0].password_hash,'');
 assert.equal((await http('/auth/login','POST','',{username:accounts[0].username,password:'anything'})).status,401);
 const create=await http('/system/access/'+user.id+'/account','POST',cookie,{username:'fixture.new.staff'});assert.equal(create.status,201);const credentials=await create.json();assert.equal((await http('/auth/login','POST','',{username:credentials.username,password:credentials.password})).status,200);
 assert.equal((await db.pool.query('SELECT role FROM users WHERE id=$1',[user.id])).rows[0].role,'employee');
});

test('another user contact, forwarded contact, manual phone text, group or mismatched sender cannot verify identity',async()=>{
 await identify(82003,'Сидоров Антон');
 for(const message of [msg(82003,'70000000003'),msg(82003,undefined,{user_id:82099,phone_number:'70000000003'}),{...msg(82003,undefined,{user_id:82003,phone_number:'70000000003'}),forward_origin:{type:'user'}}]){
  assert.equal((await onboard.onboardingMessage(message))?.replyKeyboard,'contact');
 }
 assert.equal(await onboard.onboardingMessage({...msg(82003,'/start'),chat:{id:82003,type:'group'}}),null);
 assert.equal(await onboard.onboardingMessage({...msg(82003,'/start'),from:{id:82099}}),null);
 assert.equal((await db.pool.query("SELECT own_contact_verified FROM telegram_registrations WHERE chat_id='82003' AND state='contact'")).rows[0].own_contact_verified,false);
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM telegram_binding WHERE chat_id='82003'")).rows[0].n,0);
});

test('shared phones, duplicate names, mismatched names and disabled accounts go to admin review instead of granting access',async()=>{
 await contact(82003,'70000000003');assert.equal((await db.pool.query("SELECT state FROM telegram_registrations WHERE chat_id='82003'")).rows[0].state,'review');
 for(const [id,name,phone]of [[82004,'Павел Тезкин','70000000004'],[82005,'Чужое Имя','70000000002'],[82006,'Олег Закрытов','70000000006']] as const){await identify(id,name);await contact(id,phone);assert.equal((await db.pool.query('SELECT state FROM telegram_registrations WHERE chat_id=$1',[String(id)])).rows[0].state,'review');assert.equal((await db.pool.query('SELECT count(*)::int n FROM telegram_binding WHERE chat_id=$1',[String(id)])).rows[0].n,0);}
 const requests=await onboard.listRegistrations(admin);const disabled=requests.requests.find(r=>r.chat_id==='82006')!;
 await assert.rejects(()=>onboard.reviewRegistration(admin,disabled.id,{action:'approve',staffId:disabled.staff_id}),/отключён/);
 const employee=anna;await assert.rejects(()=>onboard.listRegistrations(employee),/администратор/);
 const review=requests.requests.find(r=>r.chat_id==='82003')!,selected=requests.staff.find(s=>s.name==='Сидоров Антон')!;
 const action=await http('/system/registrations/'+review.id,'POST',cookie,{action:'approve',staffId:selected.id,confirmed:true});assert.equal(action.status,200);
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM telegram_binding WHERE chat_id='82003'")).rows[0].n,1);
 assert.equal((await http('/system/registrations/'+review.id,'POST',cookie,{action:'approve',staffId:selected.id,confirmed:true})).status,409);
});

test('no-phone employees can request review; missing confirmation, rejection, cancellation, expiry and attempt limits are enforced',async()=>{
 await identify(82007,'Игорь Безномеров');await onboard.onboardingMessage(msg(82007,'/manual'));
 const r=(await onboard.listRegistrations(admin)).requests.find(r=>r.chat_id==='82007')!;
 await onboard.staffReviewNotices();
 const notices=await (await http('/notifications','GET',cookie)).json();
 assert.equal(notices.filter((notice:any)=>notice.staff_review&&notice.body.includes('Игорь Безномеров')).length,1);
 assert.equal((await http('/system/registrations/'+r.id,'POST',cookie,{action:'reject'})).status,400);
 assert.equal((await http('/system/registrations/'+r.id,'POST',cookie,{action:'reject',confirmed:true})).status,200);
 assert((await onboard.onboardingMessage(msg(82007,'/start')))?.text.includes('имя и фамилию'));
 await onboard.onboardingMessage(msg(82007,'/cancel'));assert.equal((await db.pool.query("SELECT count(*)::int n FROM telegram_registrations WHERE chat_id='82007' AND state IN ('name','contact','review')")).rows[0].n,0);
 for(let i=0;i<3;i++){await onboard.onboardingMessage(msg(82007,'/start'));await onboard.onboardingMessage(msg(82007,'/cancel'))}
 assert((await onboard.onboardingMessage(msg(82007,'/start')))?.text.includes('Слишком много'));
 await identify(82008,'Игорь Безномеров');await onboard.onboardingMessage(msg(82008,'/manual'));const expired=(await onboard.listRegistrations(admin)).requests.find(r=>r.chat_id==='82008')!;await db.pool.query("UPDATE telegram_registrations SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);await assert.rejects(()=>onboard.reviewRegistration(admin,expired.id,{action:'reject'}),/устарела/);
});

test('administrator revocation cannot be bypassed by registering again with the same verified phone',async()=>{
 await qr.setTelegramBinding(admin,anna.id,null);await identify(82001,anna.name);await contact(82001,'70000000001');
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM telegram_binding WHERE chat_id='82001'")).rows[0].n,0);
 assert.equal((await db.pool.query("SELECT state FROM telegram_registrations WHERE chat_id='82001' AND state='review'")).rows[0].state,'review');
});
