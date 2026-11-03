import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {hashPassword} from '../server/passwords.js';
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
 assert.equal((await request('director',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'})).status,403);
 const results=await Promise.all([request('lead-msk',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'}),request('lead-msk',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'})]);assert.equal(results.filter(r=>r.status===200).length,1);
 assert.equal((await db.pool.query("SELECT transfer_count FROM tasks WHERE id='2401'")).rows[0].transfer_count,0);
 assert.equal((await request('head',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'})).data.state,'approved');
 assert.equal((await request('head',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'})).status,409);
 const task=(await db.pool.query("SELECT * FROM tasks WHERE id='2401'")).rows[0];assert.equal(task.transfer_count,1);assert.equal(task.version,2);assert.equal(task.deadline,a.proposed_deadline);
});
test('later leaves deadline unchanged; rejection ends route',async()=>{
 const a=(await db.pool.query("SELECT * FROM approvals WHERE task_id='2402'")).rows[0];
 assert.equal((await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'later'})).data.state,'pending');
 assert.ok((await db.pool.query('SELECT deferred_until FROM approvals WHERE id=$1',[a.id])).rows[0].deferred_until);
 assert.equal((await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'reject',comment:''})).status,400);
 assert.equal((await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'reject',comment:'Недостаточное обоснование нового срока'})).data.state,'rejected');
 assert.equal((await db.pool.query("SELECT transfer_count FROM tasks WHERE id='2402'")).rows[0].transfer_count,0);
});
test('source change invalidates pending approval',async()=>{
 const a=(await db.pool.query("SELECT * FROM approvals WHERE task_id='2403'")).rows[0];
 assert.equal((await request('admin','/tasks/2403/mock-change',{expectedVersion:1})).status,200);
 assert.equal((await request('lead-kzn',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'})).status,409);
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
 assert.equal((await request('lead-msk',`/approvals/${a.data.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'})).status,200);
 assert.notEqual((await db.pool.query("SELECT status FROM tasks WHERE id='2413'")).rows[0].status,'completed');
 assert.equal((await request('director',`/approvals/${a.data.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'})).data.state,'approved');
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
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,reason:'Изменение по результатам проверки',deadline:'2026-12-10T15:00:00.000Z',expectedVersion:1},'PUT')).status,400);
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,reason:'Уточнение требований к результату',description:'Уточнённое описание',expectedVersion:1},'PUT')).status,200);
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,reason:'Попытка изменения старой версии',expectedVersion:1},'PUT')).status,409);
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
 assert.equal((await request('admin',`/tasks/${first}`,{...taskInput,reason:'Проверка защиты от циклов',parentId:second,expectedVersion:1},'PUT')).status,400);
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
 await tick(new Date('2026-11-02T18:01:00+03:00'));assert.equal(await count(),6);assert.equal((await db.pool.query("SELECT count(*)::int n FROM reports WHERE day='2026-11-02' AND slot='scheduled-evening' AND kind='nextday'")).rows[0].n,0);
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
 const available=Number((await db.pool.query("SELECT count(*) n FROM reports WHERE scope='company' AND kind<>'nextday'")).rows[0].n);for(let i=available;i<21;i++)await service.makeReport(users.find(u=>u.id==='director')!,'snapshot','pagination-'+i);
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

