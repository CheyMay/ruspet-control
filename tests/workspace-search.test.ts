import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Server} from 'node:http';
import pg from 'pg';
import type {User} from '../shared/types.js';
import type {SearchResponse} from '../shared/workspace-search.js';

const key=randomBytes(5).toString('hex'),database='ruspet_search_'+key,clientsDb='ruspet_search_okb_'+key;
let admin:pg.Client,server:Server,base:string,anna:User,ivan:User,director:User;
let db:typeof import('../server/db.js'),okb:typeof import('../server/okb.js');
let ownId:string,hiddenId:string,ownComment:string;
const cookies=new Map<string,string>();

async function search(params:Record<string,string>,actor?:User,preview?:User){
 const response=await fetch(base+'/api/workspace-search?'+new URLSearchParams(params),{
  headers:{...(actor?{Cookie:cookies.get(actor.id)!}:{}),...(preview?{'X-Ruspet-View-As':preview.id}:{})},
 });
 return {status:response.status,cache:response.headers.get('cache-control'),data:await response.json() as SearchResponse};
}

before(async()=>{
 const original=process.env.DATABASE_URL??JSON.parse(await readFile('.local/connection.json','utf8')).url;
 admin=new pg.Client({connectionString:original});await admin.connect();
 await admin.query(`CREATE DATABASE ${database}`);await admin.query(`CREATE DATABASE ${clientsDb}`);
 const main=new URL(original);main.pathname='/'+database;
 const clients=new URL(original);clients.pathname='/'+clientsDb;
 process.env.DATABASE_URL=main.href;process.env.OKB_DATABASE_URL=clients.href;process.env.DEMO_AUTH='true';
 db=await import('../server/db.js');okb=await import('../server/okb.js');
 await (await import('../scripts/migrate.js')).migrate();await okb.migrateOkb();
 const seed=await import('../scripts/seed.js');await seed.seed();
 anna=seed.demoUsers.find(user=>user.id==='anna')!;
 ivan=seed.demoUsers.find(user=>user.id==='ivan')!;
 director=seed.demoUsers.find(user=>user.role==='director')!;
 const {createTask}=await import('../server/workflow.js');
 const sample={description:'Документы на расчёт партии',price:150,deadline:null,plannedStart:null,plannedEnd:null,important:false,customerRisk:false,parentId:null};
 ownId=(await createTask(director,{...sample,title:'Встреча по проекту Ёлка',assigneeId:anna.id})).id;
 hiddenId=(await createTask(director,{...sample,title:'Закрытая встреча по проекту Ёлка',assigneeId:ivan.id})).id;
 await db.pool.query("UPDATE tasks SET created_at='2026-11-25T11:00:00+03:00' WHERE id=ANY($1)",[[ownId,hiddenId]]);
 await db.pool.query("INSERT INTO bitrix_task_snapshots(external_id,snapshot) VALUES(81020,'{}'),(81021,'{}')");
 await db.pool.query("INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,81020,'{}',1),($2,81021,'{}',1)",[ownId,hiddenId]);
 ownComment=randomUUID();
 await db.pool.query(`INSERT INTO comments(id,task_id,author_id,body,withdrawn_at,created_at) VALUES
  ($1,$2,$3,'Детали встречи и образцы продукции',NULL,'2026-11-25T11:30:00+03:00'),
  ($4,$2,$3,'Удалённые образцы продукции',now(),'2026-11-25T11:35:00+03:00'),
  ($5,$6,$7,'Секретные образцы продукции',NULL,'2026-11-25T11:40:00+03:00')`,
 [ownComment,ownId,anna.id,randomUUID(),randomUUID(),hiddenId,ivan.id]);
 await db.pool.query(`INSERT INTO bitrix_task_activity(task_id,kind,external_id,occurred_at,author,body)
  VALUES($1,'comment',415,'2026-11-25T12:00:00+03:00','Елена','Артикул из Битрикса'),($2,'comment',416,'2026-11-25T12:00:00+03:00','Елена','Скрытый артикул из Битрикса')`,[ownId,hiddenId]);
 await okb.okbPool().query(`INSERT INTO companies(id,name,tax_id,status,contact,notes,manager_id) VALUES
  ($1,'Тестовый контрагент Ёлка Север','1234567890','active','закрытый номер','закрытая заметка',$2),
  ($3,'Тестовый контрагент Ёлка Юг','1234567891','active','','',$4)`,[randomUUID(),anna.id,randomUUID(),ivan.id]);
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));
 base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const actor of [anna,ivan,director,seed.demoUsers.find(user=>user.role==='admin')!]){
  const response=await fetch(base+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:actor.id})});
  assert.equal(response.status,200);cookies.set(actor.id,response.headers.get('set-cookie')!.split(';')[0]);
 }
});

