import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import type {Server} from 'node:http';
import type {User,Task} from '../shared/types.js';
import type {BitrixRequest,BitrixMethod} from '../server/bitrix-rest.js';
let server:Server,base:string;const savedDemo=process.env.DEMO_AUTH;
let db:typeof import('../server/db.js'),service:typeof import('../server/service.js'),workflow:typeof import('../server/workflow.js'),live:typeof import('../server/bitrix-live.js'),fields:typeof import('../server/bitrix-fields.js'),adminConnection:pg.Client,director:User,anna:User,ivan:User;
const database='ruspet_live_test_'+randomBytes(6).toString('hex'),savedWrite=process.env.BITRIX_WRITE_ENABLED;
const remote=new Map<string,Record<string,any>>(),calls:{method:BitrixMethod;body:any}[]=[];let lostComment=false;
const messages=new Map<string,{id:number;date:string;author_id:number;text:string}[]>();let lostBeforeDelivery=false;
const transport:BitrixRequest=async<T>(method:BitrixMethod,body:any):Promise<T>=>{
 calls.push({method,body});
 if(method==='tasks.task.getFields')return {fields:{TITLE:{title:'Название',type:'string'},UF_PRICE:{title:'Цена задачи',type:'double'},UF_NOTES:{title:'Дополнительные сведения',type:'string'}}} as T;
 if(method==='user.get')return [{ID:body.FILTER?.ID,ACTIVE:true,NAME:'Фикстура',LAST_NAME:body.FILTER?.ID}] as T;
 if(method==='im.dialog.messages.get'){const id=String(body.DIALOG_ID).slice(4);return {messages:messages.get(id)||[],users:[{id:201,name:'Фикстура'}]} as T;}
 if(method==='tasks.task.history.list')return {list:[]} as T;
 const task=remote.get(String(body.taskId||body.TASKID||body.fields?.taskId));assert(task,'fixture task exists');
 if(method==='tasks.task.get')return {task:{...task}} as T;
 if(method==='tasks.task.update'){
  const names={TITLE:'title',DESCRIPTION:'description',DEADLINE:'deadline',RESPONSIBLE_ID:'responsibleId',UF_PRICE:'ufPrice'};
  for(const [key,value] of Object.entries(body.fields))task[names[key as keyof typeof names]||key]=value;
  return {task:{...task}} as T;
 }
 if(method==='tasks.task.complete'){task.status=task.taskControl==='Y'?'4':'5';return {task:{...task}} as T;}
 if(method==='tasks.task.approve'){assert.equal(task.status,'4');task.status='5';return {task:{...task}} as T;}
 if(method==='tasks.task.disapprove'||method==='tasks.task.renew'){task.status='2';return {task:{...task}} as T;}
 if(method==='tasks.task.chat.message.send'){
  if(!lostBeforeDelivery){const id=String(body.fields.taskId),list=messages.get(id)||[];list.push({id:list.length+1,date:new Date().toISOString(),author_id:201,text:body.fields.text});messages.set(id,list);}
  if(lostComment||lostBeforeDelivery)throw new (await import('../server/bitrix-rest.js')).BitrixError('Неизвестный результат фикстуры','uncertain');
  assert(body.fields.text.includes('[ruspet:'));return {result:true} as T;
 }
 throw Error('Unexpected fixture method '+method);
};
async function makeLinked(externalId:string){
 const input={title:'РЗМ* Пилотная задача фикстуры',description:'Проверка обмена',assigneeId:anna.id,price:10000,deadline:'2026-12-10T15:00:00.000Z',plannedStart:null,plannedEnd:null,important:true,customerRisk:false,parentId:null};
 const made=await workflow.createTask(director,input),task=(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[made.id])).rows[0];
 remote.set(externalId,{id:externalId,chatId:externalId,title:task.title,description:task.description,deadline:task.deadline,status:'2',responsibleId:'202',createdBy:'201',groupId:'123',taskControl:'Y',ufPrice:10000,ufNotes:{text:'Не терять вложенные значения',items:[1,2]},auditors:['201'],ufTaskWebdavFiles:['77']});
 await (await import('../server/bitrix-sync.js')).linkTask(transport,task.id,externalId);
 assert.equal((await live.activateLiveTask(transport,task.id)).activated,true);return task;
}
before(async()=>{
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;adminConnection=new pg.Client({connectionString:current});await adminConnection.connect();await adminConnection.query(`CREATE DATABASE ${database}`);
 const url=new URL(current);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();process.env.BITRIX_WRITE_ENABLED='true';
 process.env.DEMO_AUTH='true';db=await import('../server/db.js');await(await import('../scripts/migrate.js')).migrate();const seed=await import('../scripts/seed.js');await seed.seed();director=seed.demoUsers.find(u=>u.role==='director')!;anna=seed.demoUsers.find(u=>u.id==='anna')!;ivan=seed.demoUsers.find(u=>u.id==='ivan')!;
 service=await import('../server/service.js');workflow=await import('../server/workflow.js');live=await import('../server/bitrix-live.js');fields=await import('../server/bitrix-fields.js');
 await fields.discoverTaskFields(transport);await live.configureLive('123','UF_PRICE');
 for(const [person,id] of [[director,'201'],[anna,'202'],[ivan,'203']] as const){await fields.mapBitrixUser(transport,person.id,id,true);await db.pool.query('INSERT INTO bitrix_pilot_members(user_id,pilot_role) VALUES($1,$2)',[person.id,person.role==='employee'?'manager':'leader']);}
 await db.pool.query('UPDATE bitrix_live_config SET enabled=true WHERE id=1');
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
after(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));if(savedDemo===undefined)delete process.env.DEMO_AUTH;else process.env.DEMO_AUTH=savedDemo;if(savedWrite===undefined)delete process.env.BITRIX_WRITE_ENABLED;else process.env.BITRIX_WRITE_ENABLED=savedWrite;await db?.pool.end();if(adminConnection){await adminConnection.query(`DROP DATABASE IF EXISTS ${database}`);await adminConnection.end();}});

