import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Server} from 'node:http';
import pg from 'pg';

const database='ruspet_voice_test_'+randomBytes(5).toString('hex'),realFetch=globalThis.fetch;
let db:typeof import('../server/db.js'),master:pg.Client,server:Server,site:string,cookie:string,own:string,foreign:string;
const wav=Buffer.from('RIFF0000WAVE','ascii');
const request=(path:string,method='GET',body?:unknown)=>realFetch(site+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
const audio=(id:string,bytes:Uint8Array=wav)=>realFetch(site+'/api/bot/voice?channel=mobile',{method:'POST',
 headers:{Cookie:cookie,'Content-Type':'audio/wav','X-Voice-Input-Id':id},body:new Uint8Array(bytes)});
before(async()=>{
 const connection=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 master=new pg.Client({connectionString:connection});await master.connect();await master.query(`CREATE DATABASE ${database}`);
 const url=new URL(connection);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();
 process.env.DEMO_AUTH='true';process.env.WEB_VOICE_ENABLED='true';process.env.WEB_VOICE_USER_IDS='anna';
 process.env.GROQ_API_KEY='FIXTURE_ONLY';delete process.env.GROQ_TUNNEL_PORT;delete process.env.GROQ_HTTPS_PROXY;
 db=await import('../server/db.js');await(await import('../scripts/migrate.js')).migrate();
 const fixtures=await import('../scripts/seed.js');await fixtures.seed();
 const service=await import('../server/service.js');
 const allowed=await service.visibleTasks(fixtures.demoUsers.find(u=>u.id==='anna')!);
 own=allowed[0].id;
 foreign=(await service.visibleTasks(fixtures.demoUsers.find(u=>u.id==='admin')!)).find(t=>!allowed.some(a=>a.id===t.id))!.id;
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');await new Promise<void>(done=>server.once('listening',done));
 site='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const login=await request('/api/demo/login','POST',{userId:'anna'});
 assert.equal(login.status,200);cookie=login.headers.getSetCookie()[0].split(';')[0];
});
after(async()=>{
 globalThis.fetch=realFetch;
 if(server)await new Promise<void>(done=>server.close(()=>done()));
 await db?.pool.end();
 if(master){await master.query(`DROP DATABASE IF EXISTS ${database}`);await master.end();}
});

test('mobile voice validates audio, checks access, drafts once and writes only on confirmation',async()=>{
 let transcript='Добавь комментарий к задаче '+own+': Тестовая запись с телефона.';
 let calls=0;
 globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://api.groq.com/openai/v1/audio/transcriptions');
  const form=options?.body as FormData;assert.equal(form.get('language'),'ru');
  assert.equal((form.get('file') as File).name,'voice.wav');
  calls++;return Response.json({text:transcript});
 };
 assert.equal((await audio(randomUUID(),new Uint8Array([1,2,3]))).status,415);
 assert.equal(calls,0);
 const count=async()=>(await db.pool.query("SELECT count(*)::int n FROM comments WHERE task_id=$1 AND body='Тестовая запись с телефона.'",[own])).rows[0].n;
 const id=randomUUID(),draft=await audio(id);assert.equal(draft.status,200);
 const screen=await draft.json();
 assert.match(screen.text,/Добавить комментарий/);
 assert.equal(await count(),0);
 assert.deepEqual(await (await audio(id)).json(),screen);assert.equal(calls,1);
 const token=screen.buttons.flat().find((b:{text:string})=>b.text==='Подтвердить и отправить').token;
 assert.equal((await request('/api/bot/click','POST',{token})).status,409);
 assert.equal((await request('/api/bot/click?channel=mobile','POST',{token})).status,200);
 assert.equal((await request('/api/bot/click?channel=mobile','POST',{token})).status,200);
 assert.equal(await count(),1);
 transcript='Добавь комментарий к задаче '+foreign+': Чужая задача недоступна.';
 assert.equal((await audio(randomUUID())).status,404);
 assert.equal((await realFetch(site+'/api/bot/voice')).status,401);
});

test('Telegram voice uses the same transcription adapter after a bounded binary GET',async()=>{
 const {transcribeTelegramVoice}=await import('../server/telegram-voice.js');
 const requests:string[]=[];
 globalThis.fetch=async(url,options)=>{
  requests.push(String(url));
  if(String(url).startsWith('https://api.telegram.org/file/')){
   assert.equal(options?.method,'GET');
   return new Response('OggS synthetic',{headers:{'content-type':'audio/ogg'}});
  }
  assert.equal(((options?.body as FormData).get('file') as File).name,'voice.ogg');
  return Response.json({text:'Голосовой ответ.'});
 };
 const text=await transcribeTelegramVoice('anna',{file_id:'fixture',duration:1},async()=>({file_path:'voice/fixture.oga'}),async()=>'FIXTURE');
 assert.equal(text,'Голосовой ответ.');
 await assert.rejects(()=>transcribeTelegramVoice('anna',{file_id:'fixture',duration:91},async()=>({}),async()=>'FIXTURE'),/90 секунд/);
 assert.equal(requests.length,2);
});

