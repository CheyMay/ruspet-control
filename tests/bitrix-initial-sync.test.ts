import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import type {Server} from 'node:http';
import type {User} from '../shared/types.js';
import type {BitrixRequest,BitrixMethod} from '../server/bitrix-rest.js';
const database='ruspet_initial_'+randomBytes(5).toString('hex'),portal='fixture.bitrix24.ru';
const previous={...process.env};let connection:pg.Client,directory:string,server:Server,base:string,admin:User,employee:User;
let okb:typeof import('../server/okb.js');
let db:typeof import('../server/db.js'),archive:typeof import('../server/bitrix-archive.js'),events:typeof import('../server/bitrix-events.js'),refresh:typeof import('../server/bitrix-refresh.js');
const cookies=new Map<string,string>(),calls:{method:BitrixMethod;params:any}[]=[];
const task=(id:string)=>({id,title:'ТЕСТ* Полная задача '+id,description:'Только вымышленная фикстура',deadline:null,status:'5',responsibleId:'202',createdBy:'201',chatId:id,ufCrmTask:['CO_1'],ufTaskWebdavFiles:['90'],ufNested:{items:['Не терять пользовательские данные']},accomplices:['203'],auditors:['204']});
let companyMissing=false;
let failMethod:BitrixMethod|null=null,inject:((method:BitrixMethod)=>Promise<void>)|null=null,missingTask=false,forbiddenTask=false;
const request:BitrixRequest=Object.assign(async<T>(method:BitrixMethod,params:any):Promise<T>=>{
 calls.push({method,params});if(inject)await inject(method);
 if(failMethod===method){failMethod=null;throw new (await import('../server/bitrix-rest.js')).BitrixError('QUERY_LIMIT_EXCEEDED','rejected','QUERY_LIMIT_EXCEEDED');}
 if(method==='tasks.task.getFields')return {fields:{ID:{},TITLE:{},UF_NESTED:{}}} as T;
 if(method.endsWith('.fields'))return {ID:{},TITLE:{},PHONE:{isMultiple:true},UF_MULTI:{isMultiple:true}} as T;
 if(method==='user.get')return Array.from({length:52},(_,i)=>({ID:String(i+1),NAME:'Фикстура',LAST_NAME:String(i+1),UF_DEPARTMENT:['1']})).filter(r=>BigInt(r.ID)>BigInt(params.FILTER?.['>ID']||'0')).slice(0,50) as T;
 if(method==='department.get')return [{ID:'1',NAME:'Тестовый отдел',UF_HEAD:'1'}] as T;
 if(method==='sonet_group.get')return (params.FILTER?.['>ID']==='0'?[{ID:'1',NAME:'Тестовый проект'}]:[]) as T;
 if(method==='tasks.task.list')return {tasks:['8001','8002'].filter(id=>BigInt(id)>BigInt(params.filter['>ID'])).map(task)} as T;
 if(method==='tasks.task.get'){
  if(missingTask)throw new (await import('../server/bitrix-rest.js')).BitrixError('ERROR_TASK_NOT_FOUND','rejected','ERROR_TASK_NOT_FOUND');
  if(forbiddenTask)throw new (await import('../server/bitrix-rest.js')).BitrixError('ACCESS_DENIED','rejected','ACCESS_DENIED');
  return {task:task(String(params.taskId))} as T;
 }
 if(method==='crm.company.get'){if(companyMissing)throw new(await import('../server/bitrix-rest.js')).BitrixError('NOT_FOUND','rejected','NOT_FOUND');return {ID:String(params.id),TITLE:'Обновлённая тестовая компания',ASSIGNED_BY_ID:'203'} as T;}
 if(/^crm\.(company|contact|deal|lead)\.list$/.test(method))return (params.filter['>ID']==='0'?[{ID:'1',TITLE:'Тестовая компания',NAME:'Контакт',ASSIGNED_BY_ID:'202',PHONE:[{VALUE:'fixture'}],UF_MULTI:['one','two']}]:[]) as T;
 if(method==='crm.status.list'||method==='crm.requisite.list'||method==='crm.requisite.bankdetail.list'||method==='crm.address.list')return [] as T;
 if(method==='crm.type.list')return {types:params.filter['>id']==='0'?[{id:'1',entityTypeId:'180',title:'Тестовый процесс'}]:[]} as T;
 if(method==='crm.item.fields')return {fields:{id:{},ufCrmFixture:{}}} as T;
 if(method==='crm.item.list'){assert.deepEqual(params.select,['*']);assert.equal(params.useOriginalUfNames,'Y');return {items:params.filter['>id']==='0'?[{id:'7',ufCrmFixture:'Значение'}]:[]} as T;}
 if(method==='tasks.task.history.list')return {list:[{createdDate:'2026-11-01T12:00:00Z',field:'DEADLINE',value:{from:null,to:'2026-11-10'}}]} as T;
 if(method==='tasks.task.result.list')return [{id:1,text:'Принятый результат',fileInfo:[]}] as T;
 if(method==='task.checklistitem.getlist')return [{ID:'1',TITLE:'Шаг',IS_COMPLETE:'Y'}] as T;
 if(method==='task.elapseditem.getlist'){assert(Array.isArray(params));return [{ID:'1',SECONDS:120,COMMENT_TEXT:'Тестовый учёт'}] as T;}
 if(method==='im.dialog.messages.get'){
  const before=Number(params.LAST_ID||102),messages=Array.from({length:101},(_,i)=>({id:i+1,text:'Сообщение '+(i+1),author_id:202,date:'2026-11-01T10:00:00Z'})).filter(r=>r.id<before).slice(-51);
  return {messages,users:[{id:202,name:'Фикстура'}],files:[]} as T;
 }
 if(['crm.deal.productrows.get','crm.lead.productrows.get'].includes(method))return [{ID:'1',PRODUCT_NAME:'Тестовый товар',PRICE:100,QUANTITY:1}] as T;
 if(method==='sonet_group.user.get')return [{USER_ID:'202',ROLE:'K'}] as T;
 if(['crm.company.contact.items.get','crm.deal.contact.items.get','crm.lead.contact.items.get'].includes(method))return [{CONTACT_ID:'1',IS_PRIMARY:'Y'}] as T;
 if(method==='crm.timeline.comment.list')return [{ID:'1',COMMENT:'Комментарий CRM',ENTITY_ID:'1'}] as T;
 if(method==='crm.activity.list')return (params.filter['>ID']==='0'?[{ID:'1',SUBJECT:'Тестовое дело',OWNER_ID:'1'}]:[]) as T;
 if(method==='disk.attachedObject.get')return {ID:'90',OBJECT_ID:'91',SIZE:'3'} as T;
 if(method==='disk.file.get')return {ID:'91',SIZE:'3',DOWNLOAD_URL:'https://fixture.bitrix24.ru/file-download'} as T;
 throw Error('Unexpected fixture method '+method);
},{portal,mode:'webhook' as const});
async function configureCapture(){await db.pool.query("UPDATE bitrix_event_capture SET enabled=true,portal=$1,member_id='fixture-member',verified_at=now(),started_at=now(),mode='offline' WHERE id=1",[portal]);}
test('outgoing webhook refreshes exported tasks one way and preserves concurrent local edits',async()=>{
 const inbound=await import('../server/bitrix-inbound.js');
 const id='8001',member='f'.repeat(32);
 const baseline={id,title:'Старая задача',description:'Из выгрузки',deadline:null,status:'active',
  assignee_id:employee.id,creator_id:admin.id,created_at:'2026-11-01T10:00:00.000Z'};
 const send=async(auth:Record<string,string>,taskId=id,ts='1793872800')=>api(admin,'/bitrix/events',{
  event:'ONTASKUPDATE',data:{FIELDS_AFTER:{ID:taskId}},ts,auth});
 const auth={domain:portal,member_id:member,application_token:'fixture-event-token-only'};
 const methods:BitrixMethod[]=[];
 const inboundRequest:BitrixRequest=Object.assign(async<T>(method:BitrixMethod):Promise<T>=>{
  methods.push(method);
  if(method==='user.get')return [{ID:'202',NAME:employee.name},{ID:'201',NAME:admin.name}] as T;
  assert.equal(method,'tasks.task.get');
  return {task:{...task(id),title:'Актуальная задача',description:'Из Битрикс24',createdDate:baseline.created_at}} as T;
 },{portal,mode:'webhook' as const});
 process.env.BITRIX_INBOUND_TASKS='true';
 try{
  await db.pool.query("UPDATE bitrix_event_capture SET enabled=true,portal=$1,member_id=NULL,mode='online' WHERE id=1",[portal]);
  await db.pool.query(`INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,deadline,status,priority,code,created_at,source_fields)
   VALUES($1,$2,$3,$4,$5,$6,NULL,'active','normal','ТЕСТ',$7,jsonb_build_object('ID',$1::text))`,
   [id,baseline.title,'Локальная правка',employee.branch_id,employee.id,admin.id,baseline.created_at]);
  await db.pool.query('INSERT INTO mock_provider_tasks(id,snapshot,revision) SELECT id,to_jsonb(tasks),version FROM tasks WHERE id=$1',[id]);
  await db.pool.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,'imported','Из выгрузки',$3)",[randomUUID(),id,JSON.stringify({initialSnapshot:baseline})]);
  await db.pool.query(`INSERT INTO staff_directory(id,source_key,name,name_key,organisation,department,emails,phones,bitrix_id,user_id)
   SELECT $1,$2,name,name,'Фикстура','Фикстура','{}','{}','202',id FROM users WHERE id=$3`,[randomUUID(),'fixture-inbound',employee.id]);
  await db.pool.query("INSERT INTO bitrix_user_links(user_id,external_id) VALUES($1,201)",[admin.id]);
  assert.equal((await send({...auth,application_token:'wrong'})).status,403);
  assert.equal((await db.pool.query('SELECT member_id FROM bitrix_event_capture WHERE id=1')).rows[0].member_id,null);
  assert.equal((await send(auth)).body.accepted,true);
  assert.equal((await send(auth)).body.accepted,false);
  assert.equal((await send({...auth,member_id:'a'.repeat(32)})).status,403);
  assert.equal((await send(auth,'9001')).body.ignored,true);
  assert.equal((await inbound.tickInboundTasks(inboundRequest))?.id,id);
  const result=(await db.pool.query("SELECT title,description,status,version,transfer_count FROM tasks WHERE id=$1",[id])).rows[0];
  assert.deepEqual(result,{title:'Актуальная задача',description:'Локальная правка',status:'completed',version:2,transfer_count:0});
  const link=(await db.pool.query('SELECT live_enabled,conflict FROM bitrix_task_links WHERE task_id=$1',[id])).rows[0];
  assert.equal(link.live_enabled,false);
  assert.match(link.conflict,/description/);
  assert.deepEqual(methods,['tasks.task.get','user.get']);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM bitrix_operations')).rows[0].n,0);
  assert.equal(await inbound.tickInboundTasks(inboundRequest),null);
 }finally{
  delete process.env.BITRIX_INBOUND_TASKS;
  await db.pool.query('DELETE FROM bitrix_task_links WHERE task_id=$1',[id]);
  await db.pool.query('DELETE FROM bitrix_user_links WHERE user_id=ANY($1)',[[admin.id,employee.id]]);
  await db.pool.query("DELETE FROM staff_directory WHERE source_key='fixture-inbound'");
 }
});
async function runFull(capture=false){
 if(capture)await configureCapture();const made=await archive.startInitialArchive(admin,portal,false);
 for(let i=0;i<20;i++){const result=await archive.tickInitialArchive(request,made.id,100);if(result.state==='captured')break;}
 return made.id;
}
async function api(actor:User,path:string,body?:unknown){const response=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{Cookie:cookies.get(actor.id)||'','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json() as any};}
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'ruspet-initial-'));process.env.BITRIX_PORTAL=portal;process.env.DEMO_AUTH='true';process.env.BITRIX_EVENT_TOKEN_FILE=join(directory,'event-token');await writeFile(process.env.BITRIX_EVENT_TOKEN_FILE,'fixture-event-token-only',{mode:0o600});
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;connection=new pg.Client({connectionString:current});await connection.connect();await connection.query('CREATE DATABASE '+database);await connection.query('CREATE DATABASE '+database+'_okb');const okbUrl=new URL(current);okbUrl.pathname='/'+database+'_okb';process.env.OKB_DATABASE_URL=okbUrl.toString();const url=new URL(current);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();
 db=await import('../server/db.js');await (await import('../scripts/migrate.js')).migrate();const seed=await import('../scripts/seed.js');await seed.seed();admin=seed.demoUsers.find(u=>u.id==='admin')!;employee=seed.demoUsers.find(u=>u.id==='anna')!;
 okb=await import('../server/okb.js');await okb.migrateOkb();archive=await import('../server/bitrix-archive.js');events=await import('../server/bitrix-events.js');refresh=await import('../server/bitrix-refresh.js');
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const actor of [admin,employee]){const response=await fetch(base+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:actor.id})});cookies.set(actor.id,response.headers.get('set-cookie')!.split(';')[0]);}
});
beforeEach(async()=>{
 await db.pool.query('TRUNCATE bitrix_archive_runs CASCADE');await db.pool.query('TRUNCATE bitrix_event_inbox,bitrix_refresh_queue,bitrix_offline_batches,bitrix_method_budget,bitrix_archive_blobs');await db.pool.query("UPDATE bitrix_event_capture SET enabled=false,verified_at=NULL,started_at=NULL,project_companies=false WHERE id=1");await db.pool.query("UPDATE bitrix_rest_gate SET portal=$1,next_at='epoch' WHERE id=1",[portal]);calls.length=0;failMethod=null;inject=null;missingTask=false;forbiddenTask=false;companyMissing=false;
});
after(async()=>{
 if(server)await new Promise<void>(r=>server.close(()=>r()));await okb?.closeOkb();await db?.pool.end();if(connection){await connection.query('DROP DATABASE IF EXISTS '+database);await connection.query('DROP DATABASE IF EXISTS '+database+'_okb');await connection.end();}if(directory)await rm(directory,{recursive:true,force:true});for(const key of ['BITRIX_PORTAL','DEMO_AUTH','BITRIX_EVENT_TOKEN_FILE','BITRIX_WEBHOOK_FILE','BITRIX_TRANSPORT','BITRIX_OAUTH_FILE','OKB_DATABASE_URL'])if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
});