test('verified event mode skips background task scans and reads an idle task only when its ID is queued',async()=>{
 const task=await makeLinked('9799');
 await db.pool.query("UPDATE bitrix_event_capture SET enabled=true,verified_at=now() WHERE id=1");
 const before=calls.length;remote.get('9799')!.title='РЗМ* Изменено по событию';
 await live.tickLiveSync(transport);assert.equal(calls.slice(before).filter(c=>c.method==='tasks.task.get'&&String(c.body.taskId)==='9799').length,0);
 await live.tickLiveSync(transport,{taskIds:[task.id],poll:false});assert.equal((await db.pool.query('SELECT title FROM tasks WHERE id=$1',[task.id])).rows[0].title,'РЗМ* Изменено по событию');
 await db.pool.query('UPDATE bitrix_event_capture SET enabled=false,verified_at=NULL WHERE id=1');await db.pool.query('UPDATE bitrix_task_links SET live_enabled=false WHERE task_id=$1',[task.id]);
});

test('delegated acceptance arriving from Bitrix submits its source and queues the source review through the existing transport',async()=>{
 const lead=(await db.pool.query<User>("SELECT * FROM users WHERE id='lead-msk'")).rows[0];
 await fields.mapBitrixUser(transport,lead.id,'204',true);await db.pool.query("INSERT INTO bitrix_pilot_members(user_id,pilot_role) VALUES($1,'leader')",[lead.id]);
 const source=await workflow.createTask(director,{title:'РЗМ* Источник поручения',description:'Фикстура автоматической сдачи',assigneeId:lead.id,price:55000,deadline:null,plannedStart:null,plannedEnd:null,important:false,customerRisk:false,parentId:null});
 const child=await workflow.delegateTask(lead,source.id,{assigneeId:anna.id,expectedVersion:1});
 for(const [id,externalId,owner,creator] of [[source.id,'9801','204','201'],[child.id,'9802','202','204']]){
  const task=(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
  remote.set(externalId,{id:externalId,chatId:externalId,title:task.title,description:task.description,deadline:task.deadline,status:'2',responsibleId:owner,createdBy:creator,groupId:'123',taskControl:'Y',ufPrice:Number(task.price)});
  await (await import('../server/bitrix-sync.js')).linkTask(transport,id,externalId);await live.activateLiveTask(transport,id);
 }
 await workflow.reviewTask(anna,child.id,'submit','Результат делегированного поручения готов',1);await live.tickLiveSync(transport);
 assert.equal(remote.get('9802')!.status,'4');assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id=$1',[source.id])).rows[0].status,'active');
 remote.get('9802')!.status='5';await live.tickLiveSync(transport);
 assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id=$1',[source.id])).rows[0].status,'review');
 assert.equal((await db.pool.query('SELECT state FROM task_submissions WHERE task_id=$1 AND withdrawn_at IS NULL',[child.id])).rows[0].state,'accepted');
 const parentSubmission=(await db.pool.query('SELECT * FROM task_submissions WHERE task_id=$1',[source.id])).rows[0];assert.equal(parentSubmission.automatic,true);assert.match(parentSubmission.result,/Результат делегированного поручения готов/);
 await live.tickLiveSync(transport);assert.equal(remote.get('9801')!.status,'4');
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM delegation_auto_reviews WHERE source_id=$1',[source.id])).rows[0].n,1);
 const oldSource=await workflow.createTask(director,{title:'РЗМ* Историческая сверка',description:'Фикстура первичного выравнивания',assigneeId:lead.id,price:0,deadline:null,plannedStart:null,plannedEnd:null,important:false,customerRisk:false,parentId:null});
 const oldChild=await workflow.delegateTask(lead,oldSource.id,{assigneeId:anna.id,expectedVersion:1}),oldTask=(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[oldChild.id])).rows[0];
 remote.set('9803',{id:'9803',chatId:'9803',title:oldTask.title,description:oldTask.description,deadline:null,status:'5',responsibleId:'202',createdBy:'204',groupId:'123',taskControl:'Y',ufPrice:0});
 await (await import('../server/bitrix-sync.js')).linkTask(transport,oldChild.id,'9803');await live.activateLiveTask(transport,oldChild.id,true);
 assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id=$1',[oldSource.id])).rows[0].status,'active');
 // Keep the established pilot roster used by the readiness checks below.
 await db.pool.query('UPDATE bitrix_task_links SET live_enabled=false WHERE task_id=ANY($1)',[[source.id,child.id,oldChild.id]]);
 await db.pool.query('DELETE FROM bitrix_pilot_members WHERE user_id=$1',[lead.id]);
});

