import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import type {Server} from 'node:http';
// All fixtures and mutations are isolated in a newly created disposable database.
let server:Server,base:string,db:typeof import('../server/db.js'),service:typeof import('../server/service.js');
let adminConnection:pg.Client,users:typeof import('../scripts/seed.js').demoUsers;
const database='ruspet_test_'+randomBytes(6).toString('hex');
const cookies=new Map<string,string>();

test('bot leadership brief enforces role and uses only the managers visible tasks',async()=>{
 const {botView}=await import('../server/bot.js');
 const employee=users.find(u=>u.role==='employee')!,lead=users.find(u=>u.role==='branch_manager')!;
 await assert.rejects(()=>botView(employee,'preview',{op:'brief'}),/руководителям/);
 const employeeMenu=await botView(employee,'preview');assert(!employeeMenu.buttons.flat().some(b=>b.text.includes('Сводка команды')));
 const visible=await service.bootstrap(lead),brief=await botView(lead,'preview',{op:'brief'});
 assert(brief.text.includes('Всего задач: '+visible.tasks.length+'\n'));
 const {summarize}=await import('../shared/analytics.js');const s=summarize(visible.tasks,new Date(visible.serverTime));
 assert(brief.text.includes('Просрочены ранее: '+s.overdue+'\n'));
 const foreign=users.find(u=>u.role==='employee'&&u.branch_id!==lead.branch_id)!;
 assert(!brief.text.includes(foreign.name));
 assert(brief.buttons.flat().some(b=>b.text==='Архив отчётов'));
});
before(async()=>{
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 adminConnection=new pg.Client({connectionString:current});await adminConnection.connect();await adminConnection.query(`CREATE DATABASE ${database}`);
 const url=new URL(current);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();
 db=await import('../server/db.js');service=await import('../server/service.js');
 await (await import('../scripts/migrate.js')).migrate();const fixture=await import('../scripts/seed.js');users=fixture.demoUsers;await fixture.seed();
 const {createApp}=await import('../server/app.js');server=createApp().listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 for(const user of users){const r=await fetch(base+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user.id})});assert.equal(r.status,200);cookies.set(user.id,r.headers.get('set-cookie')!.split(';')[0]);}
});
after(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await db?.pool.end();if(adminConnection){await adminConnection.query(`DROP DATABASE IF EXISTS ${database}`);await adminConnection.end();}});
async function request(user:string,path:string,body?:unknown,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+'/api'+path,{method,headers:{Cookie:cookies.get(user)||'',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,data:await r.json()};
}
test('session required and cross-site writes rejected',async()=>{
 assert.equal((await fetch(base+'/api/bootstrap')).status,401);
 const r=await fetch(base+'/api/checks/run',{method:'POST',headers:{Cookie:cookies.get('director')!,Origin:'https://untrusted.example'}});assert.equal(r.status,403);
});
test('employee cannot view another branch task or run checks',async()=>{
 assert.equal((await request('anna','/tasks/2403')).status,404);
 assert.equal((await request('anna','/checks/run',{})).status,403);
 const result=await request('anna','/bootstrap');assert.ok(result.data.tasks.every((t:any)=>t.assignee_id==='anna'||t.creator_id==='anna'));
});
test('repeated checks do not create duplicate controls or deadline changes',async()=>{
 const count=async()=>Number((await db.pool.query('SELECT count(*) FROM control_requests')).rows[0].count);
 const before=await count();await service.runChecks(users[0]);await service.runChecks(users[0]);assert.equal(await count(),before);
 assert.equal(Number((await db.pool.query('SELECT sum(transfer_count) n FROM tasks')).rows[0].n),0);
});
test('two-step approval applies once; repeated decisions cannot transfer twice',async()=>{
 const a=(await db.pool.query("SELECT * FROM approvals WHERE task_id='2401'")).rows[0];
 assert.equal((await request('director',`/approvals/${a.id}/decision`,{decision:'approve'})).status,403);
 const results=await Promise.all([request('lead-msk',`/approvals/${a.id}/decision`,{decision:'approve'}),request('lead-msk',`/approvals/${a.id}/decision`,{decision:'approve'})]);assert.equal(results.filter(r=>r.status===200).length,1);
 assert.equal((await db.pool.query("SELECT transfer_count FROM tasks WHERE id='2401'")).rows[0].transfer_count,0);
 assert.equal((await request('head',`/approvals/${a.id}/decision`,{decision:'approve'})).data.state,'approved');
 assert.equal((await request('head',`/approvals/${a.id}/decision`,{decision:'approve'})).status,409);
 const task=(await db.pool.query("SELECT * FROM tasks WHERE id='2401'")).rows[0];assert.equal(task.transfer_count,1);assert.equal(task.version,2);assert.equal(task.deadline,a.proposed_deadline);
});
test('later leaves deadline unchanged; rejection ends route',async()=>{
 const a=(await db.pool.query("SELECT * FROM approvals WHERE task_id='2402'")).rows[0];
 assert.equal((await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'later'})).data.state,'pending');
 assert.ok((await db.pool.query('SELECT deferred_until FROM approvals WHERE id=$1',[a.id])).rows[0].deferred_until);
 assert.equal((await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'reject',comment:''})).data.state,'rejected');
 assert.equal((await db.pool.query("SELECT transfer_count FROM tasks WHERE id='2402'")).rows[0].transfer_count,0);
});
test('source change invalidates pending approval',async()=>{
 const a=(await db.pool.query("SELECT * FROM approvals WHERE task_id='2403'")).rows[0];
 assert.equal((await request('admin','/tasks/2403/mock-change',{expectedVersion:1})).status,200);
 assert.equal((await request('lead-kzn',`/approvals/${a.id}/decision`,{decision:'approve'})).status,409);
 assert.equal((await db.pool.query('SELECT state FROM approvals WHERE id=$1',[a.id])).rows[0].state,'stale');
});
test('explanations validate all fields, survive repeat checks, reject duplicate submission',async()=>{
 const c=(await db.pool.query("SELECT * FROM control_requests WHERE task_id='2405'")).rows[0];
 assert.equal((await request('anna',`/controls/${c.id}/answer`,{reason:'мало',progress:'мало',plan:'мало'})).status,400);
 const input={reason:'Ждём техническое заключение от клиента',progress:'Документы подготовлены и направлены клиенту',plan:'Уточнить параметры и подтвердить новый срок'};
 assert.equal((await request('anna',`/controls/${c.id}/answer`,input)).status,200);
 await service.runChecks(users[0]);assert.equal((await db.pool.query('SELECT state FROM control_requests WHERE id=$1',[c.id])).rows[0].state,'answered');
 assert.equal((await request('anna',`/controls/${c.id}/answer`,input)).status,409);
});
test('completion requires every route step',async()=>{
 const a=await request('anna','/tasks/2413/approvals',{type:'completion',reason:'Все действия по задаче выполнены полностью',plan:'Результат передан заказчику и проверен менеджером',expectedVersion:1});assert.equal(a.status,201);
 assert.equal((await request('lead-msk',`/approvals/${a.data.id}/decision`,{decision:'approve'})).status,200);
 assert.notEqual((await db.pool.query("SELECT status FROM tasks WHERE id='2413'")).rows[0].status,'completed');
 assert.equal((await request('director',`/approvals/${a.data.id}/decision`,{decision:'approve'})).data.state,'approved');
 assert.equal((await db.pool.query("SELECT status FROM tasks WHERE id='2413'")).rows[0].status,'completed');
});
test('report snapshot is immutable and same-day generation is idempotent',async()=>{
 const a=await service.makeReport(users[0]);const b=await service.makeReport(users[0]);assert.equal(a.id,b.id);assert.equal(a.rows.length,24);
 await assert.rejects(()=>db.pool.query('UPDATE reports SET metrics=$1 WHERE id=$2',['{}',a.id]),/append-only/);
 const branch=await service.makeReport(users.find(u=>u.id==='lead-msk')!);assert.ok(branch.rows.every((t:any)=>t.branch_id==='Москва'));
});
test('history and rule versions cannot be overwritten',async()=>{
 await assert.rejects(()=>db.pool.query("UPDATE task_events SET message='changed' WHERE id=(SELECT id FROM task_events LIMIT 1)"),/append-only/);
 const cfg=await service.config();await service.saveRules(users.find(u=>u.id==='admin')!,{...cfg.config,reminderMinutes:20},cfg.version);
 await assert.rejects(()=>service.saveRules(users.find(u=>u.id==='admin')!,cfg.config,cfg.version),/уже изменены/);
});
test('source parsing preserves Moscow timestamps, null flags and original status mapping',async()=>{
 const {sourceDate,sourceBoolean,sourceStatus}=await import('../scripts/import-source.js');
 assert.equal(sourceDate('2026-10-30 18:00:00'),'2026-10-30T15:00:00.000Z');assert.equal(sourceBoolean(null),null);assert.equal(sourceBoolean('нет'),false);assert.equal(sourceBoolean('Да'),true);assert.equal(sourceStatus('Ждёт контроля'),'review');assert.throws(()=>sourceStatus('Неизвестно'));
 const {moscowDay}=await import('../server/domain.js');assert.equal(moscowDay('2026-10-29T21:01:00Z'),'2026-10-30');
});