after(async()=>{
 if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 await okb?.closeOkb();await db?.pool.end();
 if(admin){await admin.query(`DROP DATABASE IF EXISTS ${clientsDb}`);await admin.query(`DROP DATABASE IF EXISTS ${database}`);await admin.end();}
});

test('workspace search ranks visible task numbers and rejects unauthenticated and contradictory searches',async()=>{
 assert.equal((await search({q:'ёлка'})).status,401);
 const numbers=await search({q:'#81020',kind:'task'},anna);
 assert.equal(numbers.cache,'no-store');assert.deepEqual(numbers.data.hits.map(hit=>hit.id),[ownId]);
 assert.deepEqual((await search({q:'елка встреча',kind:'task'},anna)).data.hits.map(hit=>hit.id),[ownId]);
 assert.equal((await search({q:'елка',kind:'task',owner:ivan.id},anna)).data.hits.length,0);
 assert.deepEqual((await search({q:'елка',kind:'task',owner:anna.id,from:'2026-11-25',to:'2026-11-25'},director)).data.hits.map(hit=>hit.id),[ownId]);
 assert.equal((await search({q:'елка',from:'2026-11-26',to:'2026-11-25'},director)).status,400);
});

test('comments and client results follow task and account scope without exposing unrelated records',async()=>{
 const comments=(await search({q:'образцы продукции',kind:'comment'},anna)).data.hits;
 assert.deepEqual(comments.map(hit=>[hit.id,hit.taskId]),[['local:'+ownComment,ownId]]);
 assert.equal((await search({q:'образцы',kind:'comment'},director)).data.hits.length,2);
 const imported=(await search({q:'артикул',kind:'comment'},anna)).data.hits;
 assert.deepEqual(imported.map(hit=>[hit.id,hit.taskId]),[['bitrix:415',ownId]]);
 await db.pool.query(`INSERT INTO bitrix_task_activity(task_id,kind,external_id,occurred_at,author,body)
  SELECT $1,'comment',n,'2026-11-25T13:00:00+03:00','Елена','Новое сообщение'
  FROM generate_series(1001,1105) n`,[ownId]);
 const discussion=async(focus?:string)=>{
  const response=await fetch(base+'/api/tasks/81020/discussion'+(focus?'?focus='+focus:''),{headers:{Cookie:cookies.get(anna.id)!}});
  assert.equal(response.status,200);
  return (await response.json()).messages as {external_id:string;body:string}[];
 };
 assert(!(await discussion()).some(message=>String(message.external_id)==='415'));
 assert((await discussion('415')).some(message=>String(message.external_id)==='415'));
 assert(!(await discussion('416')).some(message=>String(message.external_id)==='416'));
 const companies=(await search({q:'Тестовый контрагент Ёлка',kind:'company'},anna)).data.hits;
 assert.equal(companies.length,1);assert.match(companies[0].title,/Север/);
 assert.doesNotMatch(JSON.stringify(companies),/закрытый номер|закрытая заметка/);
 assert.equal((await search({q:'Тестовый контрагент Ёлка',kind:'company'},director)).data.hits.length,2);
 const preview=await search({q:'Тестовый контрагент Ёлка',kind:'company'},{id:'admin'} as User,anna);
 assert.equal(preview.status,200);assert.equal(preview.data.hits.length,0);
});

test('a pasted command stays a draft until the authenticated user confirms it',async()=>{
 const body='Расчёт проверен по присланному письму.';
 const input={text:'Добавь комментарий к задаче 81020: '+body,inputId:randomUUID()};
 const post=(actor:User,path:string,value:unknown)=>fetch(base+'/api/bot/'+path,{
  method:'POST',headers:{Cookie:cookies.get(actor.id)!,'Content-Type':'application/json'},body:JSON.stringify(value)
 });
 const saved=async()=>Number((await db.pool.query('SELECT count(*) AS n FROM comments WHERE task_id=$1 AND body=$2',[ownId,body])).rows[0].n);
 const response=await post(anna,'text-draft',input);
 assert.equal(response.status,200);
 const draft=await response.json() as {text:string;buttons:{text:string;token:string}[][]};
 assert.match(draft.text,/Расчёт проверен по присланному письму/);
 assert.equal(await saved(),0);
 assert.deepEqual(await (await post(anna,'text-draft',input)).json(),draft);
 const confirm=draft.buttons.flat().find(button=>button.text==='Подтвердить и отправить');
 assert(confirm);
 assert.equal((await post(ivan,'click',{token:confirm.token})).status,409);
 assert.equal((await post(anna,'click',{token:confirm.token})).status,200);
 assert.equal(await saved(),1);
 assert.equal((await post(anna,'click',{token:confirm.token})).status,200);
 assert.equal(await saved(),1);
});