test('excluded routines stay in storage but disappear from tasks, checks, reports and bot access',async()=>{
 const {createTask}=await import('../server/workflow.js');const {botView}=await import('../server/bot.js');
 const admin=users.find(u=>u.id==='admin')!;
 const before=await service.bootstrap(admin),hidden:string[]=[];
 for(const title of ['ЕЗМ* Свериться с УТРЕННИМ чек-листом','ЕЗМ* Займись анализом невыполненных задач за сегодня']){
  const t=await createTask(admin,{title,description:'Служебная задача',assigneeId:'anna',deadline:'2026-01-01T10:00:00Z',plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null});hidden.push(t.id);
  await service.notify(db.pool,t.id,admin.id,'Старое уведомление','excluded-test:'+t.id);
 }
 const current=await service.bootstrap(admin);assert.equal(current.tasks.length,before.tasks.length);assert.equal(current.selection!.checklist,before.selection!.checklist+1);assert.equal(current.selection!.unfinishedAnalysis,before.selection!.unfinishedAnalysis+1);
 assert(!current.notifications.some(n=>hidden.includes(n.task_id||'')));
 await service.runChecks(admin);assert.equal((await db.pool.query('SELECT count(*)::int n FROM control_requests WHERE task_id=ANY($1)',[hidden])).rows[0].n,0);
 const report=await service.makeReport(admin,'snapshot','selection-test');assert(!report.rows.some((t:{id:string})=>hidden.includes(t.id)));
 for(const id of hidden){await assert.rejects(()=>service.detail(admin,id),/недоступна/);await assert.rejects(()=>botView(admin,'preview',{op:'task',id}),/недоступна/);}
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM tasks WHERE id=ANY($1)',[hidden])).rows[0].n,2);
});