const taskInput={title:'РЗМ* Проверка локального процесса',description:'Результат должен пройти приёмку',assigneeId:'anna',deadline:'2026-11-10T15:00:00.000Z',plannedStart:null,plannedEnd:null,important:true,customerRisk:false,parentId:null};
test('local task edit protects deadline and version; review supports return and acceptance with complete history',async()=>{
 const created=await request('admin','/tasks',taskInput);assert.equal(created.status,201);const id=created.data.id;
 assert.equal((await request('anna',`/tasks/${id}`,{...taskInput,deadline:'2026-12-10T15:00:00.000Z',expectedVersion:1},'PUT')).status,400);
 assert.equal((await request('anna',`/tasks/${id}`,{...taskInput,description:'Уточнённое описание',expectedVersion:1},'PUT')).status,200);
 assert.equal((await request('anna',`/tasks/${id}`,{...taskInput,expectedVersion:1},'PUT')).status,409);
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Готовый результат приложен в описание',expectedVersion:2})).status,200);
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'accept',comment:'Свою работу принять нельзя',expectedVersion:3})).status,403);
 assert.equal((await request('director',`/tasks/${id}/review`,{action:'return',comment:'Исправьте расчёт суммы в результате',expectedVersion:3})).status,200);
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Расчёт исправлен, результат обновлён',expectedVersion:4})).status,200);
 assert.equal((await request('director',`/tasks/${id}/review`,{action:'accept',comment:'Результат проверен, замечаний нет',expectedVersion:5})).status,200);
 assert.equal((await request('director',`/tasks/${id}/review`,{action:'accept',comment:'Повторное нажатие',expectedVersion:5})).status,409);
 const d=(await request('anna',`/tasks/${id}`)).data;assert.equal(d.task.status,'completed');assert.equal(d.task.transfer_count,0);assert.equal(d.comments.length,4);assert.equal(d.events.filter((e:any)=>e.kind==='review_returned')[0].data.comment,'Исправьте расчёт суммы в результате');assert.equal(d.events.filter((e:any)=>e.kind==='task_completed').length,1);
});
test('hierarchy rejects cycles, assignment enforces scope and incoming dates are validated',async()=>{
 assert.equal((await request('anna','/tasks',{...taskInput,assigneeId:'ivan'})).status,403);
 assert.equal((await request('admin','/tasks',{...taskInput,plannedStart:'2026-11-10T15:00:00.000Z',plannedEnd:'2026-11-09T15:00:00.000Z'})).status,400);
 const first=(await request('admin','/tasks',taskInput)).data.id;const second=(await request('admin','/tasks',{...taskInput,parentId:first})).data.id;
 assert.equal((await request('admin',`/tasks/${first}`,{...taskInput,parentId:second,expectedVersion:1},'PUT')).status,400);
});
test('report archive retains distinct snapshots and retry returns same snapshot; external integrations stay off',async()=>{
 const input={kind:'snapshot',requestId:crypto.randomUUID()};const a=await request('director','/reports',input);const retry=await request('director','/reports',input);assert.equal(a.status,200);assert.equal(a.data.id,retry.data.id);
 const b=await request('director','/reports',{kind:'snapshot',requestId:crypto.randomUUID()});assert.notEqual(a.data.id,b.data.id);
 assert.equal((await request('anna',`/reports/${a.data.id}`)).status,404);assert.equal((await request('director',`/reports/${a.data.id}`)).data.rows.length,a.data.rows.length);
 assert.equal((await request('admin','/telegram/pairing',{})).status,409);assert.equal((await request('admin','/telegram/status')).data.mode,'disabled');
 const next=await request('director','/reports',{kind:'nextday'});assert.equal(next.status,200);assert.ok(next.data.rows.every((t:any)=>t.status==='active'));
});

