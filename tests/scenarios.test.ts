import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
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
 const {summarize}=await import('../shared/analytics.js');
 const {activeTaskApproval}=await import('../shared/actions.js');
 const pending=new Set(visible.tasks.filter(task=>visible.approvals.some(a=>activeTaskApproval(task,a))).map(task=>task.id));
 const s=summarize(visible.tasks.filter(task=>visible.teamIds.includes(task.assignee_id)),new Date(visible.serverTime),pending);
 assert(brief.text.includes('Открыто: '+s.unfinished));
 assert(brief.text.includes('Просрочено: '+(s.overdue+s.elapsedToday)+' ·'));
 const foreign=users.find(u=>u.role==='employee'&&u.branch_id!==lead.branch_id)!;
 assert(!brief.text.includes(foreign.name));
 assert(brief.buttons.flat().some(b=>b.text==='Отчёты'));
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
test('web session slides by a week on activity and an expired session cannot be revived',async()=>{
 const login=await fetch(base+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:'anna'})});
 assert.match(login.headers.get('set-cookie')??'',/Max-Age=604800/i);
 const cookie=login.headers.get('set-cookie')!.split(';')[0],headers={Cookie:cookie};
 const token=createHash('sha256').update(cookie.slice('ruspet_session='.length)).digest('hex');
 const expiry=async()=>(await db.pool.query('SELECT expires_at FROM sessions WHERE token_hash=$1',[token])).rows[0].expires_at;
 await db.pool.query("UPDATE sessions SET expires_at=now()+interval '2 minutes' WHERE token_hash=$1",[token]);
 const before=await expiry();
 assert.equal((await fetch(base+'/api/bootstrap?view=workspace',{headers})).status,200);
 assert.equal(await expiry(),before);
 const active=await fetch(base+'/api/auth/activity',{method:'POST',headers});
 assert.equal(active.status,200);assert.match(active.headers.get('set-cookie')??'',/Max-Age=604800/i);
 assert.ok(Date.parse(await expiry())-Date.now()>6.99*86400000);
 await db.pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[token]);
 assert.equal((await fetch(base+'/api/auth/activity',{method:'POST',headers})).status,401);
});

test('employee cannot view another branch task or run checks',async()=>{
 assert.equal((await request('anna','/tasks/2403')).status,404);
 assert.equal((await request('anna','/checks/run',{})).status,403);
 const result=await request('anna','/bootstrap');assert.ok(result.data.tasks.every((t:any)=>t.assignee_id==='anna'||t.creator_id==='anna'));
});

test('per-task undo survives work on another task; staff undo is explicit and limited to the Moscow day',async t=>{
 const template={title:'Проверка отмены действий',description:'Фикстура',price:0,assigneeId:'anna',
  deadline:null,plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null};
 const paths:string[]=[];
 for(let i=0;i<4;i++){
  const {status,data}=await request('admin','/tasks',template);assert.equal(status,201);
  const path='/tasks/'+data.id;paths.push(path);
  assert.equal((await request('anna',path+'/comments',{body:'Рабочий комментарий '+i})).status,200);
 }
 const lastFor=(path:string)=>request('anna','/undo/last?taskId='+path.slice('/tasks/'.length));
 const own=(await lastFor(paths[0])).data;
 assert.equal(own.task_id,paths[0].slice('/tasks/'.length));
 assert(own.remainingMs>0&&own.remainingMs<=300000);
 const {botView,botClick}=await import('../server/bot.js');
 const anna=users.find(u=>u.id==='anna')!;
 const screen=await botView(anna,'undo-fixture',{op:'task_more',id:own.task_id});
 const undoButton=screen.buttons.flat().find(b=>b.text==='Отменить последнее действие');
 assert(undoButton);
 const confirm=await botClick(anna,'undo-fixture',undoButton.token);
 assert(confirm.buttons.flat().some(b=>b.text==='Да, отменить действие'));
 assert.equal((await request('anna','/undo',{id:own.id,confirmed:true})).status,200);

 const auditPath=paths[1]+'/staff-undo',candidate=(await lastFor(paths[1])).data;
 const second=(await lastFor(paths[2])).data,changed=(await lastFor(paths[3])).data;
 const body={id:candidate.id,confirmed:true,reason:'Комментарий добавили по ошибке.'};
 assert.equal((await request('admin',auditPath)).status,403);
 assert.equal((await request('admin','/undo/staff',body)).status,403);
 assert.equal((await request('director','/undo/staff',body)).status,403);
 await db.pool.query("UPDATE users SET staff_undo_access=true WHERE id IN ('admin','anna')");
 t.after(()=>db.pool.query("UPDATE users SET staff_undo_access=false WHERE id IN ('admin','anna')"));
 assert.equal((await request('anna',auditPath)).status,403);
 assert.equal((await request('anna','/undo/staff',body)).status,403);
 assert.equal((await fetch(base+'/api'+auditPath,{headers:{Cookie:cookies.get('admin')!,'X-Ruspet-View-As':'anna'}})).status,403);

 const at='2026-11-19T00:06:00+03:00';
 const clock=t.mock.method(Date,'now',()=>Date.parse(at));
 await db.pool.query("UPDATE undo_actions SET created_at='2026-11-18T10:00:00+03:00' WHERE NOT supported AND task_id=ANY($1)",
  [paths.map(path=>path.slice('/tasks/'.length))]);
 const times=['2026-11-19T00:00:00+03:00','2026-11-18T23:59:59+03:00','2026-11-19T00:01:00+03:00'];
 await db.pool.query('UPDATE undo_actions SET created_at=$2 WHERE id=$1',[candidate.id,times[0]]);
 await db.pool.query('UPDATE undo_actions SET created_at=$2 WHERE id=$1',[second.id,times[1]]);
 await db.pool.query('UPDATE undo_actions SET created_at=$2 WHERE id=$1',[changed.id,times[2]]);
 assert.equal((await lastFor(paths[1])).data,null);
 const today=(await request('admin',auditPath)).data.find((row:{id:string})=>row.id===candidate.id);
 assert.equal(today.author,anna.name);
 assert.equal(today.problem,null);
 assert(!(await request('admin',paths[2]+'/staff-undo')).data.some((row:{id:string})=>row.id===second.id));
 const expired=await request('admin','/undo/staff',{...body,id:second.id});
 assert.equal(expired.status,409);
 assert.match(expired.data.error,/текущий день/);

 await db.pool.query('UPDATE tasks SET version=version+1 WHERE id=$1',[changed.task_id]);
 assert.match((await request('admin',paths[3]+'/staff-undo')).data.find((row:{id:string})=>row.id===changed.id).problem,/изменились/);
 assert.equal((await request('admin','/undo/staff',{...body,id:changed.id})).status,409);
 assert.equal((await request('admin','/undo/staff',body)).status,200);
 assert.equal((await request('admin','/undo/staff',body)).status,409);
 clock.mock.restore();

 const events=(await request('admin',paths[1])).data.events;
 const entry=events.find((event:{kind:string})=>event.kind==='action_undone');
 assert.equal(entry.actor_id,'admin');
 assert.equal(entry.data.originalActorId,'anna');
 assert.equal(entry.data.reason,body.reason);
 assert(events.some((event:{id:string})=>entry.data.originalEvents.includes(event.id)));
 const saved=(await db.pool.query('SELECT undone_by,undo_reason FROM undo_actions WHERE id=$1',[body.id])).rows[0];
 assert.deepEqual(saved,{undone_by:'admin',undo_reason:body.reason});
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
test('source change keeps the approval and rejects an old decision button',async()=>{
 const a=(await db.pool.query("SELECT * FROM approvals WHERE task_id='2403'")).rows[0];
 assert.equal((await request('admin','/tasks/2403/mock-change',{expectedVersion:1})).status,200);
 assert.equal((await request('lead-kzn',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата'})).status,409);
 const current=(await db.pool.query('SELECT * FROM approvals WHERE id=$1',[a.id])).rows[0];
 assert.equal(current.state,'pending');assert.equal(current.task_version,2);
 assert.equal(current.action_revision,a.action_revision+1);
 assert.deepEqual(current.task_change.fields.map((field:{field:string})=>field.field),['description']);
 assert.equal((await request('lead-kzn',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Согласовано после проверки результата',expectedStep:0,expectedRevision:current.action_revision})).status,200);
});
test('explanations validate all fields, survive repeat checks, reject duplicate submission',async()=>{
 const c=(await db.pool.query("SELECT * FROM control_requests WHERE task_id='2405'")).rows[0];
 assert.equal((await request('anna',`/controls/${c.id}/answer`,{reason:'мало',progress:'мало',plan:'мало'})).status,400);
 const input={reason:'Ждём техническое заключение от клиента',progress:'Документы подготовлены и направлены клиенту',plan:'Уточнить параметры и подтвердить новый срок'};
 assert.equal((await request('anna',`/controls/${c.id}/answer`,input)).status,200);
 await service.runChecks(users[0]);assert.equal((await db.pool.query('SELECT state FROM control_requests WHERE id=$1',[c.id])).rows[0].state,'answered');
 assert.equal((await request('anna',`/controls/${c.id}/answer`,input)).status,409);
});
test('completion requests are accepted only by the task creator',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 const a=await request('anna',`/tasks/${id}/approvals`,{type:'completion',reason:'Все действия по задаче выполнены полностью',plan:'Результат передан заказчику и проверен менеджером',expectedVersion:1});assert.equal(a.status,201);
 const path=`/approvals/${a.data.id}/decision`;
 assert.equal((await request('director',path,{decision:'approve'})).status,403);
 assert.equal((await request('anna',path,{decision:'approve'})).status,403);
 assert.equal((await request('admin',path,{decision:'approve'})).data.state,'approved');
 assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id=$1',[id])).rows[0].status,'completed');
});
test('report snapshot is immutable and same-day generation is idempotent',async()=>{
 const a=await service.makeReport(users[0]);const b=await service.makeReport(users[0]);assert.equal(a.id,b.id);assert(a.rows.length>0);assert(a.rows.every(t=>t.status!=='completed'||a.summary?.activity.closedIds.includes(t.id)));
 await assert.rejects(()=>db.pool.query('UPDATE reports SET metrics=$1 WHERE id=$2',['{}',a.id]),/append-only/);
 const branch=await service.makeReport(users.find(u=>u.id==='lead-msk')!,'snapshot','branch-team',new Date(),{view:'team'});assert.ok(branch.rows.every((t:any)=>t.branch_id==='Москва'));
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

const taskInput={price:10000,title:'РЗМ* Проверка локального процесса',description:'Результат должен пройти приёмку',assigneeId:'anna',deadline:'2026-11-10T15:00:00.000Z',plannedStart:null,plannedEnd:null,important:true,customerRisk:false,parentId:null};
test('local task edit protects deadline and version; review supports return and acceptance with complete history',async()=>{
 const created=await request('admin','/tasks',taskInput);assert.equal(created.status,201);const id=created.data.id;
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,reason:'Изменение по результатам проверки',deadline:'2026-12-10T15:00:00.000Z',expectedVersion:1},'PUT')).status,400);
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,reason:'Уточнение требований к результату',description:'Уточнённое описание',expectedVersion:1},'PUT')).status,200);
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,reason:'Попытка изменения старой версии',expectedVersion:1},'PUT')).status,409);
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Готовый результат приложен в описание',expectedVersion:2})).status,200);
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'accept',comment:'Свою работу принять нельзя',expectedVersion:3})).status,403);
 assert.equal((await request('director',`/tasks/${id}/review`,{action:'return',comment:'Исправьте расчёт суммы в результате',expectedVersion:3})).status,403);
 assert.equal((await request('admin',`/tasks/${id}/review`,{action:'return',comment:'Исправьте расчёт суммы в результате',expectedVersion:3})).status,200);
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Расчёт исправлен, результат обновлён',expectedVersion:4})).status,200);
 assert.equal((await request('admin',`/tasks/${id}/review`,{action:'accept',comment:'Результат проверен, замечаний нет',expectedVersion:5})).status,200);
 assert.equal((await request('admin',`/tasks/${id}/review`,{action:'accept',comment:'Повторное нажатие',expectedVersion:5})).status,409);
 const d=(await request('anna',`/tasks/${id}`)).data;assert.equal(d.task.status,'completed');assert.equal(d.task.transfer_count,0);assert.equal(d.comments.length,4);assert.equal(d.events.filter((e:any)=>e.kind==='review_returned')[0].data.comment,'Исправьте расчёт суммы в результате');assert.equal(d.events.filter((e:any)=>e.kind==='task_completed').length,1);
});
test('task hierarchy rejects cycles and invalid dates',async()=>{
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
 const created=await request('admin','/tasks',{...taskInput,deadline:new Date().toISOString(),title:'РЗМ* <script>alert(1)</script> & отчёт'});assert.equal(created.status,201);
 await db.pool.query("UPDATE users SET name='<script>alert(1)</script> & сотрудник' WHERE id='anna'");
 const b=await service.makeReport(director,'snapshot','analysis-second');assert(b.analysis?.comparison);assert.equal(b.analysis.comparison.entered,1);assert.equal(b.analysis.comparison.id,a.id);assert.equal(b.analysis.counts.total,b.rows.length);
 const print=await fetch(base+`/api/reports/${b.id}/print`,{headers:{Cookie:cookies.get('director')!}});assert.equal(print.status,200);const html=await print.text();assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.ok(!html.includes('<script>'));
 assert.equal((await fetch(base+`/api/reports/${b.id}/print`,{headers:{Cookie:cookies.get('anna')!}})).status,404);
 await db.pool.query("UPDATE users SET name='Имя изменено после отчёта' WHERE id='anna'");const frozen=await service.getReport(director,b.id);assert.notEqual(frozen.analysis.team.find((u:any)=>u.id==='anna').name,'Имя изменено после отчёта');
});
test('scheduled general report at 09:00 and evening summary are idempotent and have no duplicate report types',async()=>{
 const {tick,saveAutomation,operationsStatus}=await import('../server/automation.js'),admin=users.find(u=>u.id==='admin')!;
 await saveAutomation(admin,{enabled:true,morning:'09:00',evening:'19:01'});const at=new Date('2026-11-02T09:01:00+03:00');await tick(at);await tick(at);
 const count=async()=>Number((await db.pool.query("SELECT count(*) n FROM reports WHERE day='2026-11-02' AND slot LIKE 'scheduled-%'")).rows[0].n);assert.equal(await count(),1);
 await db.pool.query("UPDATE job_runs SET state='failed',attempts=1,retry_at=NULL WHERE job_key='reports-v5:morning:2026-11-02'");await tick(at);assert.equal(await count(),1);
 await tick(new Date('2026-11-02T19:02:00+03:00'));assert.equal(await count(),2);
 const run=(await db.pool.query("SELECT * FROM job_runs WHERE job_key='reports-v5:morning:2026-11-02'")).rows[0];assert.equal(run.state,'done');assert.equal(run.report_ids.length,1);assert.equal(run.attempts,2);
 assert.equal((await operationsStatus()).alive,true);assert.equal((await request('anna','/operations')).status,403);
 await saveAutomation(admin,{enabled:false,morning:'09:00',evening:'19:01'});
});
test('failed scheduled report retries atomically; an interrupted third attempt becomes actionable',async()=>{
 const {tick,saveAutomation}=await import('../server/automation.js'),admin=users.find(u=>u.id==='admin')!;await saveAutomation(admin,{enabled:true,morning:'09:00',evening:'19:01'});
 await db.pool.query("ALTER TABLE reports ADD CONSTRAINT test_report_failure CHECK (NOT(day='2026-11-04' AND slot='scheduled-morning'))");const at=new Date('2026-11-04T09:01:00+03:00');await tick(at);
 const count=async()=>Number((await db.pool.query("SELECT count(*) n FROM reports WHERE day='2026-11-04' AND slot='scheduled-morning'")).rows[0].n);assert.equal(await count(),0);assert.equal((await db.pool.query("SELECT state FROM job_runs WHERE job_key='reports-v5:morning:2026-11-04'")).rows[0].state,'failed');
 await db.pool.query('ALTER TABLE reports DROP CONSTRAINT test_report_failure');await db.pool.query("UPDATE job_runs SET retry_at=NULL WHERE job_key='reports-v5:morning:2026-11-04'");await tick(at);assert.equal(await count(),1);
 await db.pool.query("INSERT INTO job_runs(job_key,state,attempts) VALUES('reports-v5:morning:2026-11-05','running',3)");await tick(new Date('2026-11-05T09:01:00+03:00'));assert.equal((await db.pool.query("SELECT state FROM job_runs WHERE job_key='reports-v5:morning:2026-11-05'")).rows[0].state,'failed');await saveAutomation(admin,{enabled:false,morning:'09:00',evening:'19:01'});
});
test('archive searches all stored days, paginates without duplicate rows and enforces scope',async()=>{
 const available=Number((await db.pool.query("SELECT count(*) n FROM reports WHERE scope='company' AND kind<>'nextday'")).rows[0].n);for(let i=available;i<21;i++)await service.makeReport(users.find(u=>u.id==='director')!,'snapshot','pagination-'+i,new Date('2026-11-12T09:00:00+03:00'));
 const first=await request('director','/reports?page=0');assert.equal(first.status,200);assert.ok(first.data.total>20);assert.equal(first.data.items.length,20);assert.ok(first.data.items.every((r:any)=>!r.rows));
 const second=await request('director','/reports?page=1');const ids=new Set(first.data.items.map((r:any)=>r.id));assert.ok(second.data.items.every((r:any)=>!ids.has(r.id)));
 const filtered=await request('director','/reports?kind=snapshot&from=2026-11-04&to=2026-11-04');const expected=(await db.pool.query("SELECT id FROM reports WHERE scope='company' AND kind='snapshot' AND day='2026-11-04'")).rows.map(r=>r.id);
 assert.ok(expected.length>0);
 assert.equal(filtered.data.total,expected.length);
 assert.deepEqual(new Set(filtered.data.items.map((r:any)=>r.id)),new Set(expected));
 assert.equal((await request('anna','/reports')).data.total,0);assert.equal((await request('director','/reports?from=2026-11-05&to=2026-11-04')).status,400);
});