test('individual accounts require password, support two sessions and hide demo role switching',async()=>{
 await db.pool.query('INSERT INTO login_accounts(username,user_id,password_hash) VALUES($1,$2,$3),($4,$5,$6)',['panel-admin','admin',await hashPassword('Simple-phrase-2026'),'panel-director','director',await hashPassword('Another-phrase-2026')]);
 const previous=process.env.DEMO_AUTH;process.env.DEMO_AUTH='false';
 try{
  assert.equal((await fetch(base+'/api/demo/users')).status,403);
  const login=async(username:string,password:string)=>fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  assert.equal((await login('panel-admin','wrong')).status,401);
  const first=await login('panel-admin','Simple-phrase-2026'),second=await login('panel-director','Another-phrase-2026');assert.equal(first.status,200);assert.equal(second.status,200);
  const a=first.headers.get('set-cookie')!.split(';')[0],b=second.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await (await fetch(base+'/api/auth/me',{headers:{Cookie:a}})).json()).id,'admin');
  assert.equal((await (await fetch(base+'/api/auth/me',{headers:{Cookie:b}})).json()).id,'director');
  assert.equal((await fetch(base+'/api/auth/logout',{method:'POST',headers:{Cookie:a}})).status,200);
  assert.equal((await fetch(base+'/api/auth/me',{headers:{Cookie:a}})).status,401);
  assert.equal((await fetch(base+'/api/auth/me',{headers:{Cookie:b}})).status,200);
 }finally{if(previous===undefined)delete process.env.DEMO_AUTH;else process.env.DEMO_AUTH=previous;}
});
test('clarification stays on the same approval stage until requester replies',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 const a=await service.requestApproval(users.find(u=>u.id==='anna')!,id,{type:'deadline',reason:'Нужен срок для проверки результата',plan:'Проверить данные и представить итоговый отчёт',proposedDeadline:new Date(Date.now()+86400000*10).toISOString(),expectedVersion:1});
 const path=`/approvals/${a.id}`;
 assert.equal((await request('lead-msk',path+'/decision',{decision:'clarify',comment:'Какие данные уже проверены?',expectedStep:0})).status,200);
 assert.equal((await request('lead-msk',path+'/decision',{decision:'approve',comment:'Согласовано после уточнения',expectedStep:0})).status,409);
 assert.equal((await request('director',path+'/clarification',{answer:'Ответ другого человека'})).status,403);
 assert.equal((await request('anna',path+'/clarification',{answer:'Проверены строки исходной выгрузки'})).status,200);
 assert.equal((await request('anna',path+'/clarification',{answer:'Повторный ответ'})).status,409);
 assert.equal((await request('lead-msk',path+'/decision',{decision:'approve',comment:'Согласовано после уточнения',expectedStep:0})).status,200);
 const detail=(await request('anna',`/tasks/${id}`)).data;
 assert(detail.comments.some((c:any)=>c.kind==='clarification'));
 assert.equal(detail.approvals[0].current_step,1);
});
test('task review requires a comment for both acceptance and return',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Готовый результат передан',expectedVersion:1})).status,200);
 assert.equal((await request('director',`/tasks/${id}/review`,{action:'return',comment:'',expectedVersion:2})).status,400);
 assert.equal((await request('director',`/tasks/${id}/review`,{action:'accept',comment:'',expectedVersion:2})).status,400);
 assert.equal((await request('director',`/tasks/${id}/review`,{action:'accept',comment:'Результат проверен и принят',expectedVersion:2})).status,200);
});
test('bot search finds a visible task by number or title and keeps access scope',async()=>{
 const {botView}=await import('../server/bot.js');const anna=users.find(u=>u.id==='anna')!;
 const own=(await service.bootstrap(anna)).tasks[0];
 const found=await botView(anna,'preview',{op:'search',query:own.id});assert(found.text.includes('#'+own.id));
 const foreign=await botView(anna,'preview',{op:'search',query:'2403'});assert(!foreign.text.includes('#2403'));
});
test('director may submit and request a deadline for a visible employee task with own audit identity',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 const proposed=new Date(Date.now()+86400000*12).toISOString();
 assert.equal((await request('director',`/tasks/${id}/approvals`,{type:'deadline',reason:'Изменён срок работы сотрудника',plan:'Проверить материалы и завершить задачу',proposedDeadline:proposed,expectedVersion:1})).status,201);
 const approval=(await db.pool.query("SELECT requester_id FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rows[0];assert.equal(approval.requester_id,'director');
});
test('bot requires a review comment and applies acceptance only after confirmation',async()=>{
 const {botView,botClick,botText}=await import('../server/bot.js');const director=users.find(u=>u.id==='director')!;
 const id=(await request('admin','/tasks',taskInput)).data.id;
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Результат работы передан',expectedVersion:1})).status,200);
 const view=await botView(director,'preview',{op:'task',id});assert(!view.buttons.flat().some(b=>b.text.includes('без комментария')));
 await botClick(director,'preview',botButton(view,'Принять результат'));
 await assert.rejects(()=>botText(director,'preview','да',crypto.randomUUID()),/от 5/);
 const confirm=await botText(director,'preview','Результат проверен и принят',crypto.randomUUID());
 assert.equal((await request('director',`/tasks/${id}`)).data.task.status,'review');
 await botClick(director,'preview',botButton(confirm,'Подтвердить и отправить'));
 const detail=(await request('director',`/tasks/${id}`)).data;assert.equal(detail.task.status,'completed');assert.equal(detail.submissions[0].remark,'Результат проверен и принят');
});

test('task editing is restricted to creator or scoped manager; bot edits are versioned, audited and confirmed once',async()=>{
 const {botView,botClick,botText}=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!,admin=users.find(u=>u.id==='admin')!;
 const foreign=(await request('admin','/tasks',taskInput)).data.id;
 assert.equal((await request('anna',`/tasks/${foreign}`,{...taskInput,expectedVersion:1,reason:'Попытка изменить чужую постановку'},'PUT')).status,403);
 assert(!((await botView(anna,'preview',{op:'task',id:foreign})).buttons.flat().some(b=>b.text==='Редактировать задачу')));
 const id=(await request('anna','/tasks',{...taskInput,assigneeId:'anna'})).data.id;
 let view=await botView(anna,'preview',{op:'edit',id});await botClick(anna,'preview',botButton(view,'Название'));
 await botText(anna,'preview','РЗМ* Новое название через бот',crypto.randomUUID());
 view=await botText(anna,'preview','Уточнение предмета и результата задачи',crypto.randomUUID());
 assert.equal((await service.detail(anna,id)).task.version,1);
 const confirm=botButton(view,'Подтвердить и отправить');await botClick(anna,'preview',confirm);await botClick(anna,'preview',confirm);
 let detail=await service.detail(anna,id);assert.equal(detail.task.version,2);assert.equal(detail.task.title,'РЗМ* Новое название через бот');assert.equal(detail.events.filter(e=>e.kind==='task_edited').length,1);assert.equal(detail.events[0].data.reason,'Уточнение предмета и результата задачи');
 view=await botView(anna,'preview',{op:'edit',id});await botClick(anna,'preview',botButton(view,'Описание'));await botText(anna,'preview','Описание ожидаемого результата',crypto.randomUUID());view=await botText(anna,'preview','Уточнение содержания работы для исполнителя',crypto.randomUUID());const stale=botButton(view,'Подтвердить и отправить');
 const t=detail.task;assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,title:t.title,description:'Новая версия руководителя',expectedVersion:2,reason:'Параллельная правка руководителя'},'PUT')).status,200);
 await assert.rejects(()=>botClick(anna,'preview',stale),/Задача изменилась/);
 view=await botView(anna,'preview',{op:'assignee_list',id});const name=(await db.pool.query("SELECT name FROM users WHERE id='ivan'")).rows[0].name;while(!view.buttons.flat().some(b=>b.text===name))view=await botClick(anna,'preview',botButton(view,'Далее →'));const person=botButton(view,name);
 view=await botClick(anna,'preview',person);await botClick(anna,'preview',botButton(view,'Указать причину'));view=await botText(anna,'preview','Оставляем исполнителя после проверки',crypto.randomUUID());await botClick(anna,'preview',botButton(view,'Подтвердить и отправить'));
 detail=await service.detail(admin,id);assert.equal(detail.task.assignee_id,'ivan');assert.equal(detail.task.version,4);
 assert.equal((await request('anna',`/tasks/${id}`,{...taskInput,expectedVersion:4,deadline:new Date(Date.now()+20*86400000).toISOString(),reason:'Прямой перенос без согласования'},'PUT')).status,400);
 const queue=(await db.pool.query('SELECT task_version FROM task_sync_queue WHERE task_id=$1 ORDER BY task_version',[id])).rows;assert.deepEqual(queue.map(r=>r.task_version),[1,2,3,4]);
});