test('analytical reports freeze employee names, comparison and escaped printable content',async()=>{
 const director=users.find(u=>u.id==='director')!;
 const a=await service.makeReport(director,'snapshot','analysis-first');
 const created=await request('admin','/tasks',{...taskInput,title:'РЗМ* <script>alert(1)</script> & отчёт'});assert.equal(created.status,201);
 const b=await service.makeReport(director,'snapshot','analysis-second');assert.equal(b.analysis.comparison.entered,1);assert.equal(b.analysis.comparison.id,a.id);assert.equal(b.analysis.counts.total,b.rows.length);
 const print=await fetch(base+`/api/reports/${b.id}/print`,{headers:{Cookie:cookies.get('director')!}});assert.equal(print.status,200);const html=await print.text();assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.ok(!html.includes('<script>'));
 assert.equal((await fetch(base+`/api/reports/${b.id}/print`,{headers:{Cookie:cookies.get('anna')!}})).status,404);
 await db.pool.query("UPDATE users SET name='Имя изменено после отчёта' WHERE id='anna'");const frozen=await service.getReport(director,b.id);assert.notEqual(frozen.analysis.team.find((u:any)=>u.id==='anna').name,'Имя изменено после отчёта');
});
test('automatic reports: baseline, morning and evening survive repeats and partial failure without duplicates',async()=>{
 const {tick,saveAutomation,operationsStatus}=await import('../server/automation.js');
 const admin=users.find(u=>u.id==='admin')!;await saveAutomation(admin,{enabled:true,morning:'09:00',evening:'18:00'});
 const monday=new Date('2026-11-02T09:01:00+03:00');await tick(monday);
 const count=async()=>Number((await db.pool.query("SELECT count(*) n FROM reports WHERE day='2026-11-02' AND slot LIKE 'scheduled-%'")).rows[0].n);
 assert.equal(await count(),5);await tick(monday);assert.equal(await count(),5);
 await db.pool.query("UPDATE job_runs SET state='failed',attempts=1,retry_at=NULL WHERE job_key='morning:2026-11-02'");await tick(monday);assert.equal(await count(),5);
 await tick(new Date('2026-11-02T18:01:00+03:00'));assert.equal(await count(),7);
 const run=(await db.pool.query("SELECT * FROM job_runs WHERE job_key='morning:2026-11-02'")).rows[0];assert.equal(run.state,'done');assert.equal(run.report_ids.length,4);assert.equal(run.attempts,2);
 assert.equal((await operationsStatus()).alive,true);assert.equal((await request('anna','/operations')).status,403);
 await saveAutomation(admin,{enabled:false,morning:'09:00',evening:'18:00'});await tick(new Date('2026-11-03T20:00:00+03:00'));assert.equal(Number((await db.pool.query("SELECT count(*) n FROM reports WHERE day='2026-11-03' AND slot LIKE 'scheduled-%'")).rows[0].n),0);
});
test('partial morning report failure resumes saved package, and interrupted third attempt becomes actionable',async()=>{
 const {tick,saveAutomation}=await import('../server/automation.js');const admin=users.find(u=>u.id==='admin')!;
 await saveAutomation(admin,{enabled:true,morning:'09:00',evening:'18:00'});
 await db.pool.query("ALTER TABLE reports ADD CONSTRAINT test_report_failure CHECK (NOT(day='2026-11-04' AND slot='scheduled-morning' AND kind='review'))");
 const at=new Date('2026-11-04T09:01:00+03:00');await tick(at);
 const count=async()=>Number((await db.pool.query("SELECT count(*) n FROM reports WHERE day='2026-11-04' AND slot='scheduled-morning'")).rows[0].n);
 assert.equal(await count(),3);assert.equal((await db.pool.query("SELECT state FROM job_runs WHERE job_key='morning:2026-11-04'")).rows[0].state,'failed');
 await db.pool.query('ALTER TABLE reports DROP CONSTRAINT test_report_failure');await db.pool.query("UPDATE job_runs SET retry_at=NULL WHERE job_key='morning:2026-11-04'");await tick(at);assert.equal(await count(),4);
 await db.pool.query("INSERT INTO job_runs(job_key,state,attempts) VALUES('morning:2026-11-05','running',3)");await tick(new Date('2026-11-05T09:01:00+03:00'));
 assert.equal((await db.pool.query("SELECT state FROM job_runs WHERE job_key='morning:2026-11-05'")).rows[0].state,'failed');
 await saveAutomation(admin,{enabled:false,morning:'09:00',evening:'18:00'});
});
test('archive searches all stored days, paginates without duplicate rows and enforces scope',async()=>{
 const available=Number((await db.pool.query("SELECT count(*) n FROM reports WHERE scope='company'")).rows[0].n);for(let i=available;i<21;i++)await service.makeReport(users.find(u=>u.id==='director')!,'snapshot','pagination-'+i);
 const first=await request('director','/reports?page=0');assert.equal(first.status,200);assert.ok(first.data.total>20);assert.equal(first.data.items.length,20);assert.ok(first.data.items.every((r:any)=>!r.rows));
 const second=await request('director','/reports?page=1');const ids=new Set(first.data.items.map((r:any)=>r.id));assert.ok(second.data.items.every((r:any)=>!ids.has(r.id)));
 const filtered=await request('director','/reports?kind=review&from=2026-11-04&to=2026-11-04');assert.equal(filtered.data.total,1);
 assert.equal((await request('anna','/reports')).data.total,0);assert.equal((await request('director','/reports?from=2026-11-05&to=2026-11-04')).status,400);
});