test('resumable full archive preserves custom/multiple fields, closed tasks, all chat pages and every related section without modifying working tasks',async()=>{
 const before=(await db.pool.query('SELECT count(*)::int count FROM tasks')).rows[0].count,id=await runFull();
 const status=await archive.archiveStatus(admin,id);assert.equal(status.run.state,'captured');assert.deepEqual(status.issues,[]);assert.equal(status.complete,false);assert.equal(status.run.scope.includesClosed,true);
 const objects=(await db.pool.query('SELECT resource,count(*)::int count FROM bitrix_archive_objects WHERE run_id=$1 GROUP BY resource',[id])).rows;
 const count=(kind:string)=>objects.find(r=>r.resource===kind)?.count||0;assert.equal(count('users'),52);assert.equal(count('tasks'),2);assert.equal(count('task_comments'),202);assert.equal(count('company'),1);assert.equal(count('company_contacts'),1);assert.equal(count('task_results'),2);assert.equal(count('task_history'),2);assert.equal(count('smart:180'),1);assert.equal(count('file'),1);
 assert.equal((await db.pool.query('SELECT count(*)::int count FROM tasks')).rows[0].count,before);
 const raw=(await db.pool.query("SELECT raw FROM bitrix_archive_objects WHERE resource='tasks' AND external_id='8001'")).rows[0].raw;assert.equal(raw.status,'5');assert.deepEqual(raw.ufNested,{items:['Не терять пользовательские данные']});assert.deepEqual(raw.accomplices,['203']);
 const companyCall=calls.find(c=>c.method==='crm.company.list')!;assert(companyCall.params.select.includes('UF_MULTI'));assert(companyCall.params.select.includes('PHONE'));assert.equal(companyCall.params.start,-1);
 assert(calls.filter(c=>c.method==='user.get').length===2);assert(calls.some(c=>c.method==='im.dialog.messages.get'&&c.params.LAST_ID));assert(!calls.some(c=>/update|complete|approve|send/.test(c.method)));
});