test('all task fields survive staging and a live queue synchronizes edits, price, assignee, review, completion and comments in order',async()=>{
 let task=await makeLinked('901');
 const snapshot=(await db.pool.query("SELECT raw FROM bitrix_task_snapshots WHERE external_id=901")).rows[0].raw;
 assert.deepEqual(snapshot.ufNotes,{text:'Не терять вложенные значения',items:[1,2]});
 assert((calls.find(c=>c.method==='tasks.task.get')!.body.select as string[]).includes('UF_NOTES'));
 const edited={title:'РЗМ* Изменена пилотная фикстура',description:task.description,assigneeId:ivan.id,price:55000,deadline:task.deadline,plannedStart:null,plannedEnd:null,important:task.important,customerRisk:task.customer_risk,parentId:null};
 await workflow.editTask(director,task.id,edited,task.version,'Проверка настоящего обмена');
 assert.equal((await fields.taskIntegration(ivan,task.id)).state,'pending');
 const result=await live.tickLiveSync(transport);assert.equal(result.sent,1);assert.equal(remote.get('901')!.ufPrice,55000);assert.equal(remote.get('901')!.responsibleId,'203');
 task=(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[task.id])).rows[0];
 await workflow.reviewTask(ivan,task.id,'submit','Результат проверен и готов к приёмке',task.version);await live.tickLiveSync(transport);assert.equal(remote.get('901')!.status,'4');
 task=(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[task.id])).rows[0];
 await workflow.reviewTask(director,task.id,'accept','',task.version);await live.tickLiveSync(transport);assert.equal(remote.get('901')!.status,'5');
 await service.addComment(director,task.id,'Проверка комментария из нашей системы');await live.tickLiveSync(transport);
 const writes=calls.filter(c=>c.method==='tasks.task.chat.message.send').length;await live.tickLiveSync(transport);assert.equal(calls.filter(c=>c.method==='tasks.task.chat.message.send').length,writes);
 assert.equal((await fields.taskIntegration(director,task.id)).state,'synced');
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM bitrix_operations WHERE task_id=$1 AND state='sent'",[task.id])).rows[0].n,4);
 await assert.rejects(()=>fields.taskIntegration(anna,task.id),/недоступна/);
 const {lastUndo,undoLastAction}=await import('../server/undo.js');const undo=await lastUndo(director,task.id);assert(undo);await assert.rejects(()=>undoLastAction(director,undo.id),/Битрикс24/);
});