const botButton=(view:any,label:string)=>{const b=view.buttons.flat().find((b:any)=>b.text===label);assert.ok(b,'Button missing: '+label);return b.token as string};
test('bot result → return → resubmission → acceptance shares panel history and ignores repeated confirmation',async()=>{
 const bot=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!,director=users.find(u=>u.id==='director')!;
 const id=(await request('admin','/tasks',taskInput)).data.id;
 async function enter(user:typeof anna,label:string,text:string){let v=await bot.botView(user,'preview',{op:'task',id});v=await bot.botClick(user,'preview',botButton(v,label));v=await bot.botText(user,'preview',text,crypto.randomUUID());return botButton(v,'Подтвердить и отправить')}
 const confirmation=await enter(anna,'Сдать результат','Результат готов: расчёт и ссылка на документы');
 const receipts=await Promise.all([bot.botClick(anna,'preview',confirmation),bot.botClick(anna,'preview',confirmation)]);assert.deepEqual(receipts[0],receipts[1]);
 assert.equal((await request('anna',`/tasks/${id}`)).data.submissions.length,1);
 await bot.botClick(director,'preview',await enter(director,'Вернуть с замечаниями','Исправьте сумму в третьей строке расчёта'));
 let d=(await request('anna',`/tasks/${id}`)).data;assert.equal(d.submissions[0].state,'returned');
 const actions=(await import('../shared/actions.js')).actionItems((await request('anna','/bootstrap')).data);assert.ok(actions.some(a=>a.taskId===id&&a.kind==='rework'&&a.mine));
 await bot.botClick(anna,'preview',await enter(anna,'Отправить доработку','Сумма исправлена, обновлённый расчёт готов'));
 await bot.botClick(director,'preview',await enter(director,'Принять результат','Проверено, замечания устранены полностью'));
 d=(await request('anna',`/tasks/${id}`)).data;assert.equal(d.task.status,'completed');assert.equal(d.submissions.length,2);assert.equal(d.submissions[0].state,'accepted');assert.equal(d.submissions[1].state,'returned');
 await assert.rejects(()=>db.pool.query("UPDATE task_submissions SET result='rewritten' WHERE task_id=$1",[id]),/immutable/);
});
test('bot cancels drafts, rejects foreign buttons and rolls back business action when receipt cannot be stored',async()=>{
 const bot=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!,id=(await request('admin','/tasks',taskInput)).data.id;
 let v=await bot.botView(anna,'preview',{op:'task',id});const begin=botButton(v,'Сдать результат');await assert.rejects(()=>bot.botClick(users.find(u=>u.id==='director')!,'preview',begin),/Кнопка устарела/);
 await bot.botClick(anna,'preview',begin);v=await bot.botText(anna,'preview','Готовый результат для проверки отмены',crypto.randomUUID());const canceled=botButton(v,'Подтвердить и отправить');await bot.botClick(anna,'preview',botButton(v,'Отмена'));await assert.rejects(()=>bot.botClick(anna,'preview',canceled),/отменён/);
 await bot.botClick(anna,'preview',begin);const inputId=crypto.randomUUID();v=await bot.botText(anna,'preview','Результат должен сохраниться только один раз',inputId);assert.deepEqual(await bot.botText(anna,'preview','Результат должен сохраниться только один раз',inputId),v);const confirm=botButton(v,'Подтвердить и отправить');
 await db.pool.query('ALTER TABLE bot_buttons ADD CONSTRAINT test_receipt_failure CHECK (receipt IS NULL) NOT VALID');await assert.rejects(()=>bot.botClick(anna,'preview',confirm));await db.pool.query('ALTER TABLE bot_buttons DROP CONSTRAINT test_receipt_failure');
 let d=(await request('anna',`/tasks/${id}`)).data;assert.equal(d.task.status,'active');assert.equal(d.submissions.length,0);
 await bot.botClick(anna,'preview',confirm);d=(await request('anna',`/tasks/${id}`)).data;assert.equal(d.task.status,'review');assert.equal(d.submissions.length,1);
});
test('old approval stage cannot approve the next stage even when both stages share the same person',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;const cfg=await service.config();await service.saveRules(users.find(u=>u.id==='admin')!,{...cfg.config,routes:{...cfg.config.routes,deadline:['branchManager','branchManager']}},cfg.version);
 const a=await service.requestApproval(users.find(u=>u.id==='anna')!,id,{type:'deadline',reason:'Требуется дополнительное время для проверки',plan:'Перепроверить расчёты и направить окончательный результат',proposedDeadline:new Date(Date.now()+86400000*10).toISOString(),expectedVersion:1});
 const lead=users.find(u=>u.id==='lead-msk')!;await service.decide(lead,a.id,{decision:'approve',comment:'Первый этап',expectedStep:0});await assert.rejects(()=>service.decide(lead,a.id,{decision:'approve',comment:'Старая кнопка',expectedStep:0}),/этап уже завершён/);
 assert.equal((await db.pool.query('SELECT transfer_count FROM tasks WHERE id=$1',[id])).rows[0].transfer_count,0);
});
test('personal Telegram transport ignores strangers and pairing cannot replace the sole bound chat',async()=>{
 const pilot=await import('../server/telegram-pilot.js'),originalFetch=globalThis.fetch,previousToken=process.env.TELEGRAM_BOT_TOKEN;process.env.TELEGRAM_BOT_TOKEN='TEST_TOKEN';const sends:unknown[]=[];
 globalThis.fetch=async(input,init)=>{const url=String(input);if(url.startsWith('https://api.telegram.org/')){if(url.endsWith('/sendMessage'))sends.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({ok:true,result:url.endsWith('/getMe')?{username:'test_bot'}:url.endsWith('/getWebhookInfo')?{url:''}:{message_id:1}}),{status:200})}return originalFetch(input,init)};
 try{
 const admin=users.find(u=>u.id==='admin')!;await pilot.configurePilot(admin,{enabled:true,delivery:false});
 await pilot.handlePilotUpdate({update_id:1,message:{chat:{id:100,type:'private'},text:'/start'}});assert.equal(sends.length,0);
 const link=await pilot.pairPilot(admin),code=new URL(link.url).searchParams.get('start');await pilot.handlePilotUpdate({update_id:2,message:{chat:{id:100,type:'private'},text:'/start '+code}});assert.equal(sends.length,1);
 const next=await pilot.pairPilot(admin);await pilot.handlePilotUpdate({update_id:3,message:{chat:{id:200,type:'private'},text:'/start '+new URL(next.url).searchParams.get('start')}});assert.equal(sends.length,1);assert.equal((await db.pool.query('SELECT chat_id FROM telegram_binding')).rows[0].chat_id,'100');
 }finally{globalThis.fetch=originalFetch;if(previousToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=previousToken;await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');}
});