test('quota errors leave the cursor unchanged, pause/resume retains saved data, blocked sections prevent readiness',async()=>{
 await configureCapture();const made=await archive.startInitialArchive(admin,portal,false);failMethod='tasks.task.list';
 for(let i=0;i<4;i++){await archive.tickInitialArchive(request,made.id,100);if((await db.pool.query("SELECT 1 FROM bitrix_archive_jobs WHERE run_id=$1 AND state='failed'",[made.id])).rowCount)break;}
 const job=(await db.pool.query("SELECT * FROM bitrix_archive_jobs WHERE run_id=$1 AND resource='tasks'",[made.id])).rows[0];assert.equal(job.state,'failed');assert.deepEqual(job.cursor,{});
 await archive.pauseArchive(admin,made.id);const previousCalls=calls.length;await archive.tickInitialArchive(request,made.id,10);assert.equal(calls.length,previousCalls);
 await archive.resumeArchive(admin,made.id);for(let i=0;i<10;i++)if((await archive.tickInitialArchive(request,made.id,100)).state==='captured')break;
 assert.deepEqual((await archive.archiveStatus(admin,made.id)).issues,[]);await refresh.tickEventRefresh(request,10);assert.equal((await archive.archiveStatus(admin,made.id)).complete,true);
});

test('malformed and duplicate pages never advance cursors or claim completeness',async()=>{
 const made=await archive.startInitialArchive(admin,portal,false);
 const bad:BitrixRequest=async<T>(method:BitrixMethod)=>method==='user.get'?[{ID:'2'},{ID:'1'}] as T:await request<T>(method,{});
 const job=(await db.pool.query("SELECT * FROM bitrix_archive_jobs WHERE run_id=$1 AND resource='users'",[made.id])).rows[0],run=(await db.pool.query('SELECT * FROM bitrix_archive_runs WHERE id=$1',[made.id])).rows[0];
 await assert.rejects(()=>archive.runArchiveJob(bad,run,job),/Порядок страницы/);assert.deepEqual((await db.pool.query('SELECT cursor FROM bitrix_archive_jobs WHERE id=$1',[job.id])).rows[0].cursor,{});
});