test('remote changes pull in with history; conflicts and unknown comment sends block only their task without duplicate retries',async()=>{
 let task=await makeLinked('902');remote.get('902')!.ufPrice=500000;remote.get('902')!.title='РЗМ* Изменено на портале';await live.tickLiveSync(transport);
 task=(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[task.id])).rows[0];assert.equal(Number(task.price),500000);assert.equal(task.title,'РЗМ* Изменено на портале');
 const edit={title:'РЗМ* Локальное название',description:task.description,assigneeId:anna.id,price:500000,deadline:task.deadline,plannedStart:null,plannedEnd:null,important:task.important,customerRisk:task.customer_risk,parentId:null};
 await workflow.editTask(director,task.id,edit,task.version,'Локальная правка для сверки');remote.get('902')!.title='РЗМ* Конкурирующая правка';await live.tickLiveSync(transport);
 assert.equal((await fields.taskIntegration(anna,task.id)).state,'blocked');assert.equal(remote.get('902')!.title,'РЗМ* Конкурирующая правка');
 const other=await makeLinked('903');await service.addComment(director,other.id,'Комментарий с неизвестным результатом отправки');lostComment=true;await live.tickLiveSync(transport);lostComment=false;
 assert.equal((await fields.taskIntegration(anna,other.id)).state,'uncertain');const writes=calls.filter(c=>c.method==='tasks.task.chat.message.send').length;
 await service.addComment(director,other.id,'Следующий комментарий ждёт сверки предыдущего');await live.tickLiveSync(transport);assert.equal(calls.filter(c=>c.method==='tasks.task.chat.message.send').length,writes);
 const uncertain=(await db.pool.query("SELECT event_id FROM bitrix_operations WHERE task_id=$1 AND state='uncertain'",[other.id])).rows[0].event_id;
 await assert.rejects(()=>live.recoverOperation(transport,uncertain,'retry'),/неизвестного/);
 assert.equal((await live.recoverOperation(transport,uncertain,'verify')).state,'sent');await live.tickLiveSync(transport);assert.equal(calls.filter(c=>c.method==='tasks.task.chat.message.send').length,writes+1);
 const pending=await makeLinked('904');await service.addComment(director,pending.id,'Комментарий ещё не ушёл и может быть отменён');
 const {lastUndo,undoLastAction}=await import('../server/undo.js');const undo=await lastUndo(director,pending.id);assert(undo);await undoLastAction(director,undo.id);
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM bitrix_operations WHERE task_id=$1 AND state='canceled'",[pending.id])).rows[0].n,1);
 await db.pool.query('UPDATE bitrix_live_config SET enabled=false WHERE id=1');assert.equal((await live.tickLiveSync(transport)).paused,true);
 assert.equal((await fields.taskIntegration(anna,pending.id)).paused,true);
 const status=await (await import('../server/pilot-readiness.js')).pilotReadiness();assert.equal(status.ready,false);assert(status.checks.some(c=>c.level==='block'));
});

test('independent portal edits survive outbound writes; unknown messages without evidence and interrupted sends never replay blindly',async()=>{
 await db.pool.query('UPDATE bitrix_live_config SET enabled=true WHERE id=1');
 let task=await makeLinked('905');
 await workflow.editTask(director,task.id,{title:task.title,description:task.description,assigneeId:anna.id,price:12000,deadline:task.deadline,plannedStart:null,plannedEnd:null,important:task.important,customerRisk:task.customer_risk,parentId:null},task.version,'Изменяем только цену');
 remote.get('905')!.title='РЗМ* Независимое изменение Битрикс24';await live.tickLiveSync(transport);
 task=(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[task.id])).rows[0];assert.equal(task.title,'РЗМ* Независимое изменение Битрикс24');assert.equal(Number(task.price),12000);assert.equal((await fields.taskIntegration(anna,task.id)).state,'synced');
 await service.addComment(director,task.id,'Комментарий мог не дойти до портала');lostBeforeDelivery=true;await live.tickLiveSync(transport);lostBeforeDelivery=false;
 const uncertain=(await db.pool.query("SELECT event_id FROM bitrix_operations WHERE task_id=$1 AND state='uncertain'",[task.id])).rows[0].event_id;
 await assert.rejects(()=>live.recoverOperation(transport,uncertain,'verify'),/не найден/);assert.equal((await fields.taskIntegration(anna,task.id)).state,'uncertain');
 const interrupted=await makeLinked('906');await service.addComment(director,interrupted.id,'Отправка ещё не начиналась');
 const op=(await db.pool.query("UPDATE bitrix_operations SET state='processing',phase='reading' WHERE task_id=$1 RETURNING event_id",[interrupted.id])).rows[0].event_id;
 const count=calls.filter(c=>c.method==='tasks.task.chat.message.send').length;await live.tickLiveSync(transport);assert.equal((await fields.taskIntegration(anna,interrupted.id)).state,'uncertain');assert.equal(calls.filter(c=>c.method==='tasks.task.chat.message.send').length,count);
 assert.equal((await live.recoverOperation(transport,op,'verify')).state,'pending');await live.tickLiveSync(transport);assert.equal((await fields.taskIntegration(anna,interrupted.id)).state,'synced');
});