test('written rules reject unsupported prose and check every task; planning checks follow the display setting',async()=>{
 const {evaluate}=await import('../server/domain.js'),{parseWrittenRule}=await import('../shared/written-rules.js');const admin=users.find(u=>u.id==='admin')!;
 const id=(await request('anna','/tasks',{...taskInput,title:'Без буквенного кода',assigneeId:'anna',description:'Кратко'})).data.id;const task=(await service.detail(admin,id)).task;
 const cfg=await service.config();const rules={...cfg.config,showPlanning:false,planning:true,plannedOverdue:true,writtenRules:[{text:'В задаче всегда должен быть буквенный код',severity:'critical' as const},{text:'Описание задачи должно содержать не менее 30 символов',severity:'warning' as const}]};
 await service.saveRules(admin,rules,cfg.version);const findings=evaluate(task,rules);assert(findings.some(f=>f.rule==='written:0'&&f.severity==='critical'));assert(findings.some(f=>f.rule==='written:1'));assert(!findings.some(f=>f.rule==='missing_plan_start'));assert(evaluate(task,{...rules,showPlanning:true}).some(f=>f.rule==='missing_plan_start'));
 const next=await service.config();await assert.rejects(()=>service.saveRules(admin,{...rules,writtenRules:[{text:'Пусть задача будет хорошей',severity:'warning'}]},next.version),/Неизвестная формулировка/);assert.equal(parseWrittenRule('Если клиент важный — сделать срочно'),null);
 await service.runChecks(admin);assert((await service.bootstrap(admin)).findings.some(f=>f.task_id===id&&f.rule==='written:0'));
 await service.saveRules(admin,cfg.config,next.version);
});