test('binary bootstrap downloads attached files with refreshed URLs and marks readiness only after file and event queues finish',async()=>{
 await configureCapture();const made=await archive.startInitialArchive(admin,portal,true),original=globalThis.fetch,savedDirectory=process.env.BITRIX_ARCHIVE_DIR;let downloads=0;
 process.env.BITRIX_ARCHIVE_DIR=join(directory,'pipeline-files');globalThis.fetch=async input=>{assert.equal(new URL(String(input)).hostname,portal);downloads++;return new Response('abc');};
 try{
  for(let i=0;i<10;i++)if((await archive.tickInitialArchive(request,made.id,100)).state==='captured')break;
  const blobs=(await db.pool.query('SELECT * FROM bitrix_archive_blobs')).rows;assert.equal(blobs.length,1);assert.equal(downloads,1);assert.equal(await readFile(blobs[0].path,'utf8'),'abc');assert(calls.filter(c=>c.method==='disk.file.get').length>=2);
  await refresh.tickEventRefresh(request);const status=await archive.archiveStatus(admin,made.id);assert.deepEqual(status.issues,[]);assert.equal(status.complete,true);
 }finally{globalThis.fetch=original;if(savedDirectory===undefined)delete process.env.BITRIX_ARCHIVE_DIR;else process.env.BITRIX_ARCHIVE_DIR=savedDirectory;}
});