test('pilot readiness and queue are admin-only, while all source fields require current task access',async()=>{
 const login=async(id:string)=>{const r=await fetch(base+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:id})});assert.equal(r.status,200);return r.headers.get('set-cookie')!.split(';')[0]};
 assert.equal((await fetch(base+'/api/system/pilot')).status,401);
 for(const id of ['anna','director']){const cookie=await login(id);assert.equal((await fetch(base+'/api/system/pilot',{headers:{Cookie:cookie}})).status,403);assert.equal((await fetch(base+'/api/system/pilot/queue',{headers:{Cookie:cookie}})).status,403);}
 const cookie=await login('admin'),response=await fetch(base+'/api/system/pilot',{headers:{Cookie:cookie}});assert.equal(response.status,200);const status=await response.json();assert.equal(status.ready,false);assert(status.checks.some((c:{level:string})=>c.level==='block'));
 const queue=await fetch(base+'/api/system/pilot/queue',{headers:{Cookie:cookie}});assert.equal(queue.status,200);const text=await queue.text();assert(!text.includes('payload'));assert(!text.includes('password'));
});

test('initial baseline does not invent deadline transfers; a proposed deadline waits for approval and bot confirmation queues a comment once',async()=>{
 let task=await makeLinked('907');
 await db.pool.query('UPDATE bitrix_live_config SET enabled=false WHERE id=1');await live.deactivateLiveTask(task.id);
 remote.get('907')!.deadline='2034-01-01T09:00:00.000Z';assert.equal((await live.activateLiveTask(transport,task.id)).activated,false);await live.activateLiveTask(transport,task.id,true);
 task=(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[task.id])).rows[0];assert.equal(task.transfer_count,0);
 const cfg=await service.config(),admin=(await db.pool.query<User>("SELECT * FROM users WHERE role='admin'")).rows[0];await service.saveRules(admin,{...cfg.config,routes:{deadline:['creator'],completion:['creator']}},cfg.version);
 await db.pool.query('UPDATE bitrix_live_config SET enabled=true WHERE id=1');
 const request=await service.requestApproval(anna,task.id,{type:'deadline',reason:'Требуется дополнительное время для проверки',plan:'Завершить проверку и передать результат',proposedDeadline:'2035-02-01T09:00:00.000Z',expectedVersion:task.version});
 await live.tickLiveSync(transport);assert.equal(remote.get('907')!.deadline,'2034-01-01T09:00:00.000Z');
 await service.decide(director,request.id,{decision:'approve',comment:'Срок подтверждён руководителем',expectedStep:0});await live.tickLiveSync(transport);assert.equal(remote.get('907')!.deadline,'2035-02-01T09:00:00.000Z');
 await assert.rejects(()=>service.decide(director,request.id,{decision:'approve',comment:'Повтор',expectedStep:0}),/принято|устарел/);
 const {botView,botClick,botText}=await import('../server/bot.js'),channel='fixture-pilot';
 const view=await botView(anna,channel,{op:'task',id:task.id});await botClick(anna,channel,view.buttons.flat().find(b=>b.text==='Написать комментарий')!.token);
 const ready=await botText(anna,channel,'Комментарий из Telegram для портала','fixture-comment-unique');const token=ready.buttons.flat().find(b=>b.text==='Подтвердить и отправить')!.token;
 const first=await botClick(anna,channel,token),second=await botClick(anna,channel,token);assert.equal(first.text,second.text);assert(first.text.includes('Обмен с Битрикс24 выполняется по очереди'));
 await live.tickLiveSync(transport);assert.equal(messages.get('907')!.filter(m=>m.text.includes('Комментарий из Telegram для портала')).length,1);
});