test('voice creates a personal task once and carries a partial deadline into the next answer',async()=>{
 const bot=await import('../server/bot.js'),channel='mobile-creation';
 const actor=(await db.pool.query("SELECT * FROM users WHERE id='anna'")).rows[0];
 const admin=(await db.pool.query("SELECT * FROM users WHERE id='admin'")).rows[0];
 const buttons=(view:Awaited<ReturnType<typeof bot.botView>>)=>view.buttons.flat();
 const confirm=async(view:Awaited<ReturnType<typeof bot.botView>>,user=actor)=>bot.botClick(user,channel,buttons(view).find(b=>b.text==='Подтвердить и отправить')!.token);
 const title='Сверить цены по голосовой команде';
 const draft=await bot.botVoiceDraft(actor,channel,`Поставь себе задачу ${title} Цена пять тысяч Срок завтра в 15 часов`,'create-voice');
 assert.match(draft.text,/Исполнитель:/);
 assert.match(draft.text,/5000/);
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM tasks WHERE title=$1',[title])).rows[0].n,0);
 const result=await confirm(draft);
 assert.deepEqual(await confirm(draft),result);
 const rows=(await db.pool.query('SELECT * FROM tasks WHERE title=$1',[title])).rows;
 assert.equal(rows.length,1);
 const task=rows[0];assert.equal(task.assignee_id,actor.id);assert.equal(Number(task.price),5000);
 assert.match(result.text,/поставлена/);
 const denied=await bot.botVoiceDraft(actor,channel,'Поставь задачу: Проверить договор. Исполнитель admin. Цена 100.','outside-scope');
 assert.match(denied.text,/Имя и фамилия исполнителя/);
 assert.equal(buttons(denied).some(b=>b.text==='Подтвердить и отправить'),false);
 const assigned=await bot.botVoiceDraft(admin,channel,'Поставь задачу: Проверить договор. Исполнитель anna. Цена 100.','inside-scope');
 assert.match(assigned.text,new RegExp(actor.name));
 assert.ok(buttons(assigned).some(b=>b.text==='Подтвердить и отправить'));
 await bot.clearBotDraft(actor,channel);
 await bot.botView(actor,channel,{op:'task',id:task.id});
 const partial=await bot.botVoiceDraft(actor,channel,'Перенеси эту задачу на послезавтра. Причина: поставка задержалась. План: сверю остатки и пришлю итог.','transfer-voice');
 assert.match(partial.text,/Дата уже указана/);
 assert.match(partial.text,/сверю остатки/);
 const ready=await bot.botVoiceDraft(actor,channel,'в четыре дня','transfer-time');
 assert.match(ready.text,/16:00/);
 assert.ok(buttons(ready).some(b=>b.text==='Подтвердить и отправить'));
 assert.equal((await db.pool.query('SELECT deadline FROM tasks WHERE id=$1',[task.id])).rows[0].deadline,task.deadline);
});

test('explicit personal reminders work with general Telegram delivery disabled',async()=>{
 const bot=await import('../server/bot.js'),reminders=await import('../server/reminders.js'),channel='mobile-reminders';
 const actor=(await db.pool.query("SELECT * FROM users WHERE id='anna'")).rows[0];
 const task=(await db.pool.query("SELECT id FROM tasks WHERE creator_id='anna' AND id LIKE 'L-%' ORDER BY created_at DESC LIMIT 1")).rows[0];
 const buttons=(view:Awaited<ReturnType<typeof bot.botView>>)=>view.buttons.flat();
 const confirm=(view:Awaited<ReturnType<typeof bot.botView>>)=>bot.botClick(actor,channel,buttons(view).find(b=>b.text==='Подтвердить и отправить')!.token);
 const draft=await bot.botVoiceDraft(actor,channel,`Напомни по задаче ${task.id} завтра в 10:00.`,'single-reminder');
 assert.match(draft.text,/Разовое напоминание|разовое напоминание/);
 await confirm(draft);await confirm(draft);
 const once=(await db.pool.query("SELECT * FROM task_alerts WHERE task_id=$1 AND dedupe_key LIKE 'task-once:%'",[task.id])).rows;
 assert.equal(once.length,1);
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=false');
 assert.equal((await reminders.pendingAlerts(actor,new Date(once[0].due_at),5,false))[0].id,once[0].id);
 const pilot=await import('../server/telegram-pilot.js');
 await db.pool.query("INSERT INTO telegram_binding(chat_id,user_id) VALUES('85001','anna')");
 process.env.TELEGRAM_BOT_TOKEN='FIXTURE_ONLY';delete process.env.TELEGRAM_PROXY_URL;
 const sent:string[]=[];
 globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://api.telegram.org/botFIXTURE_ONLY/sendMessage');
  const body=JSON.parse(String(options?.body));assert.equal(body.chat_id,'85001');sent.push(body.text);
  return Response.json({ok:true,result:{message_id:101}});
 };
 try{
  await pilot.deliver(new Date(once[0].due_at));
  await pilot.deliver(new Date(once[0].due_at));
  assert.equal(sent.length,1);assert.match(sent[0],/Напоминание по задаче/);
 }finally{globalThis.fetch=realFetch;}
 const recurring=await bot.botVoiceDraft(actor,channel,`Напомни по задаче ${task.id} каждый понедельник и среду в девять на две недели.`,'weekly-reminder');
 await confirm(recurring);
 const schedule=(await db.pool.query('SELECT days,times,weeks,personal_delivery FROM task_reminders WHERE task_id=$1',[task.id])).rows[0];
 assert.deepEqual(schedule,{days:[1,3],times:['09:00'],weeks:2,personal_delivery:true});
 const cancellation=await bot.botVoiceDraft(actor,channel,`Отмени напоминание по задаче ${task.id}.`,'cancel-reminder');
 const cancel=buttons(cancellation).find(b=>b.text.startsWith('Отменить '))!;
 await bot.botClick(actor,channel,cancel.token);
 assert.ok((await db.pool.query('SELECT canceled_at FROM task_alerts WHERE id=$1',[once[0].id])).rows[0].canceled_at);
 assert.equal((await reminders.pendingAlerts(actor,new Date(once[0].due_at),5,false)).length,0);
});