test('missing chat permissions remain visible as a gap and cannot turn a partial import into a ready system',async()=>{
 await configureCapture();const made=await archive.startInitialArchive(admin,portal,false);
 const limited:BitrixRequest=async<T>(method:BitrixMethod,params:object)=>{if(method==='im.dialog.messages.get')throw new(await import('../server/bitrix-rest.js')).BitrixError('ACCESS_DENIED','rejected','ACCESS_DENIED');return request<T>(method,params);};
 for(let i=0;i<10;i++)if((await archive.tickInitialArchive(limited,made.id,100)).state==='captured')break;
 await refresh.tickEventRefresh(request);const status=await archive.archiveStatus(admin,made.id);assert.equal(status.complete,false);assert.equal(status.issues.filter(item=>item.resource==='task_comments').length,2);assert(status.issues.every(item=>item.state==='blocked'));
});

test('authenticated event endpoint persists sanitized form events, accepts new-card ID=0 and rejects forged portals and employee diagnostics',async()=>{
 await configureCapture();const body={event:'ONTASKCOMMENTADD',data:{FIELDS_AFTER:{ID:'0',TASK_ID:'8001',MESSAGE_ID:'99'}},ts:'1793872800',auth:{domain:portal,member_id:'fixture-member',application_token:'fixture-event-token-only',access_token:'never-store-this'}};
 const encoded=new URLSearchParams({'event':body.event,'data[FIELDS_AFTER][ID]':'0','data[FIELDS_AFTER][TASK_ID]':'8001','data[FIELDS_AFTER][MESSAGE_ID]':'99','ts':body.ts,'auth[domain]':portal,'auth[member_id]':'fixture-member','auth[application_token]':'fixture-event-token-only','auth[access_token]':'never-store-this'});
 const response=await fetch(base+'/api/bitrix/events',{method:'POST',body:encoded});assert.equal(response.status,200);assert.equal((await response.json() as any).accepted,true);
 assert.equal((await api(admin,'/bitrix/events',body)).body.accepted,false);assert.equal((await api(admin,'/bitrix/events',{...body,auth:{...body.auth,domain:'other.bitrix24.ru'}})).status,403);
 assert.equal((await api(employee,'/system/bitrix-archive')).status,403);assert.equal((await api(employee,'/system/selected-managers')).status,403);assert.equal((await api(admin,'/system/bitrix-archive')).status,200);
 const inbox=(await db.pool.query('SELECT * FROM bitrix_event_inbox')).rows;assert.equal(inbox.length,1);assert(!JSON.stringify(inbox).includes('never-store-this'));assert(!JSON.stringify(inbox).includes('fixture-event-token-only'));assert.equal((await db.pool.query("SELECT generation FROM bitrix_refresh_queue WHERE resource='task_comments'")).rows[0].generation,'1');
});

