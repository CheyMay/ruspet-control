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