test('the REST transport routes the new task chat to REST 3.0 and keeps field discovery on the classic endpoint',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const folder=await mkdtemp(join(tmpdir(),'ruspet-rest-fixture-')),file=join(folder,'webhook');await writeFile(file,'https://fixture.example/rest/1/fixture-secret/',{mode:0o600});
 const previous={fetch:globalThis.fetch,portal:process.env.BITRIX_PORTAL,file:process.env.BITRIX_WEBHOOK_FILE};const paths:string[]=[];
 try{
  process.env.BITRIX_PORTAL='fixture.example';process.env.BITRIX_WEBHOOK_FILE=file;
  globalThis.fetch=async(input)=>{const url=new URL(String(input));paths.push(url.pathname);return new Response(JSON.stringify({result:{result:true}}),{status:200,headers:{'Content-Type':'application/json'}})};
  const request=await(await import('../server/bitrix-rest.js')).bitrixClient();await request('tasks.task.chat.message.send',{fields:{taskId:'907',text:'Изолированная фикстура'}});await request('tasks.task.getFields',{});
  assert.equal(paths[0],'/rest/api/1/fixture-secret/tasks.task.chat.message.send');assert.equal(paths[1],'/rest/1/fixture-secret/tasks.task.getFields');
 }finally{globalThis.fetch=previous.fetch;if(previous.portal===undefined)delete process.env.BITRIX_PORTAL;else process.env.BITRIX_PORTAL=previous.portal;if(previous.file===undefined)delete process.env.BITRIX_WEBHOOK_FILE;else process.env.BITRIX_WEBHOOK_FILE=previous.file;await rm(folder,{recursive:true,force:true});}
});

test('readiness passes a fully prepared two-manager fixture and blocks again when a personal login is disabled',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const folder=await mkdtemp(join(tmpdir(),'ruspet-ready-fixture-')),file=join(folder,'webhook');await writeFile(file,'https://thebest.bitrix24.ru/rest/1/fixture-not-real/',{mode:0o600});
 const saved={DEMO_AUTH:process.env.DEMO_AUTH,PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN,BITRIX_PORTAL:process.env.BITRIX_PORTAL,BITRIX_WEBHOOK_FILE:process.env.BITRIX_WEBHOOK_FILE};
 try{
  await db.pool.query("UPDATE bitrix_operations SET state='canceled' WHERE state NOT IN ('sent','canceled')");await db.pool.query('UPDATE bitrix_task_links SET conflict=NULL,live_enabled=false WHERE external_id<>907');
  const task=await makeLinked('908');await workflow.editTask(director,task.id,{title:task.title,description:task.description,assigneeId:ivan.id,price:10000,deadline:task.deadline,plannedStart:null,plannedEnd:null,important:task.important,customerRisk:task.customer_risk,parentId:null},task.version,'Выделяем задачу второму участнику');await live.tickLiveSync(transport);
  const hash=await(await import('../server/passwords.js')).hashPassword('Fixture-only-not-real');
  for(const person of [anna,ivan,director]){await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$2,$3)',['pilot-'+person.id,person.id,hash]);await db.pool.query('INSERT INTO telegram_binding(chat_id,user_id) VALUES($1,$2)',['fixture-chat-'+person.id,person.id]);}
  await db.pool.query('INSERT INTO org_reporting(employee_id,manager_id) VALUES($1,$3),($2,$3)',[anna.id,ivan.id,director.id]);
  await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=true WHERE id=1');await db.pool.query('INSERT INTO telegram_runtime(id,last_poll_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET last_poll_at=now(),error=NULL');
  await db.pool.query("UPDATE bitrix_rest_gate SET portal='thebest.bitrix24.ru',last_success_at=now() WHERE id=1");
  process.env.DEMO_AUTH='false';process.env.PUBLIC_ORIGIN='https://fixture.example';process.env.BITRIX_PORTAL='thebest.bitrix24.ru';process.env.BITRIX_WEBHOOK_FILE=file;
  const readiness=await(await import('../server/pilot-readiness.js')).pilotReadiness();assert.equal(readiness.ready,true,JSON.stringify(readiness.checks.filter(c=>c.level==='block')));
  await db.pool.query("UPDATE login_accounts SET enabled=false WHERE username='pilot-anna'");const revoked=await(await import('../server/pilot-readiness.js')).pilotReadiness();assert.equal(revoked.ready,false);assert(revoked.checks.some(c=>c.level==='block'&&c.message.includes('веб-вход')));
 }finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(folder,{recursive:true,force:true});}
});