test('offline events are saved before acknowledgement; lost acknowledgements can be retried without losing or duplicating the local change',async()=>{
 await runFull(true);let get=0,clears=0,lose=true;
 const fixture:BitrixRequest=Object.assign(async<T>(method:BitrixMethod,params:any):Promise<T>=>{
  if(method==='event.offline.list')return [{ID:'1',PROCESS_ID:'recovered-process'}] as T;
  if(method==='event.offline.get'){get++;assert.equal(params.clear,0);assert.equal(params.process_id,'recovered-process');return {process_id:'recovered-process',events:[{ID:'1',EVENT_NAME:'ONTASKUPDATE',EVENT_DATA:{FIELDS_AFTER:{ID:'8001'}},TIMESTAMP_X:'2026-11-05T10:00:00Z',MESSAGE_ID:'a'.repeat(32)}]} as T;}
  if(method==='event.offline.clear'){clears++;assert.equal((await db.pool.query('SELECT count(*)::int count FROM bitrix_event_inbox')).rows[0].count,1);assert.deepEqual(params.message_id,['a'.repeat(32)]);if(lose){lose=false;throw Error('Lost fixture acknowledgement');}return true as T;}
  throw Error('Unexpected offline fixture method');
 },{mode:'application' as const,portal});
 await assert.rejects(()=>events.pullOfflineEvents(fixture),/Lost fixture/);assert.equal((await refresh.tickEventRefresh(request)).awaitingAck,true);
 await events.pullOfflineEvents(fixture);assert.equal(get,1);assert.equal(clears,2);assert.equal((await db.pool.query('SELECT state FROM bitrix_offline_batches')).rows[0].state,'acked');assert.equal((await db.pool.query("SELECT generation FROM bitrix_refresh_queue WHERE resource='task'")).rows[0].generation,'1');
});

test('event refresh fetches only the requested ID, survives a new event during fetch and distinguishes deletion from permission loss',async()=>{
 await runFull(true);await db.transaction(client=>events.queueRefresh(client,portal,'task','8001'));
 let injected=false;inject=async method=>{if(method==='tasks.task.get'&&!injected){injected=true;await db.transaction(client=>events.queueRefresh(client,portal,'task','8001'));}};
 calls.length=0;await refresh.tickEventRefresh(request,1);let queue=(await db.pool.query("SELECT * FROM bitrix_refresh_queue WHERE resource='task'")).rows[0];assert.equal(queue.done_generation,'1');assert.equal(queue.generation,'2');assert.equal(queue.state,'pending');assert(calls.every(c=>c.method==='tasks.task.get'&&c.params.taskId==='8001'));
 inject=null;await refresh.tickEventRefresh(request,1);queue=(await db.pool.query("SELECT * FROM bitrix_refresh_queue WHERE resource='task'")).rows[0];assert.equal(queue.state,'done');
 await db.transaction(client=>events.queueRefresh(client,portal,'task','8001'));forbiddenTask=true;await refresh.tickEventRefresh(request);assert.equal((await db.pool.query("SELECT deleted_at FROM bitrix_archive_objects WHERE resource='tasks' AND external_id='8001'")).rows[0].deleted_at,null);
 forbiddenTask=false;missingTask=true;await db.transaction(client=>events.queueRefresh(client,portal,'task','8001',true));await refresh.tickEventRefresh(request);assert((await db.pool.query("SELECT deleted_at FROM bitrix_archive_objects WHERE resource='tasks' AND external_id='8001'")).rows[0].deleted_at);
});