test('task reminder schedules validate days, times, recipient and duration; due slots deduplicate and stop after selected weeks',async()=>{
 const reminders=await import('../server/reminders.js'),anna=users.find(u=>u.id==='anna')!,admin=users.find(u=>u.id==='admin')!;
 const id=(await request('admin','/tasks',taskInput)).data.id;
 for(const value of [{days:[]},{times:['24:00']},{times:['09:00','09:00']},{weeks:0},{days:[8]}])assert.equal((await request('anna',`/tasks/${id}/reminders`,{recipientId:'anna',days:[1,3],times:['10:00','14:00'],weeks:3,...value})).status,400);
 assert.equal((await request('anna',`/tasks/${id}/reminders`,{recipientId:'director',days:[1],times:['10:00'],weeks:3})).status,403);
 const r=await request('admin',`/tasks/${id}/reminders`,{recipientId:'anna',days:[1,3],times:['10:00','14:00'],weeks:3});assert.equal(r.status,201);
 const repeated=await request('admin',`/tasks/${id}/reminders`,{recipientId:'anna',days:[3,1],times:['14:00','10:00'],weeks:3});assert.equal(repeated.data.id,r.data.id);
 await db.pool.query("UPDATE task_reminders SET start_date='2035-01-01',created_at='2034-12-31T00:00:00Z' WHERE id=$1",[r.data.id]);await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=true');
 try{
  await reminders.tickTaskReminders(new Date('2035-01-01T09:59:00+03:00'));assert.equal((await db.pool.query('SELECT count(*)::int n FROM task_alerts WHERE reminder_id=$1',[r.data.id])).rows[0].n,0);
  await Promise.all([reminders.tickTaskReminders(new Date('2035-01-01T14:00:00+03:00')),reminders.tickTaskReminders(new Date('2035-01-01T14:00:00+03:00'))]);
  let alerts=(await db.pool.query('SELECT * FROM task_alerts WHERE reminder_id=$1',[r.data.id])).rows;assert.equal(alerts.length,2);
  await assert.rejects(()=>reminders.acknowledgeAlert(admin,alerts[0].id),/недоступно/);await reminders.acknowledgeAlert(anna,alerts[0].id);await reminders.acknowledgeAlert(anna,alerts[0].id);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM task_events WHERE kind='reminder_acknowledged' AND data->>'alertId'=$1",[alerts[0].id])).rows[0].n,1);
  assert.equal((await service.detail(anna,id)).task.status,'active');
  await reminders.tickTaskReminders(new Date('2035-01-03T14:00:00+03:00'));assert.equal((await db.pool.query('SELECT count(*)::int n FROM task_alerts WHERE reminder_id=$1',[r.data.id])).rows[0].n,4);
  await reminders.tickTaskReminders(new Date('2035-01-22T14:00:00+03:00'));assert.equal((await db.pool.query('SELECT count(*)::int n FROM task_alerts WHERE reminder_id=$1',[r.data.id])).rows[0].n,4);
  await reminders.disableTaskReminder(anna,r.data.id);alerts=(await db.pool.query('SELECT * FROM task_alerts WHERE reminder_id=$1',[r.data.id])).rows;assert(alerts.filter(a=>!a.acknowledged_at).every(a=>a.canceled_at));
 }finally{await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');}
});

test('morning and noon digests use only own tasks, skip weekends and re-evaluate remaining overdue tasks',async()=>{
 const {tickTaskReminders}=await import('../server/reminders.js');
 await db.pool.query("INSERT INTO telegram_binding(chat_id,user_id,paired_at) VALUES('300','anna','2034-12-31T00:00:00Z')");
 const before=(await request('admin','/tasks',{...taskInput,deadline:'2000-01-01T12:00:00Z'})).data.id;
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=true');
 try{
  await tickTaskReminders(new Date('2035-01-01T09:00:00+03:00'));await tickTaskReminders(new Date('2035-01-01T09:00:00+03:00'));
  let rows=(await db.pool.query("SELECT * FROM task_alerts WHERE recipient_id='anna' AND kind='morning' AND dedupe_key LIKE '%2035-01-01'")).rows;assert.equal(rows.length,1);assert(rows[0].body.includes('#'+before));assert(!rows[0].body.includes('#2403'));
  const t=(await service.detail(users.find(u=>u.id==='admin')!,before)).task;
  await request('anna',`/tasks/${before}/review`,{action:'submit',comment:'Результат представлен на приёмку',expectedVersion:t.version});
  await tickTaskReminders(new Date('2035-01-01T12:00:00+03:00'));
  rows=(await db.pool.query("SELECT * FROM task_alerts WHERE recipient_id='anna' AND kind='noon' AND dedupe_key LIKE '%2035-01-01'")).rows;assert.equal(rows.length,1);assert(!rows[0].body.includes('#'+before));assert.equal((await db.pool.query("SELECT count(*)::int n FROM task_alerts WHERE kind='morning' AND due_at='2035-01-01T06:00:00Z'")).rows[0].n>=1,true);
  await tickTaskReminders(new Date('2035-01-06T12:00:00+03:00'));assert.equal((await db.pool.query("SELECT count(*)::int n FROM task_alerts WHERE kind IN ('morning','noon') AND dedupe_key LIKE '%2035-01-06'")).rows[0].n,0);
 }finally{await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');}
});

test('each Telegram account binds only its own chat and cannot replace another user or existing binding',async()=>{
 const pilot=await import('../server/telegram-pilot.js'),director=users.find(u=>u.id==='director')!,admin=users.find(u=>u.id==='admin')!;
 const original=globalThis.fetch,previous=process.env.TELEGRAM_BOT_TOKEN,sends:any[]=[];process.env.TELEGRAM_BOT_TOKEN='TEST_TOKEN';
 globalThis.fetch=(async(url:any,options:any)=>{if(String(url).includes('sendMessage'))sends.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:String(url).includes('getMe')?{username:'isolated_test_bot'}:String(url).includes('getWebhookInfo')?{}:{message_id:900}}));}) as typeof fetch;
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=false');
 try{
  const link=await pilot.pairPilot(director),code=new URL(link.url).searchParams.get('start');
  await pilot.handlePilotUpdate({update_id:801,message:{chat:{id:400,type:'private'},text:'/start '+code}});
  assert.equal((await db.pool.query("SELECT user_id FROM telegram_binding WHERE chat_id='400'")).rows[0].user_id,'director');
  const conflict=await pilot.pairPilot(admin);await pilot.handlePilotUpdate({update_id:802,message:{chat:{id:400,type:'private'},text:'/start '+new URL(conflict.url).searchParams.get('start')}});
  assert.equal((await db.pool.query("SELECT user_id FROM telegram_binding WHERE chat_id='400'")).rows[0].user_id,'director');
  assert.equal((await db.pool.query("SELECT chat_id FROM telegram_binding WHERE user_id='admin'")).rows[0].chat_id,'100');
  await assert.rejects(()=>pilot.pairPilot(director,'ivan'),/Другую учётную запись/);
  const staff=await pilot.pairPilot(admin,'ivan');await pilot.handlePilotUpdate({update_id:804,message:{chat:{id:500,type:'private'},text:'/start '+new URL(staff.url).searchParams.get('start')}});assert.equal((await db.pool.query("SELECT user_id FROM telegram_binding WHERE chat_id='500'")).rows[0].user_id,'ivan');
  const before=sends.length;await pilot.handlePilotUpdate({update_id:803,message:{chat:{id:999,type:'private'},text:'/tasks'}});assert.equal(sends.length,before);
 }finally{globalThis.fetch=original;if(previous===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=previous;await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');}
});

test('Telegram task alerts repeat after 30 minutes, acknowledge once and stop when completed; unknown sends do not duplicate',async()=>{
 const reminders=await import('../server/reminders.js'),pilot=await import('../server/telegram-pilot.js'),bot=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!;
 const id=(await request('admin','/tasks',taskInput)).data.id;
 const r=await reminders.saveTaskReminder(anna,id,{recipientId:'anna',days:[3],times:['11:00'],weeks:1});
 await db.pool.query("UPDATE task_reminders SET start_date='2035-01-03',created_at='2035-01-02T00:00:00Z' WHERE id=$1",[r.id]);
 const original=globalThis.fetch,previous=process.env.TELEGRAM_BOT_TOKEN,sends:any[]=[];let unknown=false;process.env.TELEGRAM_BOT_TOKEN='TEST_TOKEN';
 globalThis.fetch=(async(url:any,options:any)=>{const body=JSON.parse(options?.body||'{}');if(String(url).includes('sendMessage')){if(unknown&&body.text.includes('#'+id))throw new Error('Simulated lost network response');sends.push(body);}return new Response(JSON.stringify({ok:true,result:{message_id:1000+sends.length}}));}) as typeof fetch;
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=true');
 const count=()=>sends.filter(b=>String(b.chat_id)==='300'&&b.text.includes('Напоминание по задаче #'+id)).length;
 try{
  await pilot.deliver(new Date('2035-01-03T11:00:00+03:00'));assert.equal(count(),1);
  await pilot.deliver(new Date('2035-01-03T11:29:00+03:00'));assert.equal(count(),1);
  await pilot.deliver(new Date('2035-01-03T11:30:00+03:00'));assert.equal(count(),2);
  const alert=(await db.pool.query('SELECT * FROM task_alerts WHERE reminder_id=$1',[r.id])).rows[0];
  const screen=await bot.alertScreen(anna,'telegram:300',alert),confirm=botButton(screen,'ОК, увидел');await bot.botClick(anna,'telegram:300',confirm);await bot.botClick(anna,'telegram:300',confirm);
  await pilot.deliver(new Date('2035-01-03T12:01:00+03:00'));assert.equal(count(),2);
  const next=await reminders.saveTaskReminder(anna,id,{recipientId:'anna',days:[3],times:['13:00'],weeks:1});await db.pool.query("UPDATE task_reminders SET start_date='2035-01-03',created_at='2035-01-02T00:00:00Z' WHERE id=$1",[next.id]);unknown=true;
  await pilot.deliver(new Date('2035-01-03T13:00:00+03:00'));const uncertain=(await db.pool.query("SELECT d.state FROM task_alert_deliveries d JOIN task_alerts a ON a.id=d.alert_id WHERE a.reminder_id=$1",[next.id])).rows;assert.equal(uncertain[0].state,'uncertain');
  unknown=false;await pilot.deliver(new Date('2035-01-03T13:31:00+03:00'));assert.equal(count(),2);
  // Completing the task removes it from every pending delivery, regardless of an old schedule.
  assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Результат готов и передан на проверку',expectedVersion:1})).status,200);
  assert.equal((await request('director',`/tasks/${id}/review`,{action:'accept',comment:'Результат проверен и принят',expectedVersion:2})).status,200);
  await reminders.tickTaskReminders(new Date('2035-01-03T14:00:00+03:00'));assert(!(await reminders.pendingAlerts(anna,new Date('2035-01-03T14:00:00+03:00'))).some(a=>a.task_id===id));
 }finally{globalThis.fetch=original;if(previous===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=previous;await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');}
});

test('bot creates a reminder through weekday buttons and validates times before final confirmation',async()=>{
 const {botView,botClick,botText}=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!;
 const id=(await request('admin','/tasks',taskInput)).data.id;
 let view=await botView(anna,'preview',{op:'reminder_days',id});view=await botClick(anna,'preview',botButton(view,'Пн'));view=await botClick(anna,'preview',botButton(view,'Ср'));await botClick(anna,'preview',botButton(view,'Далее: время и недели'));
 await assert.rejects(()=>botText(anna,'preview','25:00',crypto.randomUUID()),/ЧЧ:ММ/);await botText(anna,'preview','09:00, 15:30',crypto.randomUUID());await assert.rejects(()=>botText(anna,'preview','0',crypto.randomUUID()),/от 1 до 52/);view=await botText(anna,'preview','3',crypto.randomUUID());
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM task_reminders WHERE task_id=$1',[id])).rows[0].n,0);
 await botClick(anna,'preview',botButton(view,'Подтвердить и отправить'));const r=(await db.pool.query('SELECT * FROM task_reminders WHERE task_id=$1',[id])).rows[0];assert.deepEqual(r.days,[1,3]);assert.deepEqual(r.times,['09:00','15:30']);assert.equal(r.weeks,3);assert.equal(r.recipient_id,'anna');
});

test('external sync queue preserves version order, backs off on failure and never calls an external provider implicitly',async()=>{
 const {processTaskSync}=await import('../server/task-sync.js');
 // Mark unrelated fixture operations delivered in this isolated test database.
 await db.pool.query("UPDATE task_sync_queue SET state='sent'");
 const id=(await request('admin','/tasks',taskInput)).data.id;
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,description:'Уточнённое описание для очереди',expectedVersion:1,reason:'Уточнение требований перед синхронизацией'},'PUT')).status,200);
 const calls:number[]=[];let fail=true;const adapter=async(change:{version:number})=>{calls.push(change.version);if(fail)throw new Error('Temporary failure');};const now=new Date('2035-01-10T10:00:00Z');
 await processTaskSync(adapter,now,1);assert.deepEqual(calls,[1]);await processTaskSync(adapter,new Date(now.getTime()+1000),1);assert.deepEqual(calls,[1]);
 fail=false;await processTaskSync(adapter,new Date(now.getTime()+31000),1);await processTaskSync(adapter,new Date(now.getTime()+32000),1);assert.deepEqual(calls,[1,1,2]);await processTaskSync(adapter,new Date(now.getTime()+33000),1);assert.deepEqual(calls,[1,1,2]);
 assert((await db.pool.query('SELECT state FROM task_sync_queue WHERE task_id=$1',[id])).rows.every(r=>r.state==='sent'));
});