const botButton=(view:any,label:string)=>{const b=view.buttons.flat().find((b:any)=>b.text===label);assert.ok(b,'Button missing: '+label);return b.token as string};
test('administrators see other employees actions as team work instead of personal duties',async()=>{
 const {actionItems}=await import('../shared/actions.js');
 const id=(await request('director','/tasks',{...taskInput,assigneeId:'olga'})).data.id;
 await db.pool.query("INSERT INTO control_requests(id,task_id,assignee_id,state,due_at) VALUES($1,$2,'olga','waiting',now())",[randomUUID(),id]);
 const admin=users.find(user=>user.id==='admin')!;
 let actions=actionItems(await service.bootstrap(admin,true)).filter(action=>action.taskId===id);
 assert(actions.some(action=>action.kind==='answer'));
 assert(actions.every(action=>!action.mine));
 assert.equal((await request('olga','/tasks/'+id+'/review',{action:'submit',comment:'Результат для проверки личной очереди',expectedVersion:1})).status,200);
 actions=actionItems(await service.bootstrap(admin,true)).filter(action=>action.taskId===id);
 assert(actions.some(action=>action.kind==='review'&&!action.mine));
 assert(!actions.some(action=>action.kind==='answer'));
 const director=users.find(user=>user.id==='director')!;
 assert(actionItems(await service.bootstrap(director,true)).some(action=>action.taskId===id&&action.kind==='review'&&action.mine));
});
test('a creator completes a personal task from the bot with one confirmation and no self review',async()=>{
 const bot=await import('../server/bot.js'),anna=users.find(user=>user.id==='anna')!;
 const id=(await request('anna','/tasks',{...taskInput,title:'Личная задача без отдельного согласования'})).data.id;
 const view=await bot.botView(anna,'self-complete',{op:'task',id});
 assert(view.text.includes('Исполнитель · '+anna.name)&&view.text.includes('Постановщик · '+anna.name));
 assert(!view.buttons.flat().some(button=>button.text==='Сдать результат'));
 const confirmation=await bot.botClick(anna,'self-complete',botButton(view,'Завершить задачу'));
 assert.match(confirmation.text,/Завершить задачу/);
 assert.equal((await request('anna','/tasks/'+id)).data.task.status,'active');
 const token=botButton(confirmation,'Подтвердить и отправить');
 const response=await bot.botClick(anna,'self-complete',token);
 assert.match(response.text,/Задача завершена/);
 assert.deepEqual(await bot.botClick(anna,'self-complete',token),response);
 const closed=(await request('anna','/tasks/'+id)).data;
 assert.equal(closed.task.status,'completed');
 assert.deepEqual(closed.submissions,[]);
 assert.deepEqual(closed.approvals,[]);
 const another=(await request('anna','/tasks',taskInput)).data.id;
 assert.equal((await request('director','/tasks/'+another+'/review',{action:'complete',comment:'',expectedVersion:1})).status,403);
 assert.equal((await request('anna','/tasks/'+another+'/review',{action:'complete',comment:'',expectedVersion:2})).status,409);
});
test('an overdue explanation preserves the deadline and offers a separate prefilled transfer',async()=>{
 const bot=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!,ch='preview-explanation';
 const deadline=new Date(Date.now()-2*86400000).toISOString();
 const created=await request('admin','/tasks',{...taskInput,deadline});
 assert.equal(created.status,201);
 const id=created.data.id;
 await db.pool.query("INSERT INTO control_requests(id,task_id,assignee_id,state,due_at) VALUES($1,$2,$3,'waiting',now())",
  [randomUUID(),id,anna.id]);
 const open=()=>bot.botView(anna,ch,{op:'task',id});
 const press=(view:Awaited<ReturnType<typeof open>>,label:string)=>bot.botClick(anna,ch,botButton(view,label));
 const type=(value:string)=>bot.botText(anna,ch,value,randomUUID());
 const reason='Клиент прислал сведения с задержкой',plan='Проверить документы и отправить решение';
 await press(await open(),'Дать объяснение');
 await type(reason);
 await type('Запросили документы и сверили заявку');
 const saved=await press(await type(plan),'Подтвердить и отправить');
 assert.match(saved.text,/Объяснение сохранено/);
 assert.match(saved.text,/Просрочена/);
 assert.ok(botButton(saved,'Сдать результат'));
 const details=()=>request('anna','/tasks/'+id);
 const before=(await details()).data;
 assert.equal(before.task.deadline,deadline);
 assert.deepEqual(before.approvals,[]);
 const card=await open();
 assert.match(card.text,/Объяснение сохранено/);
 const draft=await press(card,'Предложить новый срок');
 assert.match(draft.text,/Дата и время по Москве/);
 const confirmation=await type('завтра в 15:00');
 assert.match(confirmation.text,/^Запросить перенос/);
 assert.ok(confirmation.text.includes(reason));assert.ok(!confirmation.text.includes(plan));
 await press(confirmation,'Подтвердить и отправить');
 const after=(await details()).data;
 assert.equal(after.task.deadline,deadline);
 assert.equal(after.approvals[0].state,'pending');
 assert.equal(after.approvals[0].reason,reason);
 assert.equal(after.approvals[0].plan,'');
 const first=users.find(u=>u.id===after.approvals[0].route[0].userId)!;
 const queue=await bot.botView(first,ch,{op:'task_approval',id});
 const confirm=await bot.botClick(first,ch,botButton(queue,'Согласовать'));
 await bot.botClick(first,ch,botButton(confirm,'Да, согласовать'));
 const decided=(await details()).data;
 assert.equal(decided.decisions[0].decision,'approve');
 assert.equal(decided.decisions[0].comment,'');
});
test('bot result → return → resubmission → acceptance shares panel history and ignores repeated confirmation',async()=>{
 const bot=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!,director=users.find(u=>u.id==='director')!;
 const id=(await request('director','/tasks',taskInput)).data.id;
 async function enter(user:typeof anna,label:string,text:string){
  let v=await bot.botView(user,'preview',{op:'task',id});
  if(user.id===director.id)v=await bot.botClick(user,'preview',botButton(v,'Проверить результат'));
  v=await bot.botClick(user,'preview',botButton(v,label));v=await bot.botText(user,'preview',text,crypto.randomUUID());return botButton(v,'Подтвердить и отправить');
 }
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
  const t=await createTask(admin,{price:10000,title,description:'Служебная задача',assigneeId:'anna',deadline:'2026-01-01T10:00:00Z',plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null});hidden.push(t.id);
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
test('clarification is a discussion on the same approval stage and requires a fresh explicit decision',async()=>{
 const {botView,botClick,botText}=await import('../server/bot.js');
 const anna=users.find(u=>u.id==='anna')!,lead=users.find(u=>u.id==='lead-msk')!,channel='approval-clarification-test';
 const id=(await request('admin','/tasks',taskInput)).data.id;
 const a=await service.requestApproval(anna,id,{type:'deadline',reason:'Нужен срок для проверки результата',proposedDeadline:new Date(Date.now()+86400000*10).toISOString(),expectedVersion:1});
 const path=`/approvals/${a.id}`;
 const original=await service.detail(anna,id);
 const oldRevision=original.approvals[0].action_revision;
 const firstView=await botView(lead,channel,{op:'task_approval',id});
 const confirmation=await botClick(lead,channel,botButton(firstView,'Согласовать'));
 const oldApprove=botButton(confirmation,'Да, согласовать');

 const question='Какие данные уже проверены?',answer='Проверены строки исходной выгрузки';
 assert.equal((await request(lead.id,path+'/decision',{decision:'clarify',comment:question,expectedRevision:oldRevision,expectedStep:0})).status,200);
 const waiting=(await service.detail(anna,id)).approvals[0];
 assert.equal(waiting.current_step,0);
 assert.equal(waiting.action_revision,oldRevision+1);
 assert.equal((await request(lead.id,path+'/decision',{decision:'approve',comment:'Попытка до ответа',expectedRevision:waiting.action_revision,expectedStep:0})).status,409);
 assert.equal((await request('director',path+'/clarification',{answer:'Ответ другого человека'})).status,403);
 assert.equal((await request(anna.id,path+'/clarification',{answer,expectedRevision:oldRevision})).status,409);
 const authorView=await botView(anna,channel,{op:'task_approval',id});
 await botClick(anna,channel,botButton(authorView,'Ответить на уточнение'));
 const reply=await botText(anna,channel,answer,randomUUID());
 assert.match((await botClick(anna,channel,botButton(reply,'Подтвердить и отправить'))).text,/тому же согласующему/);
 assert.equal((await request(anna.id,path+'/clarification',{answer:'Повторный ответ'})).status,409);

 const afterAnswer=await service.detail(anna,id);
 assert.equal(afterAnswer.approvals[0].state,'pending');
 assert.equal(afterAnswer.approvals[0].current_step,0);
 assert.equal(afterAnswer.approvalProgress?.approver,lead.name);
 assert.equal(afterAnswer.approvalProgress?.clarificationBy,null);
 assert.equal(afterAnswer.approvals[0].action_revision,waiting.action_revision+1);
 assert.equal(afterAnswer.task.deadline,original.task.deadline);
 assert.equal(afterAnswer.task.version,original.task.version);
 assert.equal(afterAnswer.decisions.length,0);
 assert.deepEqual(afterAnswer.comments.filter(c=>c.approval_id===a.id).map(c=>c.kind),['clarification','clarification']);
 await assert.rejects(()=>botClick(lead,channel,oldApprove),/Версия согласования изменилась/);
 assert.equal((await request(lead.id,path+'/decision',{decision:'approve',comment:'Согласовано после уточнения',
  expectedRevision:afterAnswer.approvals[0].action_revision,expectedStep:0})).status,200);
 const advanced=await service.detail(anna,id);
 assert.equal(advanced.approvals[0].current_step,1);
 assert.equal(advanced.approvals[0].clarification_answered_at,null);
 assert.equal(advanced.decisions.length,1);
 assert.equal(advanced.decisions[0].decision,'approve');
 assert.equal(advanced.comments.filter(c=>c.approval_id===a.id).length,2);

 const cleanup=await readFile('server/migrations/050_detach_historical_clarification.sql','utf8');
 await db.transaction(async tx=>{
  await tx.query(`UPDATE approvals SET clarification_question=$2,clarification_answer=$3,
   clarification_requested_at='2026-01-01T12:00:00.123Z',clarification_answered_at='2026-01-01T12:01:00Z' WHERE id=$1`,[a.id,question,answer]);
  await tx.query(`INSERT INTO decisions(id,approval_id,actor_id,step_index,decision,comment,created_at)
   VALUES($1,$2,$3,0,'clarify',$4,'2026-01-01T12:00:00.123456Z')`,[randomUUID(),a.id,lead.id,question]);
  await tx.query(cleanup);
 });
 const repaired=await service.detail(anna,id);
 assert.equal(repaired.approvals[0].current_step,1);
 assert.equal(repaired.approvals[0].clarification_answered_at,null);
 assert.equal(repaired.decisions.filter(d=>d.decision==='approve').length,1);
 assert.equal(repaired.comments.filter(c=>c.approval_id===a.id).length,2);
});
test('task review accepts a positive result without comment but requires reason for return',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Готовый результат передан',expectedVersion:1})).status,200);
 assert.equal((await request('admin',`/tasks/${id}/review`,{action:'return',comment:'',expectedVersion:2})).status,400);
 assert.equal((await request('admin',`/tasks/${id}/review`,{action:'accept',comment:'',expectedVersion:2})).status,200);
});
test('bot search finds a visible task by number or title and keeps access scope',async()=>{
 const {botView,botClick,botText}=await import('../server/bot.js');const anna=users.find(u=>u.id==='anna')!;
 const own=(await service.bootstrap(anna)).tasks[0];
 const found=await botText(anna,'preview-search',own.id,crypto.randomUUID());assert(found.text.includes('#'+own.id));
 const card=await botClick(anna,'preview-search',botButton(found,'#'+own.id));
 assert(card.text.includes('#'+own.id));
 const back=await botClick(anna,'preview-search',botButton(card,'← К списку'));
 assert.equal(back.text,found.text);
 const foreign=await botView(anna,'preview',{op:'search',query:'2403'});assert(!foreign.text.includes('#2403'));
});
test('bot lists four tasks per screen, preserves the search page and keeps full details one tap away',async()=>{
 const {botView,botClick}=await import('../server/bot.js');const anna=users.find(u=>u.id==='anna')!;
 const channel='preview-compact-task',title='РЗМ* Контрольная поставка для экрана бота';
 const description='Уточнить тип крышки <28 мм>.\n\n'+'Сверить позиции заказа, подтвердить комплект документов. '.repeat(45)+'Последняя строка техзадания.';
 for(let i=0;i<5;i++){
  const result=await request('admin','/tasks',{...taskInput,title:title+' '+(i+1),description,customFields:[{label:'Номер партии',value:'Тест 26'}]});
  assert.equal(result.status,201);
 }
 const list=await botView(anna,channel,{op:'search',query:'Контрольная поставка для экрана бота'});
 assert.match(list.text,/1–4 из 5/);assert.equal(list.buttons.flat().filter(b=>b.text.startsWith('#')).length,4);
 const second=await botClick(anna,channel,botButton(list,'Дальше →'));assert.match(second.text,/5 из 5/);
 const onlyTask=second.buttons.flat().find(b=>b.text.startsWith('#'));assert(onlyTask);
 const card=await botClick(anna,channel,onlyTask.token);
 assert.match(card.text,/Крайний срок/);assert.match(card.text,/&lt;28 мм&gt;/);assert(!card.text.includes('Последняя строка техзадания'));
 assert(card.text.length<500);assert.equal(card.buttons[0][0].text,'Добавить в мой план');
 const details=await botClick(anna,channel,botButton(card,'Описание'));assert.match(details.text,/<b>Описание/);assert(!details.text.includes('Номер партии'));
 const end=await botClick(anna,channel,botButton(details,'Продолжение →'));assert.match(end.text,/Последняя строка техзадания/);
 const fields=await botClick(anna,channel,botButton(details,'Поля задачи'));assert.match(fields.text,/Номер партии: Тест 26/);assert(!fields.text.includes('Сверить позиции'));
 assert.equal((await botClick(anna,channel,botButton(card,'← К списку'))).text,second.text);
 const menu=await botView(anna,channel);
 const own=await botClick(anna,channel,botButton(menu,'Мои задачи'));assert.match(own.text,/<b>Мои задачи<\/b>/);
 const filters=await botClick(anna,channel,botButton(own,'Фильтры'));assert(filters.buttons.flat().some(b=>b.text.startsWith('Срок сегодня')));
});
test('director may submit and request a deadline for a visible employee task with own audit identity',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 const proposed=new Date(Date.now()+86400000*12).toISOString();
 assert.equal((await request('director',`/tasks/${id}/approvals`,{type:'deadline',reason:'Изменён срок работы сотрудника',plan:'Проверить материалы и завершить задачу',proposedDeadline:proposed,expectedVersion:1})).status,201);
 const approval=(await db.pool.query("SELECT requester_id FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rows[0];assert.equal(approval.requester_id,'director');
});
test('bot supports optional positive review comment and applies acceptance only after confirmation',async()=>{
 const {botView,botClick,botText}=await import('../server/bot.js');const director=users.find(u=>u.id==='director')!;
 const id=(await request('director','/tasks',taskInput)).data.id;
 assert.equal((await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Результат работы передан',expectedVersion:1})).status,200);
 const card=await botView(director,'preview',{op:'task',id});
 const view=await botClick(director,'preview',botButton(card,'Проверить результат'));assert(view.buttons.flat().some(b=>b.text.includes('без комментария')));
 await botClick(director,'preview',botButton(view,'Принять результат'));
 await assert.rejects(()=>botText(director,'preview','да',crypto.randomUUID()),/от 5/);
 const confirm=await botText(director,'preview','Результат проверен и принят',crypto.randomUUID());
 assert.equal((await request('director',`/tasks/${id}`)).data.task.status,'review');
 await botClick(director,'preview',botButton(confirm,'Подтвердить и отправить'));
 const detail=(await request('director',`/tasks/${id}`)).data;assert.equal(detail.task.status,'completed');assert.equal(detail.submissions[0].remark,'Результат проверен и принят');
});

test('the task creator can edit in the bot with version checks, audit and one confirmation',async()=>{
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

test('an assignee needs a version-specific edit permission in the API and bot',async()=>{
 const {botView,botClick,botText}=await import('../server/bot.js');
 const anna=users.find(u=>u.id==='anna')!,director=users.find(u=>u.id==='director')!;
 const id=(await request('director','/tasks',taskInput)).data.id,path='/tasks/'+id,channel='edit-permission-fixture';
 const reason='Уточнить описание и номер заказа';
 const put=(actor:string,version:number,changes:object={})=>request(actor,path,{...taskInput,...changes,expectedVersion:version,reason},'PUT');
 assert.equal((await put('lead-msk',1)).status,403);
 assert.equal((await put(anna.id,1)).status,403);
 assert.equal((await request(anna.id,path+'/assignees')).status,403);
 await assert.rejects(()=>botView(anna,channel,{op:'edit',id}),/Нет права/);

 const more=await botView(anna,channel,{op:'task_more',id});
 const permission=await botClick(anna,channel,botButton(more,'Запросить редактирование'));
 await botClick(anna,channel,botButton(permission,'Запросить разрешение'));
 const preview=await botText(anna,channel,reason,crypto.randomUUID());
 await botClick(anna,channel,botButton(preview,'Подтвердить и отправить'));
 const requestId=(await request(anna.id,path)).data.editAccess.request.id;
 const decision=path+'/edit-permissions/'+requestId+'/decision';
 assert.equal((await request(anna.id,path+'/edit-permissions',{expectedVersion:1,reason})).status,409);
 assert.equal((await request('lead-msk',decision,{decision:'approve'})).status,403);
 assert.equal((await request(anna.id,decision,{decision:'approve'})).status,403);
 const inbox=await botView(director,channel,{op:'inbox'});
 assert.match(inbox.text,/Сроки и действия/);
 const other=inbox.buttons.flat().find(button=>button.text.startsWith('Ответы и решения ·'));
 assert(other);
 const work=await botClick(director,channel,other.token);
 assert.match(work.text,/Решить запрос на редактирование/);
 const screen=await botView(director,channel,{op:'task_edit_permission',id});
 const confirm=await botClick(director,channel,botButton(screen,'Разрешить'));
 await botClick(director,channel,botButton(confirm,'Подтвердить и отправить'));
 assert.equal((await request('admin',decision,{decision:'approve'})).status,409);
 assert.equal((await request(anna.id,path+'/assignees')).status,200);
 assert.equal((await put(anna.id,1,{deadline:null})).status,400);
 assert.equal((await request(anna.id,path)).data.editAccess.canEdit,true);
 const edits=await Promise.all([put(anna.id,1,{description:'Первая правка'}),put(anna.id,1,{description:'Вторая правка'})]);
 assert.deepEqual(edits.map(edit=>edit.status).sort(),[200,409]);
 assert.equal((await put(anna.id,2)).status,403);
 const saved=await request(anna.id,path);
 assert.equal(saved.data.task.version,2);
 assert.equal(saved.data.events.filter((e:any)=>e.kind==='task_edited').length,1);
 assert.equal(saved.data.events.find((e:any)=>e.kind==='task_edited').data.editPermissionId,requestId);

 const second=await request(anna.id,path+'/edit-permissions',{expectedVersion:2,reason});
 assert.equal(second.status,201);
 assert.equal((await put('admin',2,{description:'Параметры изменены администратором'})).status,200);
 assert.equal((await request(director.id,path+'/edit-permissions/'+second.data.id+'/decision',{decision:'approve'})).status,409);
 assert.equal((await put(anna.id,3)).status,403);
});

test('creating a copy saves the edited draft once and starts an independent task',async()=>{
 const input={...taskInput,customFields:[{label:'Номер партии',value:'28-В'}],plannedStart:'2026-11-15T09:00:00+03:00',plannedEnd:'2026-11-15T12:00:00+03:00'};
 const id=(await request('director','/tasks',input)).data.id,path='/tasks/'+id;
 await request('anna',path+'/comments',{body:'Комментарий остаётся на исходной задаче'});
 await request('anna',path+'/review',{action:'submit',comment:'Только исходный результат',expectedVersion:1});
 await request('director',path+'/review',{action:'accept',comment:'',expectedVersion:2});
 const draft={...input,title:'РЗМ* Копия проверки процесса',assigneeId:'ivan',requestId:crypto.randomUUID()};
 assert.equal((await request('olga',path+'/copy',draft)).status,404);
 assert.equal((await request('anna',path+'/copy',draft)).status,403);
 const saves=await Promise.all([request('director',path+'/copy',draft),request('director',path+'/copy',draft)]);
 assert.deepEqual(saves.map(save=>save.status),[201,201]);assert.equal(saves[0].data.id,saves[1].data.id);
 assert.equal((await request('director',path+'/copy',{...draft,title:'Другая редакция'})).status,409);
 const copied=(await request('ivan','/tasks/'+saves[0].data.id)).data;
 assert.equal(copied.task.title,draft.title);assert.equal(copied.task.assignee_id,'ivan');
 assert.equal(copied.task.description,input.description);assert.equal(Number(copied.task.price),input.price);
 assert.equal(copied.task.deadline,input.deadline);assert.equal(copied.task.planned_start,new Date(input.plannedStart).toISOString());
 assert.deepEqual(copied.task.custom_fields,input.customFields);assert.equal(copied.task.status,'active');
 assert.equal(copied.task.delegated_from_id,null);assert.equal(copied.submissions.length,0);assert.equal(copied.comments.length,0);
 assert.equal(copied.events[0].data.copiedFrom,id);
 assert.equal((await request('director',path)).data.task.status,'completed');
});

test('launch routing uses the task branch and adds the sales head selectively or for all requests',async()=>{
 const branch='lead-kzn',sales='director',assignee='olga',otherBranch='lead-msk';
 assert.equal((await request(sales,'/approval-hierarchy',{branchId:branch,salesId:sales},'PUT')).status,403);
 assert.equal((await request('admin','/approval-hierarchy',{branchId:otherBranch,salesId:sales},'PUT')).status,200);
 const make=async(title:string)=>(await request('admin','/tasks',{...taskInput,title,assigneeId:assignee})).data.id as string;
 const simple=await make('РЗМ* В названии, но не в коде'),coded=await make('РВМ* Код с В'),marked=await make('РЗМ* Отметка контроля');
 const task=(id:string)=>'/tasks/'+id;
 const propose=(id:string)=>request(assignee,task(id)+'/approvals',{type:'deadline',reason:'Проверяем перенос крайнего срока',plan:'Уточнить данные и закончить работу',proposedDeadline:new Date(Date.now()+9*86400000).toISOString(),expectedVersion:1});
 const decide=async(actor:string,id:string,decision:string,comment:string)=>{
  const {rows:[current]}=await db.pool.query('SELECT action_revision,current_step FROM approvals WHERE id=$1',[id]);
  return request(actor,'/approvals/'+id+'/decision',{decision,comment,expectedRevision:current.action_revision,expectedStep:current.current_step});
 };
 try{
  assert.equal((await request(assignee,task(simple))).data.approvalProgress,null);
  assert.equal((await request(branch,task(simple))).status,200);
  assert.equal((await request(otherBranch,task(simple))).status,404);
  const explicit=(await request('admin','/tasks',{...taskInput,title:'РЗМ* Задача другого филиала',assigneeId:assignee,branchId:'Москва'})).data.id;
  assert.equal((await request(branch,task(explicit))).status,404);
  assert.equal((await request(otherBranch,task(explicit))).status,200);
  assert.equal((await propose(explicit)).status,201);
  assert.equal((await request(assignee,task(explicit))).data.approvals[0].route[0].userId,otherBranch);
  await db.pool.query("UPDATE users SET branch_id='Не указан' WHERE id=$1",[assignee]);
  const unresolved=await make('РЗМ* Задача на сверку');
  await db.pool.query('UPDATE users SET branch_id=$2 WHERE id=$1',[assignee,'Казань']);
  assert.equal((await propose(unresolved)).status,422);
  const classification={branchId:'Казань',expectedVersion:1};
  assert.equal((await request(assignee,task(unresolved)+'/branch',classification,'PUT')).status,403);
  assert.equal((await request('admin',task(unresolved)+'/branch',classification,'PUT')).status,200);
  assert.equal((await request(branch,task(unresolved))).status,200);
  assert.equal((await request(otherBranch,task(unresolved))).status,404);
  assert.equal((await request(assignee,task(marked)+'/approval-watch',{enabled:true},'PUT')).status,403);
  assert.equal((await request(sales,task(marked)+'/approval-watch',{enabled:true},'PUT')).status,200);
  assert.equal((await request(sales,task(marked))).data.approvalWatch.manual,true);
  assert.equal((await request(sales,task(coded))).data.approvalWatch.byCode,true);
  for(const [id,expected] of [[simple,[branch]],[coded,[branch,sales]],[marked,[branch,sales]]] as const){
   const approval=await propose(id);assert.equal(approval.status,201);
   const view=await request(assignee,task(id));
   assert.deepEqual(view.data.approvals[0].route.map((step:any)=>step.userId),expected);
   assert.deepEqual(view.data.approvalProgress,{type:'deadline',step:1,total:expected.length,label:'Руководитель подразделения',
    approver:users.find(person=>person.id===branch)?.name,clarificationBy:null,deferredUntil:null});
   if(id===coded){
    assert.equal((await decide(branch,approval.data.id,'clarify','Уточните поставку и новый срок')).status,200);
    const waiting=(await request(assignee,task(id))).data.approvalProgress;
    assert.equal(waiting.step,1);
    assert.equal(waiting.clarificationBy,users.find(person=>person.id===assignee)?.name);
    assert.equal((await request(assignee,'/approvals/'+approval.data.id+'/clarification',{answer:'Поставка подтверждена на новую дату'})).status,200);
    assert.equal((await request(assignee,task(id))).data.approvalProgress.clarificationBy,null);
   }
   assert.equal((await decide(sales,approval.data.id,'approve','Одобряю перенос')).status,403);
   const first=await decide(branch,approval.data.id,'approve','Согласен с новым сроком');assert.equal(first.status,200);
   assert.equal(first.data.state,expected.length===1?'approved':'pending');
   if(expected.length===2){
    const stage=(await request(assignee,task(id))).data.approvalProgress;
    assert.equal(stage.step,2);
    assert.equal(stage.approver,users.find(person=>person.id===sales)?.name);
    assert.equal((await decide(sales,approval.data.id,'approve','Подтверждаю новый срок')).data.state,'approved');
   }
   assert.equal((await request(assignee,task(id))).data.approvalProgress,null);
  }
  const result=await make('РВМ* Работа на приёмку');
  assert.equal((await request(assignee,task(result)+'/review',{action:'submit',comment:'Проверили готовый результат',expectedVersion:1})).status,200);
  assert.equal((await request(assignee,task(result))).data.approvalProgress.type,'completion');
  const first=(await request(assignee,task(result))).data.approvals[0].id;
  assert.equal((await decide(branch,first,'approve','')).status,403);
  assert.equal((await decide(sales,first,'reject','Уточните результат')).status,403);
  assert.equal((await decide('admin',first,'reject','Уточните результат')).data.state,'rejected');
  const returned=(await request(assignee,task(result))).data;
  assert.equal(returned.task.status,'active');assert.equal(returned.submissions[0].state,'returned');
  assert.equal((await request(assignee,task(result)+'/review',{action:'submit',comment:'Обновлённый результат готов',expectedVersion:returned.task.version})).status,200);
  const second=(await request(assignee,task(result))).data.approvals[0].id;
  assert.equal((await decide('admin',second,'approve','')).data.state,'approved');
  assert.equal((await request(assignee,task(result))).data.task.status,'completed');
  const manager=(await db.pool.query('SELECT * FROM users WHERE id=$1',[branch])).rows[0];
  const profile={name:manager.name,position:manager.position,branchId:manager.branch_id,expectedVersion:manager.version,role:'admin'};
  const {updateEmployeeProfile}=await import('../server/employee-profiles.js');
  const owner={...users.find(person=>person.id==='admin')!,root_access:true};
  assert.equal((await request('admin','/system/access/'+branch,profile,'PATCH')).status,403);
  await updateEmployeeProfile(owner,branch,profile);
  try{
   const overview=await request(branch,'/bootstrap');
   assert.equal(overview.data.user.role,'admin');
   assert(overview.data.approvals.some((approval:any)=>approval.task_id===explicit));
   const afterPromotion=await make('РЗМ* Согласование в подразделении');
   assert.equal((await propose(afterPromotion)).status,201);
   assert.equal((await request(assignee,task(afterPromotion))).data.approvals[0].route[0].userId,branch);
  }finally{
   await updateEmployeeProfile(owner,branch,{...profile,expectedVersion:manager.version+1,role:'branch_manager'});
  }
  const enableAll=async(approveAll:boolean)=>request('admin','/approval-hierarchy',{branchId:otherBranch,salesId:sales,approveAll},'PUT');
  const routeUsers=async(id:string)=>(await request(assignee,task(id))).data.approvals[0].route.map((step:{userId:string})=>step.userId);
  assert.equal((await enableAll(true)).data.sales_head_approves_all,true);
  assert.deepEqual(await routeUsers(explicit),[otherBranch,sales]);
  const ordinary=await make('РЗМ* Обычный перенос');
  const ordinaryApproval=await propose(ordinary);
  assert.equal(ordinaryApproval.status,201);
  assert.deepEqual(await routeUsers(ordinary),[branch,sales]);
  assert.equal((await decide(branch,ordinaryApproval.data.id,'approve','Подтверждаю перенос')).data.state,'pending');
  assert.equal((await decide(sales,ordinaryApproval.data.id,'approve','Подтверждаю перенос')).data.state,'approved');
  const ordinaryResult=await make('РЗМ* Обычная приёмка');
  assert.equal((await request(assignee,task(ordinaryResult)+'/review',{action:'submit',comment:'Работа готова к приёмке',expectedVersion:1})).status,200);
  assert.deepEqual(await routeUsers(ordinaryResult),['admin']);
  assert.equal((await enableAll(false)).data.sales_head_approves_all,false);
  assert.deepEqual(await routeUsers(ordinaryResult),['admin']);
  const direct=await request('admin','/approval-hierarchy',{branchId:otherBranch,salesId:sales,directAssigneeIds:[assignee]},'PUT');
  assert.equal(direct.status,200,JSON.stringify(direct.data));
  const moved=(await request(assignee,task(ordinaryResult))).data;
  assert.equal(moved.approvalProgress.total,1);
  assert.deepEqual(await routeUsers(ordinaryResult),['admin']);
  const movedApproval=moved.approvals[0];
  const decision={decision:'approve',comment:'',expectedRevision:movedApproval.action_revision,expectedStep:0};
  assert.equal((await request(branch,'/approvals/'+movedApproval.id+'/decision',decision)).status,403);
  assert.equal((await request(sales,'/approvals/'+movedApproval.id+'/decision',decision)).status,403);
  assert.equal((await request('admin','/approvals/'+movedApproval.id+'/decision',decision)).data.state,'approved');
  const directTask=await make('РЗМ* Один согласующий');
  assert.equal((await request('admin',task(directTask)+'/review',{action:'complete',comment:'',expectedVersion:1})).status,403);
  assert.equal((await propose(directTask)).status,201);
  assert.deepEqual(await routeUsers(directTask),[sales]);
  const outsideId=(await request('admin','/tasks',{...taskInput,title:'РЗМ* Вне контроля',assigneeId:'anna'})).data.id;
  const shifted=await request('anna',task(outsideId)+'/approvals',{type:'deadline',reason:'Новый срок для текущей работы',plan:'Выполнить по уточнённому графику',proposedDeadline:new Date(Date.now()+9*86400000).toISOString(),expectedVersion:1});
  assert.equal(shifted.data.applied,true);
  assert.deepEqual((await request('anna',task(outsideId))).data.approvals,[]);
 }finally{
  await db.pool.query('DELETE FROM approval_hierarchy WHERE id=1');
  await db.pool.query('UPDATE users SET company_branch_access=false WHERE id=$1',[branch]);
 }
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
  let rows=(await db.pool.query("SELECT * FROM task_alerts WHERE recipient_id='anna' AND kind='morning' AND dedupe_key LIKE '%2035-01-01'")).rows;assert.equal(rows.length,1);assert(rows[0].report_id);const morning=(await db.pool.query('SELECT * FROM reports WHERE id=$1',[rows[0].report_id])).rows[0];assert(morning.rows.some((t:any)=>t.id===before));assert(!morning.rows.some((t:any)=>t.id==='2403'));
  const t=(await service.detail(users.find(u=>u.id==='admin')!,before)).task;
  await request('anna',`/tasks/${before}/review`,{action:'submit',comment:'Результат представлен на приёмку',expectedVersion:t.version});
  await tickTaskReminders(new Date('2035-01-01T12:00:00+03:00'));
  rows=(await db.pool.query("SELECT * FROM task_alerts WHERE recipient_id='anna' AND kind='noon' AND dedupe_key LIKE '%2035-01-01'")).rows;assert.equal(rows.length,1);const noon=(await db.pool.query('SELECT * FROM reports WHERE id=$1',[rows[0].report_id])).rows[0];assert(!noon.rows.some((t:any)=>t.id===before));assert.equal((await db.pool.query("SELECT count(*)::int n FROM task_alerts WHERE kind='morning' AND due_at='2035-01-01T06:00:00Z'")).rows[0].n>=1,true);
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

test('the bot asks to acknowledge only reminders that are due and still valid',async()=>{
 const anna=users.find(u=>u.id==='anna')!;
 const {botView}=await import('../server/bot.js');
 const alerts=[
  [randomUUID(),'-5 minutes','5 minutes'],
  [randomUUID(),'5 minutes','15 minutes'],
  [randomUUID(),'-15 minutes','-5 minutes']
 ];
 try{
  for(const [id,due,expires] of alerts){
   await db.pool.query("INSERT INTO task_alerts(id,dedupe_key,recipient_id,kind,body,due_at,expires_at) VALUES($1::uuid,$1::uuid::text,$2,'task',$1::uuid::text,now()+$3::interval,now()+$4::interval)",[id,anna.id,due,expires]);
  }
  const response=await request('anna','/alerts');
  assert.equal(response.status,200);
  for(const [id] of alerts)assert.ok(response.data.find((alert:{id:string;expires_at:string})=>alert.id===id)?.expires_at);
  const menu=await botView(anna,'test:reminder-menu',{op:'alerts'});
  const tokens=menu.buttons.flat().filter(button=>button.text.startsWith('ОК ·')).map(button=>button.token);
  const targets=await db.pool.query("SELECT payload->>'target' id FROM bot_buttons WHERE token=ANY($1)",[tokens]);
  assert(targets.rows.some(row=>row.id===alerts[0][0]));
  assert(!targets.rows.some(row=>row.id===alerts[1][0]||row.id===alerts[2][0]));
 }finally{
  await db.pool.query("DELETE FROM task_alerts WHERE id=ANY($1)",[alerts.map(([id])=>id)]);
 }
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
 try{assert((await service.listReports(admin,{kind:'nextday',page:0})).items.some((r:any)=>r.id===report.id));await automation.saveAutomation(admin,{enabled:true,morning:'09:00',evening:'18:00'});await automation.tick(new Date('2035-01-11T18:01:00+03:00'));assert.equal((await db.pool.query("SELECT count(*)::int n FROM reports WHERE day='2035-01-11' AND kind='daily' AND slot='scheduled-evening'")).rows[0].n,1);}finally{const current=await service.config();await service.saveRules(admin,cfg.config,current.version);await automation.saveAutomation(admin,{enabled:false,morning:'09:00',evening:'18:00'});}
});

test('price is required for new tasks, can be edited with audit, and stays unchanged when omitted in an unrelated edit',async()=>{
 const {price:_,...without}=taskInput;assert.equal((await request('admin','/tasks',without)).status,400);assert.equal((await request('admin','/tasks',{...taskInput,price:-1})).status,400);
 const created=await request('admin','/tasks',{...taskInput,price:0});assert.equal(created.status,201);const id=created.data.id;
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,price:55000,expectedVersion:1,reason:'Уточнение цены по документам'},'PUT')).status,200);
 assert.equal((await request('admin',`/tasks/${id}`,{...without,description:'Описание с сохранением цены',expectedVersion:2,reason:'Уточнение содержания работы'},'PUT')).status,200);
 const t=(await service.detail(users.find(u=>u.id==='admin')!,id)).task;assert.equal(Number(t.price),55000);assert.equal((await db.pool.query("SELECT data FROM task_events WHERE task_id=$1 AND kind='task_edited' ORDER BY created_at",[id])).rows[0].data.after.price,'55000.00');
});

test('day reports freeze morning work, track closures by time and manager, filter prices and reconstruct historical states',async()=>{
 const admin=users.find(u=>u.id==='admin')!,uid='report-worker-'+crypto.randomUUID().slice(0,8),employee={id:uid,name:'Менеджер отчётов',role:'employee' as const,branch_id:'Москва',position:'Менеджер'};
 await db.pool.query('INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,$4,$5)',[employee.id,employee.name,employee.role,employee.branch_id,employee.position]);
 const create=async(title:string,deadline:string,price:number)=>{const id='R-'+crypto.randomUUID().slice(0,8);const row=(await db.pool.query("INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,deadline,status,priority,code,important,customer_risk,price,created_at,updated_at) VALUES($1,$2,'Фикстура отчётов','Москва',$3,'admin',$4,'active','normal','РЗМ*',true,false,$5,'2034-12-29T00:00:00Z','2034-12-29T00:00:00Z') RETURNING *",[id,title,uid,deadline,price])).rows[0];await db.pool.query("INSERT INTO task_events(id,task_id,actor_id,kind,message,data,created_at) VALUES($1,$2,'admin','created','Фикстура создана',$3,'2034-12-29T00:00:00Z')",[crypto.randomUUID(),id,JSON.stringify({after:row})]);return id;};
 const transition=async(id:string,status:string,time:string,actor:string,kind:string)=>{const before=(await db.pool.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];const after=(await db.pool.query("UPDATE tasks SET status=$2,version=version+1,completed_at=CASE WHEN $2='completed' THEN $3::timestamptz ELSE NULL END,updated_at=$3 WHERE id=$1 RETURNING *",[id,status,time])).rows[0];await db.pool.query('INSERT INTO task_events(id,task_id,actor_id,kind,message,data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),id,actor,kind,'Фикстура результата',JSON.stringify({before,after,comment:'Результат проверен'}),time]);};
 const overdue=await create('РЗМ* Долг','2034-12-31T12:00:00Z',4999),today=await create('РЗМ* Сегодня','2035-01-01T12:00:00Z',500000),future=await create('РЗМ* Завтра','2035-01-02T12:00:00Z',55000),past=await create('РЗМ* Закрыто раньше','2034-12-30T12:00:00Z',10000);
 await transition(past,'review','2034-12-31T07:00:00Z',uid,'review_submitted');await transition(past,'completed','2034-12-31T08:00:00Z','director','task_completed');
 const p={assigneeId:uid},morningAt=new Date('2035-01-01T09:00:00+03:00');const [a,duplicate]=await Promise.all([service.makeReport(admin,'snapshot','new-workday-am',morningAt,p),service.makeReport(admin,'snapshot','new-workday-am',morningAt,p)]);assert.equal(a.id,duplicate.id);assert.deepEqual(new Set(a.rows.map(t=>t.id)),new Set([overdue,today]));assert.equal(a.summary!.front.total,2);assert.equal(a.summary!.prices.low,1);assert.equal(a.summary!.prices.premium,1);await assert.rejects(()=>db.pool.query("UPDATE work_fronts SET rows='[]' WHERE user_id=$1 AND day='2035-01-01'",[uid]),/append-only/);
 await transition(today,'review','2035-01-01T09:45:00+03:00',uid,'review_submitted');await transition(today,'completed','2035-01-01T10:00:00+03:00','director','task_completed');
 const b=await service.makeReport(admin,'snapshot','new-workday-mid',new Date('2035-01-01T11:00:00+03:00'),{...p,queue:'all'});assert.equal(b.summary!.previous!.id,a.id);assert.equal(b.summary!.previous!.at,a.summary!.to);assert.equal(b.summary!.activity.closed,1);assert.equal(b.summary!.front.total,2);assert.equal(b.summary!.front.closed,1);assert.equal(b.summary!.front.remaining,1);assert(!b.rows.some(t=>[past,future].includes(t.id)));assert.equal(b.summary!.team.find(t=>t.id===uid)!.closed,1);assert.equal(b.summary!.team.find(t=>t.id==='director')!.closedByActor,1);
 const debt=await service.makeReport(admin,'overdue','new-workday-debt',new Date('2035-01-01T11:00:00+03:00'),p);assert.equal(debt.summary!.activity.closed,0);assert.equal(debt.rows.length,1);
 const period=await service.makeReport(admin,'period','new-workday-period',new Date('2035-01-01T11:00:00+03:00'),{...p,from:'2035-01-01T09:50:00+03:00',to:'2035-01-01T10:30:00+03:00',priceBand:'premium'});assert.equal(period.rows.length,1);assert.equal(period.summary!.activity.closed,1);assert.equal(period.summary!.activity.submitted,0);
 const byActor=await service.makeReport(admin,'period','new-workday-actor',new Date('2035-01-01T11:00:00+03:00'),{...p,actorId:'director'});assert.equal(byActor.summary!.activity.processed,1);assert.equal(byActor.summary!.team.find(t=>t.id==='director')!.processedByActor,1);
 const historical=await service.makeReport(admin,'snapshot','new-workday-history',new Date('2035-01-01T11:00:00+03:00'),{...p,to:'2035-01-01T09:30:00+03:00'});assert.equal(historical.rows.find(t=>t.id===today)!.status,'active');assert.equal(historical.summary!.activity.closed,0);
 const early=await service.makeReport(admin,'period','new-workday-unknown-history',new Date('2035-01-01T11:00:00+03:00'),{...p,from:'2000-01-01T00:00:00Z',to:'2000-12-31T23:59:59Z'});assert.equal(early.summary!.stateAvailable,false);assert.equal(early.rows.length,0);assert(early.summary!.notes.some(n=>n.includes('недоступно')));
 const evening=await service.makeReport(admin,'daily','new-workday-pm',new Date('2035-01-01T19:01:00+03:00'),p);assert.equal(evening.summary!.front.closed,1);assert.equal(evening.summary!.tomorrow.day,'2035-01-02');assert.deepEqual(new Set(evening.summary!.tomorrow.ids),new Set([overdue,future]));
 const own=await service.makeReport(employee,'snapshot','new-workday-own',new Date('2035-01-01T11:00:00+03:00'));assert(own.rows.every(t=>t.assignee_id===uid));await assert.rejects(()=>service.makeReport(employee,'snapshot','new-workday-forbidden',new Date('2035-01-01T11:00:00+03:00'),{assigneeId:'anna'}),/только по своим/);
 const pdf=await fetch(base+'/api/reports/'+b.id+'/pdf',{headers:{Cookie:cookies.get('admin')!}});assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert(bytes.includes(Buffer.from('%%EOF')));assert.equal((await fetch(base+'/api/reports/'+b.id+'/pdf',{headers:{Cookie:cookies.get('anna')!}})).status,404);
 const print=await fetch(base+'/api/reports/'+b.id+'/print',{headers:{Cookie:cookies.get('admin')!}});assert(!(await print.text()).includes('Состав отчёта'));
 await assert.rejects(()=>service.makeReport(admin,'snapshot','new-workday-am',morningAt,{...p,priceBand:'low'}),/другими параметрами/);
});

test('evening workday digest links the next plan and Telegram sends a PDF on request',async()=>{
 const {prepareWorkdayDigests}=await import('../server/workday-digests.js');
 const pilot=await import('../server/telegram-pilot.js'),bot=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!;
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=true');
 await db.pool.query("INSERT INTO telegram_binding(chat_id,user_id) VALUES('300','anna') ON CONFLICT(user_id) DO NOTHING");
 const {rows:[binding]}=await db.pool.query("SELECT chat_id FROM telegram_binding WHERE user_id='anna'");
 const original=globalThis.fetch,previous=process.env.TELEGRAM_BOT_TOKEN,documents:any[]=[];process.env.TELEGRAM_BOT_TOKEN='TEST_TOKEN';
 globalThis.fetch=(async(url:any,options:any)=>{
  if(String(url).includes('sendDocument')){assert(options.body instanceof FormData);const file=options.body.get('document') as Blob;assert(file);const bytes=Buffer.from(await file.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');documents.push({chat:options.body.get('chat_id'),type:file.type});}
  return new Response(JSON.stringify({ok:true,result:{message_id:3100}}));
 }) as typeof fetch;
 try{
  const now=new Date('2035-01-08T19:01:00+03:00');
  await prepareWorkdayDigests(now);await prepareWorkdayDigests(now);
  const {rows:[scheduled]}=await db.pool.query("SELECT management_notice FROM outbox WHERE recipient_id='anna' AND dedupe_key='workday:2035-01-08:anna'");
  assert(scheduled?.management_notice.planReportId);
  const report=await service.getReport(anna,scheduled.management_notice.planReportId);
  assert.equal(report.summary.tomorrow.day,'2035-01-09');
  assert(report.rows.every((t:any)=>t.assignee_id==='anna'));
  const view=await bot.botView(anna,'telegram:'+binding.chat_id,{op:'reports',id:report.id});assert.equal(view.format,'HTML');
  await pilot.handlePilotUpdate({update_id:4000,callback_query:{id:'pdf-callback',data:botButton(view,'PDF отчёта'),message:{message_id:3000,chat:{id:Number(binding.chat_id),type:'private'}}}});
  assert.deepEqual(documents,[{chat:binding.chat_id,type:'application/pdf'}]);
 }finally{globalThis.fetch=original;if(previous===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=previous;await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');}
});

test('undo restores edited task with a new version and preserves immutable history',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 assert.equal((await request('admin',`/tasks/${id}`,{...taskInput,title:'РЗМ* Новое название',price:90000,reason:'Уточнение цены задачи',expectedVersion:1},'PUT')).status,200);
 const action=(await request('admin','/undo/last')).data;assert.equal(action.task_id,id);
 assert.equal((await request('director','/undo',{id:action.id,confirmed:true})).status,404);
 assert.equal((await request('admin','/undo',{id:action.id})).status,400);
 assert.equal((await request('admin','/undo',{id:action.id,confirmed:true})).status,200);
 const detail=(await request('admin',`/tasks/${id}`)).data;assert.equal(detail.task.title,taskInput.title);assert.equal(Number(detail.task.price),taskInput.price);assert.equal(detail.task.version,3);assert(detail.events.some((e:any)=>e.kind==='task_edited'));assert(detail.events.some((e:any)=>e.kind==='action_undone'));
 assert.equal((await db.pool.query('SELECT revision FROM mock_provider_tasks WHERE id=$1',[id])).rows[0].revision,3);
 assert.equal((await request('admin','/undo',{id:action.id,confirmed:true})).status,409);
 assert.equal((await db.pool.query('SELECT state FROM task_sync_queue WHERE task_id=$1 AND task_version=2',[id])).rows[0].state,'canceled');
});
test('undo review retains original acceptance and restores a linked open submission',async()=>{
 const id=(await request('director','/tasks',taskInput)).data.id;
 await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Результат передан на проверку',expectedVersion:1});
 await request('director',`/tasks/${id}/review`,{action:'accept',comment:'Результат принят руководителем',expectedVersion:2});
 const action=(await request('director','/undo/last')).data;
 assert.equal((await request('director','/undo',{id:action.id,confirmed:true})).status,200);
 let detail=(await request('director',`/tasks/${id}`)).data;assert.equal(detail.task.status,'review');assert.equal(detail.submissions.length,1);assert.equal(detail.submissions[0].state,'review');assert(detail.submissions[0].restored_from);
 const original=(await db.pool.query("SELECT * FROM task_submissions WHERE task_id=$1 AND state='accepted'",[id])).rows[0];assert(original.withdrawn_at);assert.equal(original.remark,'Результат принят руководителем');
 assert.equal((await request('director',`/tasks/${id}/review`,{action:'return',comment:'Нужно уточнить расчёты',expectedVersion:4})).status,200);
 const second=(await request('director','/undo/last')).data;assert.equal((await request('director','/undo',{id:second.id,confirmed:true})).status,200);
 detail=(await request('director',`/tasks/${id}`)).data;assert.equal(detail.task.status,'review');assert.equal(detail.submissions.length,1);
 const admin=users.find(u=>u.id==='admin')!;const report=await service.makeReport(admin,'period','undo-'+id,new Date(),{assigneeId:'anna'});assert(!report.summary!.activity.closedIds.includes(id));
});
test('undo deadline approval reopens its stage and allows a fresh decision without rewriting the old one',async()=>{
 const admin=users.find(u=>u.id==='admin')!,cfg=await service.config();await service.saveRules(admin,{...cfg.config,routes:{deadline:['branchManager','salesHead'],completion:['creator']}},cfg.version);
 const id=(await request('admin','/tasks',taskInput)).data.id;
 const a=(await request('anna',`/tasks/${id}/approvals`,{type:'deadline',reason:'Необходима дополнительная проверка',plan:'Проверить расчёты и передать результат',proposedDeadline:new Date(Date.now()+14*86400000).toISOString(),expectedVersion:1})).data;
 await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Срок согласован руководителем',expectedStep:0});
 const first=(await request('lead-msk','/undo/last')).data;assert.equal((await request('lead-msk','/undo',{id:first.id,confirmed:true})).status,200);
 assert.equal((await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Старая кнопка согласования',expectedStep:0,expectedRevision:1})).status,409);
 assert.equal((await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Срок подтверждён повторно',expectedStep:0,expectedRevision:2})).status,200);
 assert.equal((await request('head',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Окончательное согласование срока',expectedStep:1,expectedRevision:2})).status,200);
 const final=(await request('head','/undo/last')).data;assert.equal((await request('head','/undo',{id:final.id,confirmed:true})).status,200);
 let detail=(await request('anna',`/tasks/${id}`)).data;assert.equal(detail.task.deadline,taskInput.deadline);assert.equal(detail.task.transfer_count,0);assert.equal(detail.approvals[0].current_step,1);assert.equal(detail.approvals[0].state,'pending');assert(detail.decisions.some((d:any)=>d.retracted));
 assert.equal((await request('head',`/approvals/${a.id}/decision`,{decision:'approve',comment:'Подтверждение после отмены',expectedStep:1,expectedRevision:3})).status,200);
 detail=(await request('anna',`/tasks/${id}`)).data;assert.equal(detail.task.transfer_count,1);
});
test('undo refuses later task activity and expired actions; comment undo preserves its original audit record',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 await request('anna',`/tasks/${id}/comments`,{body:'Первый комментарий исполнителя'});const own=(await request('anna','/undo/last')).data;
 await request('director',`/tasks/${id}/comments`,{body:'Следующее действие руководителя'});assert.equal((await request('anna','/undo',{id:own.id,confirmed:true})).status,409);
 const last=(await request('director','/undo/last')).data;assert.equal((await request('director','/undo',{id:last.id,confirmed:true})).status,200);
 const detail=(await request('director',`/tasks/${id}`)).data;assert.equal(detail.comments.length,1);assert(detail.events.some((e:any)=>e.data.body==='Следующее действие руководителя'));
 await request('director',`/tasks/${id}/comments`,{body:'Действие с истёкшим временем'});const expired=(await request('director','/undo/last')).data;
 await db.pool.query("UPDATE undo_actions SET created_at=now()-interval '6 minutes' WHERE id=$1",[expired.id]);assert.equal((await request('director','/undo',{id:expired.id,confirmed:true})).status,409);
});
test('staff rollout covers the approved groups and keeps individual settings and approval routes separate',async()=>{
 const admin=users.find(user=>user.role==='admin')!;
 const owner={...admin,root_access:true};
 const {setStaffRollout,staffWorkIds}=await import('../server/staff-rollout.js');
 const profiles=[
  {name:'Ирина Тестова',position:'Менеджер по продажам',branchId:'Краснодар',role:'employee'},
  {name:'Марина Борисова',position:'Аналитик',branchId:'Технический отдел',role:'employee'},
  {name:'Павел Соколов',position:'Руководитель отдела закупок',branchId:'Закупки',role:'branch_manager'},
  {name:'Олег Ветров',position:'Кладовщик',branchId:'AQUAS / Склад',role:'employee'}
 ];
 const ids:string[]=[];
 for(const profile of profiles){
  const response=await request(admin.id,'/system/access',profile);
  assert.equal(response.status,201,JSON.stringify(response.data));
  ids.push(response.data.user.id);
 }
 const [sales,analytics,leader,warehouse]=ids;
 const previous=(await db.pool.query('SELECT * FROM approval_hierarchy WHERE id=1')).rows[0];
 try{
  assert.equal((await request(admin.id,'/system/staff-rollout',{enabled:true,confirmed:true},'PUT')).status,403);
  await setStaffRollout(owner,true);
  const controlled=await staffWorkIds(db.pool);
  assert(controlled?.includes(sales));
  assert(controlled?.includes(analytics));
  assert(controlled?.includes(leader));
  assert(!controlled?.includes(warehouse));
  assert.equal((await request(admin.id,'/system/access/'+analytics+'/work-control',{enabled:false},'PUT')).status,200);
  assert(!(await staffWorkIds(db.pool))?.includes(analytics));
  assert.equal((await request(admin.id,'/system/access/'+analytics+'/work-control',{enabled:null},'PUT')).status,200);
  assert((await staffWorkIds(db.pool))?.includes(analytics));
  const directory=await request(admin.id,'/system/access');
  const salesProfile=directory.data.find((person:{id:string})=>person.id===sales);
  assert.deepEqual(salesProfile.work_groups,['sales']);
  assert(salesProfile.work_controlled);
  assert.deepEqual((await db.pool.query('SELECT * FROM approval_hierarchy WHERE id=1')).rows[0],previous);
 }finally{await setStaffRollout(owner,false);}
});

test('the staff administrator can create a profile and account while privileged access stays with the owner',async()=>{
 const actor=users.find(user=>user.role==='admin')!;
 const director=users.find(user=>user.role==='director')!;
 const person={name:'Андрей Чистов',position:'Аналитик',branchId:'Технический отдел'};
 assert.equal((await request(actor.id,'/system/access',{...person,role:'admin'})).status,403);
 const created=await request(actor.id,'/system/access',{...person,role:'employee'});
 assert.equal(created.status,201);
 assert.equal((await request(actor.id,'/system/access',{...person,role:'employee'})).status,409);
 const id=created.data.user.id;
 assert.equal((await request(actor.id,'/system/access/'+id,{...person,role:'director',expectedVersion:1},'PATCH')).status,403);
 assert.equal((await request(actor.id,'/system/access/'+id+'/account',{username:'a.chistov'})).status,201);
 assert.equal((await request(actor.id,'/system/access/'+director.id+'/account',{username:'protected-director'})).status,403);
 assert.equal((await request(actor.id,'/system/access/'+director.id+'/telegram',{telegramId:'12345678',confirmed:true},'PUT')).status,403);
 assert.equal((await request(actor.id,'/telegram/pairing',{userId:director.id})).status,403);
});

test('management observation is personal, confirmed, role protected and does not reset deadlines',async()=>{
 assert.equal((await request('anna','/management/progress')).status,403);
 const initial=(await request('director','/management/progress')).data;
 const before=(await request('director','/bootstrap')).data.metrics;
 assert.equal((await request('director','/management/observation',{expected:initial.mark?.started_at||null})).status,400);
 assert.equal((await request('director','/management/observation',{expected:initial.mark?.started_at||null,confirmed:true})).status,200);
 assert.equal((await request('director','/management/observation',{expected:initial.mark?.started_at||null,confirmed:true})).status,409);
 const now=(await request('director','/management/progress')).data;assert.equal(now.totals.completed,0);assert.equal(now.totals.returned,0);
 assert.deepEqual((await request('director','/bootstrap')).data.metrics,before);
 assert.equal((await request('director','/management/nudge',{confirmed:true})).status,409);
 const lead=(await request('lead-msk','/management/progress')).data;const visible=(await request('lead-msk','/bootstrap')).data;assert(lead.rows.every((r:any)=>visible.tasks.some((t:any)=>t.assignee_id===r.id)));
});

test('bot discussion shares task comments and undo requires a separate confirmation',async()=>{
 const bot=await import('../server/bot.js'),anna=users.find(u=>u.id==='anna')!;
 const id=(await request('admin','/tasks',taskInput)).data.id;
 let view=await bot.botView(anna,'preview',{op:'task',id});view=await bot.botClick(anna,'preview',botButton(view,'Обсуждение'));view=await bot.botClick(anna,'preview',botButton(view,'Написать комментарий'));
 view=await bot.botText(anna,'preview','Комментарий из рабочего бота по задаче',crypto.randomUUID());view=await bot.botClick(anna,'preview',botButton(view,'Подтвердить и отправить'));
 let detail=(await request('anna',`/tasks/${id}`)).data;assert.equal(detail.comments.length,1);
 const prepare=await bot.botClick(anna,'preview',botButton(view,'Отменить последнее действие'));
 assert.equal((await request('anna',`/tasks/${id}`)).data.comments.length,1);
 const button=botButton(prepare,'Да, отменить действие');const first=await bot.botClick(anna,'preview',button);assert.deepEqual(await bot.botClick(anna,'preview',button),first);
 detail=(await request('anna',`/tasks/${id}`)).data;assert.equal(detail.comments.length,0);assert(detail.events.some((e:any)=>e.kind==='action_undone'));
});
test('clarification action belongs to requester rather than approver until answered',async()=>{
 const {actionItems}=await import('../shared/actions.js');const id=(await request('admin','/tasks',taskInput)).data.id;
 const a=(await request('anna',`/tasks/${id}/approvals`,{type:'deadline',reason:'Требуется дополнительная сверка данных',plan:'Проверить строки и передать отчёт',proposedDeadline:new Date(Date.now()+16*86400000).toISOString(),expectedVersion:1})).data;
 await request('lead-msk',`/approvals/${a.id}/decision`,{decision:'clarify',comment:'Что именно ещё осталось проверить?',expectedStep:0});
 const anna=actionItems((await request('anna','/bootstrap')).data).find(a=>a.taskId===id&&a.kind==='clarification');assert(anna?.mine);assert.equal(anna?.ownerId,'anna');
 const lead=actionItems((await request('lead-msk','/bootstrap')).data).find(a=>a.taskId===id&&a.kind==='clarification');assert.equal(lead?.mine,false);
});
test('playful nudge is opt-in, scoped to bound recipients, confirmed and rate limited',async()=>{
 await db.pool.query("INSERT INTO telegram_binding(chat_id,user_id) VALUES('901','anna'),('902','olga') ON CONFLICT(user_id) DO NOTHING");
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=true');
 assert.equal((await request('lead-msk','/management/preferences',{enabled:true},'PUT')).status,200);
 assert.equal((await request('lead-msk','/management/nudge',{})).status,400);
 const sent=await request('lead-msk','/management/nudge',{confirmed:true});assert.equal(sent.status,200);assert(sent.data.recipients>=1);
 const notifications=(await db.pool.query("SELECT recipient_id FROM outbox WHERE dedupe_key LIKE 'management-nudge:%'")).rows;assert(notifications.some(n=>n.recipient_id==='anna'));assert(!notifications.some(n=>n.recipient_id==='olga'));
 assert.equal((await request('lead-msk','/management/nudge',{confirmed:true})).status,429);
 await request('lead-msk','/management/preferences',{enabled:false},'PUT');assert.equal((await request('lead-msk','/management/nudge',{confirmed:true})).status,409);
 await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');
});

test('positive bot review may omit comment but still requires confirmation',async()=>{
 const bot=await import('../server/bot.js'),director=users.find(u=>u.id==='director')!;
 const id=(await request('director','/tasks',taskInput)).data.id;await request('anna',`/tasks/${id}/review`,{action:'submit',comment:'Готовая работа передана',expectedVersion:1});
 const card=await bot.botView(director,'preview',{op:'task',id}),view=await bot.botClick(director,'preview',botButton(card,'Проверить результат'));
 const prompt=await bot.botClick(director,'preview',botButton(view,'Принять без комментария'));
 assert.equal((await request('director',`/tasks/${id}`)).data.task.status,'review');await bot.botClick(director,'preview',botButton(prompt,'Да, принять результат'));
 assert.equal((await request('director',`/tasks/${id}`)).data.submissions[0].remark,null);
});
test('approval discussion is linked to its request, shared with panel and journal respects scope',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;
 const a=(await request('anna',`/tasks/${id}/approvals`,{type:'deadline',reason:'Необходимо уточнение по расчёту',plan:'Сверить расчёт и передать результат',proposedDeadline:new Date(Date.now()+17*86400000).toISOString(),expectedVersion:1})).data;
 assert.equal((await request('anna',`/tasks/${id}/comments`,{body:'Сообщение по конкретному переносу',approvalId:a.id})).status,200);
 const bootstrap=(await request('anna','/bootstrap')).data;assert(bootstrap.approvalComments.some((c:any)=>c.approval_id===a.id&&c.body==='Сообщение по конкретному переносу'));
 const journal=(await request('anna','/journal?q='+encodeURIComponent('Сообщение по конкретному переносу'))).data;assert.equal(journal.total,1);assert.equal(journal.items[0].task_id,id);
 const foreign=(await request('olga','/journal?q='+encodeURIComponent('Сообщение по конкретному переносу'))).data;assert.equal(foreign.total,0);
 assert.equal((await request('anna','/journal?from=2026-11-04&to=2026-11-03')).status,400);
});
test('concurrent undo applies once and a changed parent hierarchy cannot be restored into a cycle',async()=>{
 const id=(await request('admin','/tasks',taskInput)).data.id;await request('anna',`/tasks/${id}/comments`,{body:'Проверка повторной отмены'});const a=(await request('anna','/undo/last')).data;
 const replies=await Promise.all([request('anna','/undo',{id:a.id,confirmed:true}),request('anna','/undo',{id:a.id,confirmed:true})]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
 const parent=(await request('director','/tasks',taskInput)).data.id,child=(await request('admin','/tasks',{...taskInput,parentId:parent})).data.id;
 assert.equal((await request('admin',`/tasks/${child}`,{...taskInput,parentId:null,reason:'Убрать родительскую связь',expectedVersion:1},'PUT')).status,200);
 const edit=(await request('admin','/undo/last')).data;
 assert.equal((await request('director',`/tasks/${parent}`,{...taskInput,parentId:child,reason:'Новая родительская связь',expectedVersion:1},'PUT')).status,200);
 assert.equal((await request('admin','/undo',{id:edit.id,confirmed:true})).status,409);
});

test('a malformed bridge response is uncertain delivery rather than definite Telegram rejection',async()=>{
 const {deliver}=await import('../server/telegram-pilot.js'),saved=globalThis.fetch,previous=process.env.TELEGRAM_BOT_TOKEN;process.env.TELEGRAM_BOT_TOKEN='TEST_TOKEN';
 const id=(await request('admin','/tasks',taskInput)).data.id,alert=crypto.randomUUID();
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=true,enabled_at=now()');
 await db.pool.query("INSERT INTO telegram_binding(chat_id,user_id) VALUES('903','anna') ON CONFLICT(user_id) DO UPDATE SET paired_at=now()");
 await db.pool.query("INSERT INTO task_alerts(id,dedupe_key,recipient_id,task_id,kind,body,due_at,expires_at) VALUES($1,$3,'anna',$2,'task','Тест недостоверного ответа',now(),now()+interval '1 hour')",[alert,id,'malformed:'+alert]);
 globalThis.fetch=async()=>new Response(JSON.stringify({proxy_error:true}),{status:502});
 try{await deliver(new Date());const delivery=(await db.pool.query('SELECT state FROM task_alert_deliveries WHERE alert_id=$1',[alert])).rows[0];assert.equal(delivery.state,'uncertain');}
 finally{globalThis.fetch=saved;if(previous===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=previous;await db.pool.query('UPDATE telegram_settings SET enabled=false,delivery=false');}
});

test('system health and access directory enforce administrator scope and omit credentials',async()=>{
 for(const path of ['/system/status','/system/access']){
  assert.equal((await request('anna',path)).status,403);
  assert.equal((await request('director',path)).status,403);
 }
 await db.pool.query("DELETE FROM telegram_response_times");
 await db.pool.query("INSERT INTO telegram_response_times(kind,ok,duration_ms) VALUES('menu',true,200),('menu',false,900)");
 const health=await request('admin','/system/status');
 assert.equal(health.status,200);
 assert.deepEqual(health.data.telegram.timings.find((row:any)=>row.kind==='menu'),{kind:'menu',samples:2,errors:1,median:200,p95:200});
 const directory=await request('admin','/system/access');
 assert.equal(directory.status,200);
 const anna=directory.data.find((person:any)=>person.id==='anna');
 assert.equal(anna.visibleTasks,(await service.visibleTasks(users.find(u=>u.id==='anna')!)).length);
 for(const secret of ['password_hash','token_hash','chat_id'])assert.ok(!JSON.stringify(directory.data).includes(secret));
});

test('Bitrix staging does not touch live tasks, and linked fields reconcile without overwriting conflicts',async()=>{
 const {linkTask,scanProject,syncLinkedTask,syncActivity}=await import('../server/bitrix-sync.js');
 const {webhookBase}=await import('../server/bitrix-rest.js');
 assert.throws(()=>webhookBase('https://another.example/rest/1/test/','portal.example'),/вебхука/);
 const local=(await db.pool.query("SELECT * FROM tasks WHERE id='2401'")).rows[0];
 const external={id:'987654',title:local.title,description:local.description,deadline:local.deadline,chatId:99};
 let writes=0;
 const transport:import('../server/bitrix-rest.js').BitrixRequest=async <T>(method:import('../server/bitrix-rest.js').BitrixMethod,params:any):Promise<T>=>{
  if(method==='tasks.task.list')return {tasks:params.filter['>ID']==='0'?[external]:[]} as T;
  if(method==='tasks.task.get')return {task:{...external}} as T;
  if(method==='im.dialog.messages.get')return {messages:[{id:91,date:'2026-11-04T10:00:00+03:00',author_id:5,text:'Сообщение'}],users:[{id:5,name:'Автор'}]} as T;
  if(method==='tasks.task.history.list')return {list:[]} as T;
  assert.equal(method,'tasks.task.update');assert.deepEqual(params.fields,{DESCRIPTION:'Проверенная локальная правка'});
  writes++;external.description=params.fields.DESCRIPTION;return true as T;
 };
 assert.deepEqual(await scanProject(transport,'12','0',2),{total:1,cursor:external.id,complete:true});
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM bitrix_task_links')).rows[0].n,0);
 assert.equal((await linkTask(transport,local.id,external.id)).linked,true);
 external.title+=' Из Битрикс24';
 assert.deepEqual((await syncLinkedTask(transport,local.id,false)).inbound,['title']);
 const task=(await db.pool.query('SELECT * FROM tasks WHERE id=$1',[local.id])).rows[0];
 assert.equal(task.title,external.title);
 await db.pool.query('UPDATE tasks SET description=$2 WHERE id=$1',[local.id,'Проверенная локальная правка']);
 assert.deepEqual((await syncLinkedTask(transport,local.id,false)).outbound,['description']);
 assert.equal(writes,0);
 const baselineDescription=external.description;
 external.description='Другая правка с той стороны';
 assert.deepEqual((await syncLinkedTask(transport,local.id,true)).conflict,['description']);
 assert.equal(writes,0);
 external.description=baselineDescription;
 await syncLinkedTask(transport,local.id,true);
 assert.equal(writes,1);
 await syncLinkedTask(transport,local.id,true);
 assert.equal(writes,1);
 await syncActivity(transport,local.id);await syncActivity(transport,local.id);
 assert.equal((await request('anna','/tasks/'+local.id+'/bitrix-activity')).status,403);
 const activity=await request('admin','/tasks/'+local.id+'/bitrix-activity');
 assert.equal(activity.status,200);assert.equal(activity.data.length,1);assert.equal(activity.data[0].body,'Сообщение');
});

test('Bitrix REST calls share a persisted interval and enter cooldown after throttling',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {bitrixClient}=await import('../server/bitrix-rest.js');
 const folder=await mkdtemp(join(tmpdir(),'ruspet-bitrix-'));
 const file=join(folder,'webhook');
 const saved={portal:process.env.BITRIX_PORTAL,file:process.env.BITRIX_WEBHOOK_FILE,fetch:globalThis.fetch};
 try{
  await writeFile(file,'https://portal.example/rest/10/test-fixture/');
  process.env.BITRIX_PORTAL='portal.example';process.env.BITRIX_WEBHOOK_FILE=file;
  const calls:number[]=[];
  globalThis.fetch=async()=>{
   calls.push(performance.now());
   return calls.length===1?Response.json({result:{task:{}}}):Response.json({error:'QUERY_LIMIT_EXCEEDED'},{status:503});
  };
  const first=await bitrixClient(),second=await bitrixClient();
  const outcomes=await Promise.allSettled([first('tasks.task.get',{taskId:1}),second('tasks.task.get',{taskId:2})]);
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  assert.equal(calls.length,2);
  assert.ok(calls[1]-calls[0]>=1000);
  await assert.rejects(()=>second('tasks.task.get',{taskId:3}),/на паузе/);
  assert.equal(calls.length,2);
 }finally{
  globalThis.fetch=saved.fetch;
  if(saved.portal===undefined)delete process.env.BITRIX_PORTAL;else process.env.BITRIX_PORTAL=saved.portal;
  if(saved.file===undefined)delete process.env.BITRIX_WEBHOOK_FILE;else process.env.BITRIX_WEBHOOK_FILE=saved.file;
  await rm(file,{force:true});await rm(folder,{recursive:false}).catch(async()=>{await (await import('node:fs/promises')).rmdir(folder);});
 }
});

test('custom task fields survive edit and undo, and recurring runs create one scoped task',async()=>{
 const {nextOccurrence,runSchedules}=await import('../server/work-design.js');
 assert.equal(nextOccurrence('2026-01-31T09:00:00+03:00','monthly',1,new Date('2026-02-01')).toISOString(),'2026-02-28T06:00:00.000Z');
 assert.equal(nextOccurrence('2026-01-31T09:00:00+03:00','monthly',1,new Date('2026-03-01')).toISOString(),'2026-03-31T06:00:00.000Z');
 const template={title:'Техническая тестовая задача',description:'Описание',price:0,assigneeId:'anna',
  deadline:null,plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null,customFields:[{label:'Номер заказа',value:'14'}]};
 assert.equal((await request('admin','/tasks',{...template,customFields:[{label:'Код',value:'1'},{label:'код',value:'2'}]})).status,400);
 const created=await request('admin','/tasks',template);
 assert.equal(created.status,201);
 const path='/tasks/'+created.data.id;
 assert.deepEqual((await request('admin',path)).data.task.custom_fields,template.customFields);
 const edited=await request('admin',path,{...template,customFields:[{label:'Номер заказа',value:'15'}],expectedVersion:1,reason:'Проверка номера'},'PUT');
 assert.equal(edited.status,200);
 const {lastUndo,undoLastAction}=await import('../server/undo.js');
 const admin=users.find(u=>u.id==='admin')!,last=await lastUndo(admin,created.data.id);
 assert.ok(last);await undoLastAction(admin,last.id);
 assert.deepEqual((await request('admin',path)).data.task.custom_fields,template.customFields);
 const at=new Date(Date.now()+1000);
 const scheduled=await request('admin','/work-design/schedules',{template,frequency:'daily',every:1,startsAt:at.toISOString(),deadlineHours:3});
 assert.equal(scheduled.status,201);
 const runAt=new Date(at.getTime()+3*86400000);
 await Promise.all([runSchedules(runAt),runSchedules(runAt)]);
 const row=(await db.pool.query('SELECT * FROM task_schedules WHERE id=$1',[scheduled.data.id])).rows[0];
 assert.equal(row.next_at,new Date(at.getTime()+4*86400000).toISOString());
 const generated=(await request('anna','/tasks/'+row.last_task_id)).data.task;
 assert.deepEqual(generated.custom_fields,template.customFields);
 assert.equal(generated.deadline,new Date(runAt.getTime()+3*3600000).toISOString());
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM tasks WHERE title=$1',[template.title])).rows[0].n,2);
});

test('separate OKB database stores companies and triggers only active BPM rules once',async()=>{
 const name=database+'_okb';
 await adminConnection.query('CREATE DATABASE '+name);
 const url=new URL(process.env.DATABASE_URL!);url.pathname='/'+name;
 process.env.OKB_DATABASE_URL=url.toString();
 const okb=await import('../server/okb.js');
 const {runProcesses}=await import('../server/work-design.js');
 try{
  await okb.migrateOkb();
  const path='/okb/companies',work='/work-design/processes';
  assert.equal((await request('anna',path)).status,403);
  const input={name:'Тестовая компания',taxId:'0000000001',status:'prospect',contact:'',notes:''};
  const company=await request('director',path,input);
  assert.equal(company.status,201);
  assert.equal((await request('director',path,input)).status,409);
  const definition={name:'Начало работы',field:'company.status',operator:'=',value:'active',branch:'yes',title:'Связаться с {{company.name}}',assigneeId:'anna',price:0,deadlineHours:24};
  const preview=await request('director',work+'/preview',{definition,sample:{name:'Проба',status:'active',previousStatus:'prospect'}});
  assert.deepEqual(preview.data,{branch:'yes',title:'Связаться с Проба'});
  const created=await request('director',work,definition);
  assert.equal(created.status,201);await runProcesses();
  assert.equal((await request('director',work)).data.runs.length,0);
  const draft=(await request('director',work)).data.items.find((item:any)=>item.id===created.data.id);
  assert.equal(draft.enabled,false);
  assert.equal((await request('director',work+'/'+created.data.id,definition,'PUT')).status,200);
  assert.equal((await request('director',work+'/'+created.data.id,{enabled:true,expectedRevision:draft.revision},'PATCH')).status,409);
  assert.equal((await request('director',work+'/'+created.data.id,{enabled:true,expectedRevision:draft.revision+1},'PATCH')).status,200);
  const changed=await request('director',path+'/'+company.data.id,{...input,status:'active',version:1},'PUT');
  assert.equal(changed.status,200);
  assert.equal((await request('director',work+'/'+created.data.id,{...definition,title:'Черновик без публикации'},'PUT')).status,200);
  const changedDraft=(await request('director',work)).data.items.find((item:any)=>item.id===created.data.id);
  assert.equal(changedDraft.definition.title,'Черновик без публикации');
  assert.equal(changedDraft.published_definition.title,definition.title);
  assert.equal((await request('director',path+'/'+company.data.id,{...input,status:'former',version:1},'PUT')).status,409);
  await Promise.all([runProcesses(),runProcesses()]);
  const runs=(await request('director',work)).data.runs;
  assert.equal(runs.length,1);assert.equal(runs[0].branch,'yes');
  assert.equal((await request('anna','/tasks/'+runs[0].task_id)).data.task.title,'Связаться с Тестовая компания');
  assert.equal((await db.pool.query("SELECT to_regclass('companies') IS NULL AS isolated")).rows[0].isolated,true);
  const companyId=company.data.id,companyPath=path+'/'+companyId;
  assert.equal((await request('director',companyPath+'/work')).data.tasks[0].id,runs[0].task_id);
  assert.equal((await request('anna',companyPath+'/work')).status,403);
  const task={title:'Проверить тестовый заказ',description:'Ожидается результат',price:0,assigneeId:'anna',
   deadline:null,plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null,companyId};
  assert.equal((await request('anna','/tasks',task)).status,403);
  const make=await request('director','/tasks',task);
  assert.equal(make.status,201);
  const taskPath='/tasks/'+make.data.id;
  const detail=(await request('anna',taskPath)).data.task;
  const {rows:[savedTask]}=await db.pool.query('SELECT created_at FROM tasks WHERE id=$1',[make.data.id]);
  assert.equal(detail.created_at,savedTask.created_at);
  assert.deepEqual(detail.client_names,['Тестовая компания']);
  const taskFromCrm=runs[0].task_id,portal='task-client-fixture.example',externalId=90000123,companyRef='CO_8877';
  const {rows:[gate]}=await db.pool.query('SELECT portal FROM bitrix_rest_gate WHERE id=1');
  try{
   await db.pool.query('UPDATE bitrix_rest_gate SET portal=$1 WHERE id=1',[portal]);
   await okb.okbPool().query('UPDATE companies SET bitrix_portal=$1,bitrix_id=8877 WHERE id=$2',[portal,companyId]);
   await db.pool.query("UPDATE tasks SET company_id=NULL,source_fields=$2 WHERE id=$1",[taskFromCrm,JSON.stringify({'Компания':'Клиент из выгрузки'})]);
   await db.pool.query("INSERT INTO bitrix_task_snapshots(external_id,snapshot,raw) VALUES($1,'{}',$2)",
    [externalId,JSON.stringify({ufCrmTask:[companyRef,'L_997',companyRef]})]);
   await db.pool.query("INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,$2,'{}',1)",[taskFromCrm,externalId]);
   const compact=(await request('anna','/bootstrap?view=workspace')).data.tasks.find((row:any)=>row.id===taskFromCrm);
   assert.deepEqual(compact.client_names,['Тестовая компания']);
   assert.equal(compact.source_fields,undefined);
   const {botView}=await import('../server/bot.js');
   const bot=await botView(users.find(person=>person.id==='anna')!,'preview',{op:'task',id:taskFromCrm});
   assert.match(bot.text,/Создана:/);
   assert.match(bot.text,/Клиент: Тестовая компания/);
   await db.pool.query("UPDATE bitrix_task_snapshots SET raw='{\"ufCrmTask\":[\"CO_9999\"]}' WHERE external_id=$1",[externalId]);
   assert.deepEqual((await request('anna','/tasks/'+taskFromCrm)).data.task.client_names,['Клиент из выгрузки']);
  }finally{
   await db.pool.query('DELETE FROM bitrix_task_links WHERE task_id=$1',[taskFromCrm]);
   await db.pool.query('DELETE FROM bitrix_task_snapshots WHERE external_id=$1',[externalId]);
   await db.pool.query('UPDATE bitrix_rest_gate SET portal=$1 WHERE id=1',[gate.portal]);
   await db.pool.query("UPDATE tasks SET company_id=$2,source_fields='{}' WHERE id=$1",[taskFromCrm,companyId]);
  }
  const template={name:'Сохранённый шаблон',shared:true,content:{...task,customFields:[{label:'Объём',value:''}]}};
  assert.equal((await request('anna','/task-templates',template)).status,403);
  const saved=await request('director','/task-templates',template);assert.equal(saved.status,201);
  assert.equal((await request('anna','/task-templates')).data.length,0);
  const common=(await request('admin','/task-templates')).data.find((item:any)=>item.id===saved.data.id);
  assert.equal(common.content.companyId,undefined);
  assert.equal(common.content.customFields[0].label,'Объём');
  const acceptedRule=await request('director',work,{...definition,name:'После приёмки',trigger:'task_accepted',field:'task.title',operator:'contains',value:'тестовый заказ',title:'Архивировать: {{task.title}}',companyId});
  assert.equal(acceptedRule.status,201);
  assert.equal((await request('director',work+'/'+acceptedRule.data.id,{enabled:true},'PATCH')).status,200);
  assert.equal((await request('anna',taskPath+'/review',{action:'submit',comment:'Результат готов',expectedVersion:1})).status,200);
  assert.equal((await request('director',taskPath+'/review',{action:'accept',comment:'',expectedVersion:2})).status,200);
  await runProcesses();
  assert.equal((await request('director',work)).data.runs.filter((r:any)=>r.process_id===acceptedRule.data.id).length,0);
  const undone=await request('director','/tasks',{...task,title:'Отменённый тестовый заказ'});
  const undonePath='/tasks/'+undone.data.id;
  assert.equal((await request('anna',undonePath+'/review',{action:'submit',comment:'Результат готов',expectedVersion:1})).status,200);
  assert.equal((await request('director',undonePath+'/review',{action:'accept',comment:'',expectedVersion:2})).status,200);
  const {lastUndo,undoLastAction}=await import('../server/undo.js');
  const director=users.find(u=>u.id==='director')!;
  const action=await lastUndo(director,undone.data.id);assert.ok(action);
  await undoLastAction(director,action.id);
  const quietRule=await request('director',work,{...definition,name:'Контакт с клиентом',trigger:'company_quiet',quietDays:1,companyId});
  assert.equal(quietRule.status,201);
  assert.equal((await request('director',work+'/'+quietRule.data.id,{enabled:true},'PATCH')).status,200);
  assert.equal((await request('director',companyPath+'/contacts',{note:'Обсудили следующий заказ'})).status,201);
  assert.equal((await request('director',companyPath+'/contacts')).data.length,1);
  const later=new Date(Date.now()+2*86400000);
  await Promise.all([runProcesses(later),runProcesses(later)]);
  await runProcesses(later);
  const history=(await request('director',work)).data.runs;
  assert.equal(history.filter((r:any)=>r.process_id===acceptedRule.data.id&&r.task_id).length,1);
  assert.equal(history.filter((r:any)=>r.process_id===quietRule.data.id&&r.task_id).length,1);
  const jobs=(await request('director',companyPath+'/work')).data;
  assert.ok(jobs.tasks.some((t:any)=>t.title==='Архивировать: Проверить тестовый заказ'));
  const graphTask={title:'Создать первую по {{company.name}}',assigneeId:'anna',price:0,deadlineHours:24};
  const point={x:10,y:10};
  const graph={nodes:[
   {id:'start',type:'start',...point},{id:'check',type:'condition',config:{field:'company.status',operator:'=',value:'active'},...point},
   {id:'one',type:'task',config:graphTask,...point},{id:'two',type:'task',config:{...graphTask,title:'Создать вторую по {{company.name}}'},...point},
   {id:'end',type:'end',...point}
  ],edges:[{from:'start',to:'check',sourcePort:'next'},{from:'check',to:'one',sourcePort:'yes'},{from:'check',to:'end',sourcePort:'no'},
   {from:'one',to:'two',sourcePort:'next'},{from:'two',to:'end',sourcePort:'next'}]};
  const graphDefinition={...definition,name:'Граф проверки',graph};
  const invalid={...graph,edges:graph.edges.map(edge=>edge.from==='two'?{...edge,to:'one'}:edge)};
  const incomplete=await request('director',work,{...graphDefinition,name:'Цикл',graph:invalid});
  assert.equal(incomplete.status,201);
  assert.equal((await request('director',work+'/'+incomplete.data.id,{enabled:true},'PATCH')).status,400);
  const check=await request('director',work+'/preview',{definition:graphDefinition,sample:{name:'Проба',status:'active',previousStatus:'prospect'}});
  assert.equal(check.status,200);assert.equal(check.data.titles.length,2);assert.equal(check.data.trace[1].branch,'yes');
  const negative=await request('director',work+'/preview',{definition:graphDefinition,sample:{name:'Проба',status:'prospect',previousStatus:null}});
  assert.equal(negative.data.titles.length,0);assert.equal(negative.data.trace[1].branch,'no');
  const graphProcess=await request('director',work,graphDefinition);assert.equal(graphProcess.status,201);
  assert.equal((await request('director',work+'/'+graphProcess.data.id,{enabled:true},'PATCH')).status,200);
  assert.equal((await request('director',path,{...input,name:'Компания для графа',taxId:'0000000002',status:'active'})).status,201);
  await runProcesses();
  const graphRun=(await request('director',work)).data.runs.find((row:any)=>row.process_id===graphProcess.data.id);
  assert.equal(graphRun.task_ids.length,2);assert.equal(graphRun.trace.length,5);
 }finally{await okb.closeOkb();delete process.env.OKB_DATABASE_URL;await adminConnection.query('DROP DATABASE '+name);}
});

test('delegation creates a priced-zero child, enforces hierarchy and reuses the bot confirmation receipt',async()=>{
 const payload={title:'Контрольное поручение руководителя',description:'Уточнить готовность заказа',price:50000,assigneeId:'lead-msk',
  deadline:'2027-01-18T18:00:00+03:00',plannedStart:null,plannedEnd:null,important:true,customerRisk:true,parentId:null,
  customFields:[{label:'Заказ',value:'Технический'}]};
 const source=await request('director','/tasks',payload);
 assert.equal(source.status,201);
 const id=source.data.id,path='/tasks/'+id;
 const targets=await request('lead-msk',path+'/delegation-targets');
 assert.equal(targets.status,200);
 assert.ok(targets.data.people.some((u:any)=>u.id==='anna'));
 assert.ok(!targets.data.people.some((u:any)=>u.id==='olga'||u.id==='lead-msk'||u.id==='director'));
 assert.equal((await request('director',path+'/delegate',{assigneeId:'anna',expectedVersion:1})).status,403);
 assert.equal((await request('lead-msk',path+'/delegate',{assigneeId:'olga',expectedVersion:1})).status,403);
 assert.equal((await request('lead-msk',path+'/delegate',{assigneeId:'anna',expectedVersion:2})).status,409);
 const responses=await Promise.all([1,2].map(()=>request('lead-msk',path+'/delegate',{
  assigneeId:'anna',expectedVersion:1,instruction:'Приложите подтверждение'
 })));
 assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
 const copied=responses.find(r=>r.status===201)!.data.id;
 const copyPath='/tasks/'+copied,copy=(await request('anna',copyPath)).data.task;
 assert.equal(copy.delegated_from_id,id);assert.equal(copy.parent_id,id);assert.equal(copy.creator_id,'lead-msk');
 assert.equal(Number(copy.price),0);assert.match(copy.description,/Приложите подтверждение/);
 assert.deepEqual(copy.custom_fields,payload.customFields);
 const original=(await request('lead-msk',path)).data;
 assert.equal(original.task.assignee_id,'lead-msk');assert.equal(Number(original.task.price),50000);
 assert.equal(original.task.deadline,copy.deadline);assert.equal(original.task.version,1);
 assert.equal(original.events.filter((e:any)=>e.kind==='task_delegated').length,1);
 assert.equal((await request('lead-msk',path+'/delegation')).data.copies[0].id,copied);
 assert.equal((await request('anna',copyPath+'/delegation')).data.source,null);
 assert.equal((await request('anna',copyPath+'/review',{action:'submit',comment:'Выполнена проверка',expectedVersion:1})).status,200);
 assert.equal((await request('lead-msk',copyPath+'/review',{action:'accept',comment:'',expectedVersion:2})).status,200);
 assert.equal((await request('lead-msk',path)).data.task.status,'completed');

 const {botView,botClick}=await import('../server/bot.js');
 const actor=users.find(u=>u.id==='lead-msk')!,channel='test-delegation';
 const {lastUndo,undoLastAction}=await import('../server/undo.js');
 const acceptance=await lastUndo(actor,copied);assert(acceptance);await undoLastAction(actor,acceptance.id);
 const card=await botView(actor,channel,{op:'task',id});
 const actions=await botClick(actor,channel,botButton(card,'Ещё действия'));
 const list=await botClick(actor,channel,botButton(actions,'Делегировать задачу'));
 const preview=await botClick(actor,channel,botButton(list,users.find(u=>u.id==='ivan')!.name));
 const token=botButton(preview,'Создать поручение');
 const confirmation=await botClick(actor,channel,token);
 assert.deepEqual(await botClick(actor,channel,token),confirmation);
 assert.match(confirmation.text,/основная задача закроется автоматически/);
 assert.equal((await request('lead-msk',path+'/delegation')).data.copies.length,2);
});


test('org hierarchy and temporary substitution narrow delegation without exposing other queues',async()=>{
 assert.equal((await request('anna','/org')).status,403);
 assert.equal((await request('anna','/delegations')).status,403);
 assert.equal((await request('admin','/org/reporting/anna',{managerId:'lead-msk'},'PUT')).status,200);
 assert.equal((await request('admin','/org/reporting/lead-msk',{managerId:'head'},'PUT')).status,200);
 assert.equal((await request('admin','/org/reporting/head',{managerId:'lead-msk'},'PUT')).status,409);
 const created=await request('director','/tasks',{title:'Задача на время замещения',description:'Проверить заказ',price:0,assigneeId:'lead-msk',deadline:null,
  plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null});
 const path='/tasks/'+created.data.id;
 const targets=(await request('lead-msk',path+'/delegation-targets')).data.people;
 assert.deepEqual(targets.map((u:any)=>u.id),['anna']);
 assert.equal((await request('director',path+'/delegation-targets')).status,403);
 const dates={startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString()};
 const substitution=await request('admin','/org/substitutions',{managerId:'lead-msk',deputyId:'director',...dates});
 assert.equal(substitution.status,201);
 assert.equal((await request('admin','/org/substitutions',{managerId:'lead-msk',deputyId:'head',...dates})).status,409);
 assert.deepEqual((await request('director',path+'/delegation-targets')).data.people.map((u:any)=>u.id),['anna']);
 const child=await request('director',path+'/delegate',{assigneeId:'anna',expectedVersion:1});
 assert.equal(child.status,201);
 assert.equal((await request('director','/tasks/'+child.data.id)).data.task.creator_id,'lead-msk');
 const delegated=(await request('director','/delegations')).data.find((row:any)=>row.id===child.data.id);
 assert.equal(delegated.substitution,true);
 assert.equal((await request('admin','/org/substitutions/'+substitution.data.id,undefined,'DELETE')).status,200);
 assert.equal((await request('director',path+'/delegation-targets')).status,403);
 assert.ok(!(await request('director','/delegations')).data.some((row:any)=>row.id===child.data.id));
});

test('scheduled metric rules count both presets, notify the actual manager and re-arm only after recovery',async()=>{
 const {runProcesses}=await import('../server/work-design.js');
 const {metricPreset,premiumPreset,measureTasks}=await import('../shared/process-metrics.js');
 const marker='Тест показателя клиента';
 const now=new Date();
 const point={x:10,y:10},work='/work-design/processes';
 const manager='lead-msk',subject='anna';
 assert.equal((await request('admin','/org/reporting/'+subject,{managerId:manager},'PUT')).status,200);
 const create=async(price:number,days:number)=>{
  const result=await request('director','/tasks',{title:marker,description:'Проверка показателя',price,assigneeId:subject,
   deadline:new Date(now.getTime()+days*86400000).toISOString(),plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null});
  assert.equal(result.status,201);return result.data.id as string;
 };
 const overdue:string[]=[];
 for(let i=0;i<6;i++){overdue.push(await create(1000,-3));await create(500000,4);}
 await create(499999,4);await create(500000,8);
 const source=(await db.pool.query("SELECT * FROM tasks WHERE id=$1",[overdue[0]])).rows[0];
 assert.equal(measureTasks([{...source,deadline:new Date(now.getTime()-2*86400000).toISOString()}],metricPreset,now).value,0);
 const withMarker=(config:typeof metricPreset)=>({...config,filters:[...config.filters,{field:'title',operator:'=',value:marker}]});
 function definition(config:typeof metricPreset,action:{id:string;type:string;config:object},name:string){
  return {name,trigger:'monitor',monitor:{subjectId:subject,everyMinutes:5},
   title:'Базовый шаблон',assigneeId:manager,price:0,deadlineHours:24,field:'company.status',operator:'=',value:'active',branch:'yes',
   graph:{nodes:[{id:'start',type:'start',...point},{id:'metric',type:'metric',config:withMarker(config),...point},{...action,...point},{id:'end',type:'end',...point}],
    edges:[{from:'start',to:'metric',sourcePort:'next'},{from:'metric',to:action.id,sourcePort:'yes'},{from:'metric',to:'end',sourcePort:'no'},{from:action.id,to:'end',sourcePort:'next'}]}};
 }
 const overdueRule=definition(metricPreset,{id:'notify',type:'notify',config:{recipientId:'@manager',message:'Проверка просрочек: {{metric.value}}'}},'Правило просрочек');
 const premiumRule=definition(premiumPreset,{id:'task',type:'task',config:{assigneeId:'@manager',title:'Проверить премиум: {{metric.value}}',price:0,deadlineHours:24}},'Правило премиум');
 const preview=async(definition:unknown)=>request('director',work+'/preview',{definition,sample:{name:'',status:'active',previousStatus:null}});
 assert.deepEqual((await preview(overdueRule)).data.notices,['Проверка просрочек: 6']);
 assert.deepEqual((await preview(premiumRule)).data.titles,['Проверить премиум: 6']);
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM outbox WHERE body LIKE 'Проверка просрочек:%'")).rows[0].n,0);
 for(const rule of [overdueRule,premiumRule]){
  const saved=await request('director',work,rule);assert.equal(saved.status,201);
  assert.equal((await request('director',work+'/'+saved.data.id,{enabled:true},'PATCH')).status,200);
 }
 const messages=async()=>(await db.pool.query("SELECT recipient_id,body FROM outbox WHERE body LIKE 'Проверка просрочек:%'")).rows;
 const generated=async()=>(await db.pool.query("SELECT assignee_id,title FROM tasks WHERE title LIKE 'Проверить премиум:%'")).rows;
 await Promise.all([runProcesses(now),runProcesses(now)]);
 await runProcesses(new Date(now.getTime()+600000));
 assert.deepEqual(await messages(),[{recipient_id:manager,body:'Проверка просрочек: 6'}]);
 assert.deepEqual(await generated(),[{assignee_id:manager,title:'Проверить премиум: 6'}]);
 await db.pool.query("UPDATE tasks SET status='completed' WHERE id=$1",[overdue[0]]);
 await runProcesses(new Date(now.getTime()+1200000));
 assert.equal((await messages()).length,1);
 await db.pool.query("UPDATE tasks SET status='active' WHERE id=$1",[overdue[0]]);
 await runProcesses(new Date(now.getTime()+1800000));
 assert.equal((await messages()).length,2);
 assert.equal((await generated()).length,1);
});

test('workspace refresh keeps authorization and avoids sending unchanged task data',async()=>{
 const workspace=(actor:string,version?:string)=>fetch(base+'/api/bootstrap?view=workspace',{headers:{
  Cookie:cookies.get(actor)||'','Accept-Encoding':'gzip',...(version?{'X-Ruspet-Workspace-Version':version}:{})
 }});
 const first=await workspace('admin');
 assert.equal(first.status,200);
 assert.equal(first.headers.get('content-encoding'),'gzip');
 assert.match(first.headers.get('vary')||'',/Accept-Encoding/i);
 assert.equal(first.headers.get('cache-control'),'no-store');
 const version=first.headers.get('x-ruspet-workspace-version')!;
 assert.ok(version);
 const data=await first.json();
 assert.deepEqual(data.events,[]);
 assert.ok(data.tasks.every((task:object)=>!('source_fields' in task)));
 const same=await workspace('admin',version);
 assert.equal(same.status,204);
 assert.ok(Date.parse(same.headers.get('x-ruspet-server-time')!)>=Date.parse(data.serverTime));
 assert.equal((await same.text()).length,0);
 assert.equal((await workspace('unknown',version)).status,401);
 const employee=await workspace('anna',version);
 assert.equal(employee.status,200);
 assert.equal((await employee.json()).user.id,'anna');
 const created=await request('admin','/tasks',taskInput);
 assert.equal(created.status,201);
 const changed=await workspace('admin',version);
 assert.equal(changed.status,200);
 assert.notEqual(changed.headers.get('x-ruspet-workspace-version'),version);
 assert.ok((await changed.json()).tasks.some((task:{id:string})=>task.id===created.data.id));
});

test('repeating a task write after a lost response returns the saved result once',async()=>{
 const post=async(actor:string,path:string,key:string,body:unknown)=>{
  const response=await fetch(base+'/api'+path,{method:'POST',headers:{
   Cookie:cookies.get(actor)!,'Content-Type':'application/json','Idempotency-Key':key
  },body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 };
 const key=randomUUID();
 const [first,duplicate]=await Promise.all([post('admin','/tasks',key,taskInput),post('admin','/tasks',key,taskInput)]);
 assert.equal(first.status,201);
 assert.deepEqual(duplicate,first);
 assert.equal((await post('admin','/tasks',key,{...taskInput,title:'Другое название'})).status,409);
 const path=`/tasks/${first.data.id}/comments`,comment={body:'Комментарий при проверке восстановления'};
 const commentKey=randomUUID();
 const receipt=await post('admin',path,commentKey,comment);
 assert.equal(receipt.status,200);
 assert.deepEqual(await post('admin',path,commentKey,comment),receipt);
 assert.equal((await post('anna',path,commentKey,comment)).status,200);
 const detail=await request('admin',`/tasks/${first.data.id}`);
 assert.deepEqual(detail.data.comments.map((entry:{author_id:string})=>entry.author_id).sort(),['admin','anna']);
 const blocked=randomUUID();
 await db.pool.query(`ALTER TABLE task_write_receipts ADD CONSTRAINT test_unavailable_receipt CHECK (request_id <> '${blocked}'::uuid) NOT VALID`);
 try{
  assert.equal((await post('admin',path,blocked,{body:'При неудачной записи квитанции'})).status,500);
  assert.equal((await request('admin',`/tasks/${first.data.id}`)).data.comments.length,2);
 }finally{await db.pool.query('ALTER TABLE task_write_receipts DROP CONSTRAINT test_unavailable_receipt');}
 assert.equal((await post('admin',path,blocked,{body:'При неудачной записи квитанции'})).status,200);
 assert.equal((await request('admin',`/tasks/${first.data.id}`)).data.comments.length,3);
 const approval=await post('anna',`/tasks/${first.data.id}/approvals`,randomUUID(),{
  type:'deadline',reason:'Требуется дополнительная проверка',plan:'Подготовить и проверить итоговый результат',
  proposedDeadline:new Date(Date.now()+864000000).toISOString(),expectedVersion:1
 });
 assert.equal(approval.status,201);
 const next=(await db.pool.query('SELECT route FROM approvals WHERE id=$1',[approval.data.id])).rows[0].route[0].userId;
 const decisionKey=randomUUID(),decision={decision:'reject',comment:'Результат нужно перепроверить',expectedStep:0,expectedRevision:1};
 const decisionPath=`/approvals/${approval.data.id}/decision`;
 const decided=await post(next,decisionPath,decisionKey,decision);
 assert.equal(decided.status,200);
 assert.deepEqual(await post(next,decisionPath,decisionKey,decision),decided);
 assert.equal((await db.pool.query('SELECT id FROM decisions WHERE approval_id=$1',[approval.data.id])).rowCount,1);
});

test('sales assignment needs acceptance in web and bot, creates a private calendar entry and one reminder',async t=>{
 const initial=users.find(user=>user.id==='anna')!;
 await db.pool.query("UPDATE users SET position='Менеджер по продажам' WHERE id=$1",[initial.id]);
 t.after(()=>db.pool.query('UPDATE users SET position=$1 WHERE id=$2',[initial.position,initial.id]));
 const manager={...initial,position:'Менеджер по продажам'};
 const {businessDay}=await import('../shared/queues.js');
 const now=Date.now(),deadline=new Date(now+8*3600000).toISOString(),plannedAt=new Date(now+2*3600000).toISOString();
 const month=businessDay(plannedAt).slice(0,7);
 const template={title:'Проверка назначения с планированием',description:'Фикстура',price:1000,assigneeId:manager.id,
  deadline,plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null};
 const created=await request('admin','/tasks',template);assert.equal(created.status,201);
 const id=created.data.id,path='/tasks/'+id;
 const {task,personalPlan}= (await request(manager.id,path)).data;
 assert.equal(personalPlan.needsAcceptance,true);
 const creatorBefore=(await request('admin',path)).data;
 assert.equal(creatorBefore.personalPlan,null);assert.equal(creatorBefore.assignmentReceipt.state,'pending');
 assert.equal((await request(manager.id,path+'/review',{action:'submit',comment:'Проверяется готовый результат',expectedVersion:task.version})).status,409);
 assert((await request(manager.id,'/personal-calendar?month='+month)).data.awaiting.some((row:{id:string})=>row.id===id));

 const {generateWebTaskNotices}=await import('../server/task-notices.js');
 const assigned=(await db.pool.query('SELECT id,created_at FROM outbox WHERE task_id=$1 AND task_assignment',[id])).rows[0];
 await generateWebTaskNotices(new Date(Date.parse(assigned.created_at)+11*60000));
 const assignmentNotice=(await request(manager.id,'/notifications')).data.find((n:{task_notice?:{assignmentIds:string[]}})=>n.task_notice?.assignmentIds.includes(assigned.id));
 assert(assignmentNotice?.task_notice.hasAssignments);

 const body={epoch:personalPlan.epoch,revision:0,plannedAt,accept:true};
 assert.equal((await request('admin',path+'/personal-plan',body,'PUT')).status,403);
 const result=await request(manager.id,path+'/personal-plan',body,'PUT');
 assert.equal(result.status,200);
 assert.equal(result.data.plannedAt,plannedAt);assert(result.data.acceptedAt);
 assert.deepEqual((await request(manager.id,path+'/personal-plan',body,'PUT')).data,result.data);
 const after=(await request(manager.id,path)).data;
 assert.equal(after.task.deadline,deadline);assert.equal(after.task.version,task.version);
 assert.equal(after.events.filter((e:{kind:string})=>e.kind==='assignment_accepted').length,1);
 assert.equal((await request('admin',path)).data.assignmentReceipt.state,'accepted');
 const preview=await fetch(base+'/api'+path,{headers:{Cookie:cookies.get('admin')!,'X-Ruspet-View-As':manager.id}});
 assert.equal((await preview.json()).personalPlan,null);
 const own=(await request(manager.id,'/personal-calendar?month='+month)).data;
 assert.equal(own.canLogWork,false);assert.equal(own.scheduled.find((row:{id:string})=>row.id===id).plan.plannedAt,plannedAt);
 assert(!(await request('admin','/personal-calendar?month='+month)).data.scheduled.some((row:{id:string})=>row.id===id));

 const {generateWebPlanNotices}=await import('../server/personal-calendar.js');
 const {pendingAlerts}=await import('../server/reminders.js');
 const due=new Date(Date.parse(plannedAt)-30*60000+1000);
 await generateWebPlanNotices(due);await generateWebPlanNotices(due);
 assert.equal((await pendingAlerts(manager,due,null,false)).filter(a=>a.task_id===id&&a.personal_plan_epoch).length,1);
 assert.equal((await request(manager.id,'/notifications')).data.filter((n:{task_id:string;body:string})=>n.task_id===id&&n.body.includes('Ваш план')).length,1);
 const reminders=(await request('admin',path+'/reminders')).data;
 assert(!(reminders.alerts??[]).some((alert:{body:string})=>alert.body.includes('Ваш план')));

 const replannedAt=new Date(now+4*3600000).toISOString();
 assert.equal((await request(manager.id,path+'/personal-plan',{...body,revision:1,plannedAt:replannedAt,accept:false},'PUT')).status,200);
 assert(!(await pendingAlerts(manager,due,null,false)).some(a=>a.task_id===id&&a.personal_plan_epoch));
 assert(!(await request(manager.id,'/notifications')).data.some((n:{task_id:string;body:string})=>n.task_id===id&&n.body.includes('Ваш план')));

 const edited=await request('admin',path,{...template,assigneeId:'ivan',expectedVersion:task.version,reason:'Новое назначение'},'PUT');
 assert.equal(edited.status,200);
 assert(!(await request(manager.id,'/personal-calendar?month='+month)).data.scheduled.some((row:{id:string})=>row.id===id));
 assert.equal((await request('ivan',path)).data.personalPlan.plannedAt,null);
 assert(!(await pendingAlerts(manager,new Date(Date.parse(replannedAt)),null,false)).some(a=>a.task_id===id&&a.personal_plan_epoch));

 const today=businessDay(new Date()),monthToday=today.slice(0,7);
 assert.equal((await request(manager.id,'/personal-calendar/work/'+today,{minutes:120,note:'Не сохраняется',revision:0},'PUT')).status,403);
 const work=await request('ivan','/personal-calendar/work/'+today,{minutes:430,note:'Отчёт за день',revision:0},'PUT');
 assert.equal(work.status,200);
 assert.equal((await request('ivan','/personal-calendar?month='+monthToday)).data.work.find((row:{date:string})=>row.date===today).minutes,430);
 assert(!(await request('admin','/personal-calendar?month='+monthToday)).data.work.some((row:{note:string})=>row.note==='Отчёт за день'));

 const second=await request('admin','/tasks',{...template,title:'Проверка приёма через Telegram'});
 const {botView,botClick,botText}=await import('../server/bot.js'),channel='personal-plan-fixture';
 const card=await botView(manager,channel,{op:'task',id:second.data.id});
 const start=card.buttons.flat().find(b=>b.text==='Принять задачу');assert(start);
 await botClick(manager,channel,start.token);
 const confirm=await botText(manager,channel,'завтра в 15:00','plan-fixture-input');
 const button=confirm.buttons.flat().find(b=>b.text==='Подтвердить и отправить');assert(button,confirm.text);
 const accepted=await botClick(manager,channel,button.token);
 assert.match(accepted.text,/Задача принята/);
 assert((await request(manager.id,'/tasks/'+second.data.id)).data.personalPlan.plannedAt);
});