test('event subscription requires an application, reserves safe offline mode and verifies registration without duplicate binding',async()=>{
 await assert.rejects(()=>events.bindArchiveEvents(request,'offline'),/авторизация/);
 const bound:any[]=[];let binds=0;
 const app:BitrixRequest=Object.assign(async<T>(method:BitrixMethod,params:any):Promise<T>=>{
  if(method==='feature.get')return 'Y' as T;if(method==='event.get')return [...bound] as T;
  if(method==='event.bind'){assert.equal(params.event_type,'offline');bound.push({event:params.event,offline:1});binds++;return true as T;}throw Error('Unexpected subscription fixture');
 },{mode:'application' as const,portal,memberId:'fixture-member'});
 await events.bindArchiveEvents(app,'offline');const first=binds;await events.bindArchiveEvents(app,'offline');assert.equal(binds,first);assert.equal(first,events.requiredEvents.length);
 assert((await db.pool.query('SELECT verified_at FROM bitrix_event_capture')).rows[0].verified_at);
});

test('opted-in company projection applies only the changed company and preserves its record when Bitrix confirms deletion',async()=>{
 await runFull(true);
 await db.pool.query("INSERT INTO bitrix_user_links(user_id,external_id) VALUES('anna',202),('ivan',203)");
 const sync=await import('../server/company-responsibility.js');
 await sync.syncCompanySnapshots(admin,{portal,dryRun:false,companies:[{externalId:'1',name:'Тестовая компания',externalManagerId:'202',raw:{ID:'1',TITLE:'Тестовая компания',ASSIGNED_BY_ID:'202'}}]});
 const before=(await okb.okbPool().query('SELECT * FROM companies WHERE bitrix_id=1')).rows[0];assert.equal(before.manager_id,'anna');
 await db.pool.query('UPDATE bitrix_event_capture SET project_companies=true WHERE id=1');await db.transaction(client=>events.queueRefresh(client,portal,'company_one','1'));
 await refresh.tickEventRefresh(request,1,admin);let company=(await okb.okbPool().query('SELECT * FROM companies WHERE bitrix_id=1')).rows[0];assert.equal(company.manager_id,'ivan');assert.equal(company.id,before.id);
 companyMissing=true;await db.transaction(client=>events.queueRefresh(client,portal,'company_one','1',true));await refresh.tickEventRefresh(request,1,admin);company=(await okb.okbPool().query('SELECT * FROM companies WHERE bitrix_id=1')).rows[0];assert(company.bitrix_deleted_at);assert.equal(company.id,before.id);
 companyMissing=false;await db.transaction(client=>events.queueRefresh(client,portal,'company_one','1'));await refresh.tickEventRefresh(request,1,admin);company=(await okb.okbPool().query('SELECT * FROM companies WHERE bitrix_id=1')).rows[0];assert.equal(company.bitrix_deleted_at,null);assert.equal(company.id,before.id);
});