test('a one-week reminder saved after its time still has its next occurrence, without replaying the past',async()=>{
 const reminders=await import('../server/reminders.js'),anna=users.find(u=>u.id==='anna')!;
 const id=(await request('admin','/tasks',taskInput)).data.id,r=await reminders.saveTaskReminder(anna,id,{recipientId:'anna',days:[2],times:['09:00'],weeks:1});
 await db.pool.query("UPDATE task_reminders SET start_date='2035-01-02',created_at='2035-01-02T14:00:00+03:00' WHERE id=$1",[r.id]);await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=true');
 try{await reminders.tickTaskReminders(new Date('2035-01-02T15:00:00+03:00'));assert.equal((await db.pool.query('SELECT count(*)::int n FROM task_alerts WHERE reminder_id=$1',[r.id])).rows[0].n,0);await reminders.tickTaskReminders(new Date('2035-01-09T09:00:00+03:00'));assert.equal((await db.pool.query('SELECT count(*)::int n FROM task_alerts WHERE reminder_id=$1',[r.id])).rows[0].n,1);await reminders.tickTaskReminders(new Date('2035-01-16T09:00:00+03:00'));assert.equal((await db.pool.query('SELECT count(*)::int n FROM task_alerts WHERE reminder_id=$1',[r.id])).rows[0].n,1);}finally{await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');}
});

test('planning is hidden by default, preserves archived reports and enables the scheduled plan only when switched on',async()=>{
 const admin=users.find(u=>u.id==='admin')!,cfg=await service.config(),automation=await import('../server/automation.js');
 const report=await service.makeReport(admin,'nextday','planning-visibility');assert.equal((await service.listReports(admin,{kind:'nextday',page:0})).total,0);assert.equal((await service.getReport(admin,report.id)).id,report.id);
 await service.saveRules(admin,{...cfg.config,showPlanning:true},cfg.version);
 try{assert((await service.listReports(admin,{kind:'nextday',page:0})).items.some((r:any)=>r.id===report.id));await automation.saveAutomation(admin,{enabled:true,morning:'09:00',evening:'18:00'});await automation.tick(new Date('2035-01-11T18:01:00+03:00'));assert.equal((await db.pool.query("SELECT count(*)::int n FROM reports WHERE day='2035-01-11' AND kind='nextday' AND slot='scheduled-evening'")).rows[0].n,1);}finally{const current=await service.config();await service.saveRules(admin,cfg.config,current.version);await automation.saveAutomation(admin,{enabled:false,morning:'09:00',evening:'18:00'});}
});