test('file archive verifies sizes and hashes, stores private files and refuses foreign redirects and mismatched bodies',async()=>{
 const {archiveFile}=await import('../server/bitrix-file-archive.js'),target=join(directory,'blobs');
 const result=await archiveFile(portal,{SIZE:'3',DOWNLOAD_URL:'https://'+portal+'/download'},{directory:target,fetcher:async()=>new Response('abc')});assert.equal(result.sha256,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');assert.equal((await stat(result.path)).mode&0o077,0);
 await assert.rejects(()=>archiveFile(portal,{SIZE:'4',DOWNLOAD_URL:'https://'+portal+'/download'},{directory:target,fetcher:async()=>new Response('abc')}),/размер|Размер/);
 await assert.rejects(()=>archiveFile(portal,{SIZE:'3',DOWNLOAD_URL:'https://'+portal+'/download'},{directory:target,fetcher:async()=>new Response(null,{status:302,headers:{Location:'https://untrusted.example/file'}})}),/хост/);
});

test('OAuth rotation saves both tokens atomically and an unknown refresh outcome cannot be blindly repeated',async()=>{
 const {applicationToken}=await import('../server/bitrix-oauth.js'),file=join(directory,'oauth.json'),credentials={portal,member_id:'fixture-member',client_id:'fixture-client',client_secret:'fixture-secret',access_token:'fixture-access',refresh_token:'fixture-refresh',expires:1};
 await writeFile(file,JSON.stringify(credentials),{mode:0o600});let count=0;
 const next=await applicationToken(file,portal,async()=>{count++;return Response.json({member_id:'fixture-member',client_endpoint:'https://'+portal+'/rest/',access_token:'rotated-access',refresh_token:'rotated-refresh',expires:Math.floor(Date.now()/1000)+3600});});assert.equal(next.refresh_token,'rotated-refresh');assert.equal((await stat(file)).mode&0o077,0);await applicationToken(file,portal,async()=>{count++;throw Error();});assert.equal(count,1);
 await writeFile(file,JSON.stringify(credentials));await assert.rejects(()=>applicationToken(file,portal,async()=>{throw Error('fixture transport');}),/не подтверждено/);await assert.rejects(()=>applicationToken(file,portal,async()=>{count++;throw Error();}),/Предыдущее/);assert.equal(count,1);
});

test('shared REST client exposes pagination and method operating budgets without freezing unrelated methods',async()=>{
 const original=globalThis.fetch,file=join(directory,'webhook');await writeFile(file,'https://'+portal+'/rest/1/fixture-key/',{mode:0o600});process.env.BITRIX_WEBHOOK_FILE=file;process.env.BITRIX_TRANSPORT='direct';delete process.env.BITRIX_OAUTH_FILE;
 let count=0;globalThis.fetch=async()=>{count++;return Response.json({result:[],next:50,time:{operating:350,operating_reset_at:Math.floor(Date.now()/1000)+120}});};
 try{
  const client=await (await import('../server/bitrix-rest.js')).bitrixClient();let next=0;await client('user.get',{},metadata=>{next=metadata.next!;});assert.equal(next,50);
  await assert.rejects(()=>client('user.get',{}),/ресурсоёмкости/);assert.equal(count,1);
  await db.pool.query("UPDATE bitrix_rest_gate SET next_at='epoch'");await client('crm.company.list',{});assert.equal(count,2);
 }finally{globalThis.fetch=original;}
});

test('selected pilot managers require exact unambiguous local profiles and confirmed external IDs without changing leaders or enabling writes',async()=>{
 const selected=await import('../server/pilot-selection.js');
 const expected=await selected.selectedPilotManagers(admin);assert.deepEqual(expected.map(p=>p.expected_name),['Виталий Шевченко','Александр Чекальский']);assert(expected.every(p=>!p.ready));
 await assert.rejects(()=>selected.applySelectedManagers(admin),/однозначных/);
 await db.pool.query("INSERT INTO users(id,name,role,branch_id,position) VALUES('pilot-fixture-a','Виталий Шевченко','employee','Фикстура',''),('pilot-fixture-b','Александр Чекальский','employee','Фикстура','')");
 await db.pool.query("INSERT INTO bitrix_user_links(user_id,external_id) VALUES('pilot-fixture-a',9202),('pilot-fixture-b',9203)");
 await db.pool.query("INSERT INTO bitrix_pilot_members(user_id,pilot_role) VALUES('director','leader')");
 const result=await selected.applySelectedManagers(admin);assert.equal(result.enabled,false);assert.deepEqual(result.managers,['pilot-fixture-a','pilot-fixture-b']);assert.equal((await db.pool.query("SELECT count(*)::int count FROM bitrix_pilot_members WHERE pilot_role='leader'")).rows[0].count,1);assert.equal((await db.pool.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0].enabled,false);
 await db.pool.query("INSERT INTO users(id,name,role,branch_id,position) VALUES('duplicate-pilot-fixture','Виталий Шевченко','employee','Фикстура','')");await assert.rejects(()=>selected.applySelectedManagers(admin),/однозначных/);
});
