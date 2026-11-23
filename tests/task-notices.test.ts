import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import pg from 'pg';
import webpush from 'web-push';
import type {Report,User} from '../shared/types.js';

const name='ruspet_task_notices_'+randomBytes(5).toString('hex'),chat='123456789';
let admin:pg.Client,db:typeof import('../server/db.js'),workflow:typeof import('../server/workflow.js');
let notices:typeof import('../server/task-notices.js'),push:typeof import('../server/web-push.js');
let director:User,worker:User,other:User,server:Server,origin:string,folder:string,keys:ReturnType<typeof webpush.generateVAPIDKeys>;
const cookies=new Map<string,string>();
const at=(day:string,time:string)=>new Date(day+'T'+time+':00+03:00');

async function api(user:User,path:string,method='GET',body?:unknown){
 const res=await fetch(origin+'/api'+path,{method,headers:{Cookie:cookies.get(user.id)||'','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,body:await res.json() as any};
}
async function login(user:User){
 const res=await fetch(origin+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user.id})});
 assert.equal(res.status,200);cookies.set(user.id,res.headers.get('set-cookie')!.split(';')[0]);
}
async function makeTask(title:string,deadline:Date|null,assignee=worker){
 return (await workflow.createTask(director,{title,description:'Фикстура уведомлений',assigneeId:assignee.id,price:1200,deadline:deadline?.toISOString()??null,
  plannedStart:null,plannedEnd:null,important:false,customerRisk:false,parentId:null})).id;
}
async function assignmentTime(id:string,date:Date){
 await db.pool.query('UPDATE outbox SET created_at=$2 WHERE task_id=$1 AND task_assignment',[id,date.toISOString()]);
}
async function setStatus(id:string,status:'active'|'review'|'completed'){
 await db.pool.query('UPDATE tasks SET status=$2 WHERE id=$1',[id,status]);
}

before(async()=>{
 const original=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 admin=new pg.Client({connectionString:original});await admin.connect();await admin.query('CREATE DATABASE '+name);
 const url=new URL(original);url.pathname='/'+name;process.env.DATABASE_URL=url.toString();process.env.DEMO_AUTH='true';
 folder=await mkdtemp(join(tmpdir(),'ruspet-notices-'));keys=webpush.generateVAPIDKeys();
 process.env.WEB_PUSH_KEYS_FILE=join(folder,'vapid.json');process.env.PUBLIC_ORIGIN='https://fixture.example';
 await writeFile(process.env.WEB_PUSH_KEYS_FILE,JSON.stringify(keys),{mode:0o600});
 db=await import('../server/db.js');await (await import('../scripts/migrate.js')).migrate();
 const seed=await import('../scripts/seed.js');await seed.seed();
 director=seed.demoUsers.find(u=>u.id==='director')!;
 const account=(id:string,name:string):User=>({id,name,role:'employee',branch_id:'Тест',position:'Менеджер'});
 worker=account('fixture-worker','Сотрудник фикстуры');other=account('fixture-other','Другой сотрудник');
 for(const user of [worker,other])await db.pool.query('INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,$4,$5)',[user.id,user.name,user.role,user.branch_id,user.position]);
 await db.pool.query("UPDATE telegram_settings SET enabled=true,task_delivery=true,deadline_delivery=true,task_delivery_enabled_at='2035-01-01T00:00:00+03:00'");
 await db.pool.query("INSERT INTO telegram_binding(id,chat_id,user_id,paired_at) VALUES(1,$1,$2,'2035-01-01T00:00:00+03:00')",[chat,worker.id]);
 workflow=await import('../server/workflow.js');notices=await import('../server/task-notices.js');push=await import('../server/web-push.js');
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const user of [worker,other])await login(user);
});
after(async()=>{
 if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 await db?.pool.end();
 if(admin){await admin.query('DROP DATABASE IF EXISTS '+name);await admin.end();}
 if(folder){await unlink(join(folder,'vapid.json'));await rmdir(folder);}
});

test('deadlines use personal tasks, quiet hours and separate status groups in both channels',async()=>{
 const day='2035-01-02',yesterday='2035-01-01';
 const late=await makeTask('Просрочка из прошлого дня',at(yesterday,'17:00'));
 const early=await makeTask('Срок наступит утром',at(day,'10:10'));
 const later=await makeTask('Срок наступит вечером',at(day,'18:00'));
 const foreign=await makeTask('Чужая просрочка',at(yesterday,'16:00'),other);
 const self=await makeTask('Моя задача самому себе',at(yesterday,'15:00'));
 await db.pool.query('UPDATE tasks SET creator_id=assignee_id WHERE id=$1',[self]);
 const excluded=await makeTask('Дневной чек-лист',at(yesterday,'16:00'));
 const tick=(time:string)=>notices.claimTelegramTaskNotice(worker,chat,at(day,time));
 assert.equal(await tick('08:59'),null);
 const first=await tick('09:00');assert(first);
 assert.deepEqual(first.overdue.map(t=>t.id),[late]);
 assert.deepEqual(first.today.map(t=>t.id),[early,later]);
 assert(!first.overdue.some(t=>t.id===foreign||t.id===excluded||t.id===self));
 assert.equal(await tick('09:29'),null);
 const combined=await tick('09:30');assert(combined);
 assert.deepEqual(combined.overdue.map(t=>t.id),[late]);
 assert(combined.today.some(t=>t.id===early));
 assert.equal(await tick('09:45'),null);
 await setStatus(late,'review');
 const elapsed=await tick('10:10');assert(elapsed);
 assert.deepEqual(elapsed.elapsedToday.map(t=>t.id),[early]);
 assert.equal(elapsed.overdue.length,0);
 await setStatus(early,'completed');
 assert.equal(await tick('10:40'),null);
 assert.deepEqual((await tick('14:00'))?.today.map(t=>t.id),[later]);
 assert.equal(await tick('19:00'),null);
 await notices.generateWebTaskNotices(at(day,'14:00'));
 const feed=await api(worker,'/notifications');
 assert.equal(feed.status,200);
 const summary=feed.body.find((notice:any)=>notice.task_notice);
 assert.match(summary.body,/Крайний срок сегодня/);
 assert(!summary.body.includes('Чужая просрочка')&&!summary.body.includes('Дневной чек-лист')&&!summary.body.includes('Моя задача самому себе'));
 await setStatus(later,'completed');await setStatus(foreign,'completed');await setStatus(excluded,'completed');await setStatus(self,'completed');
});

test('turning off work control stops automatic checks while new assignments and personal reminders still arrive',async()=>{
 const day='2035-01-02',now=at(day,'14:10');
 const admin=(await db.pool.query<User>("SELECT * FROM users WHERE id='admin'")).rows[0];
 const {setStaffRollout,setStaffWorkOverride}=await import('../server/staff-rollout.js');
 const {pendingAlerts,tickTaskReminders}=await import('../server/reminders.js');
 const {runChecks}=await import('../server/service.js');
 const id=await makeTask('Назначение сотруднику вне контроля',at(day,'13:00'));
 await assignmentTime(id,at(day,'13:50'));
 const personal=randomUUID();
 const original=(await db.pool.query('SELECT delivery FROM telegram_settings WHERE id=1')).rows[0].delivery;
 try{
  await setStaffRollout({...admin,root_access:true},true);
  await setStaffWorkOverride(admin,worker.id,false);
  await db.pool.query("UPDATE telegram_settings SET delivery=true WHERE id=1");
  await db.pool.query(`INSERT INTO task_alerts(id,dedupe_key,recipient_id,task_id,kind,body,due_at,expires_at)
   VALUES($1,$2,$3,$4,'task','Личное напоминание',$5,$6)`,[personal,'task-once:'+personal,worker.id,id,now.toISOString(),at(day,'21:00').toISOString()]);
  await tickTaskReminders(now);
  assert.deepEqual((await pendingAlerts(worker,now)).map(alert=>alert.id),[personal]);
  const batch=await notices.claimTelegramTaskNotice(worker,chat,now);
  assert.deepEqual(batch?.assignments.map(task=>task.id),[id]);
  assert.equal(batch?.prepare,undefined);
  assert.deepEqual(batch?.elapsedToday,[]);
  await runChecks(admin,now);
  assert.equal((await db.pool.query("SELECT 1 FROM control_requests WHERE task_id=$1 AND state='waiting'",[id])).rowCount,0);
 }finally{
  await setStaffWorkOverride(admin,worker.id,null);
  await setStaffRollout({...admin,root_access:true},false);
  await db.pool.query('UPDATE telegram_settings SET delivery=$1 WHERE id=1',[original]);
  await setStatus(id,'completed');
 }
});

test('new assignments wait ten minutes and a concurrent tick only claims one personal batch',async()=>{
 const day='2035-01-03',tick=(time:string)=>notices.claimTelegramTaskNotice(worker,chat,at(day,time));
 const first=await makeTask('Назначение первое',null),second=await makeTask('Назначение второе',null),next=await makeTask('Назначение следующей пачки',null);
 await assignmentTime(first,at(day,'20:00'));await assignmentTime(second,at(day,'20:07'));await assignmentTime(next,at(day,'20:11'));
 await notices.generateWebTaskNotices(at(day,'20:09'));
 const hidden=(await api(worker,'/notifications')).body;assert(!hidden.some((notice:any)=>notice.body.includes('Назначение первое')));
 assert.equal(await tick('20:09'),null);
 const batches=(await Promise.all([tick('20:10'),tick('20:10')])).filter(Boolean);
 assert.equal(batches.length,1);assert.deepEqual(batches[0]?.assignments.map(t=>t.id),[first,second]);
 assert.equal(await tick('20:20'),null);
 assert.deepEqual((await tick('20:21'))?.assignments.map(t=>t.id),[next]);
 await Promise.all([notices.generateWebTaskNotices(at(day,'20:10')),notices.generateWebTaskNotices(at(day,'20:10'))]);
 const result=(await api(worker,'/notifications')).body.filter((row:any)=>row.body.includes('Назначение первое'));
 assert.equal(result.length,1);assert.match(result[0].body,/Новые задачи · 2/);assert.match(result[0].body,/Назначение второе/);
 assert(!result[0].body.includes('следующей пачки'));
 await setStatus(first,'completed');await setStatus(second,'completed');await setStatus(next,'completed');
});

test('checkpoints combine deadlines and leave pending transfers with their current decision maker',async()=>{
 const day='2035-01-04',tick=(time:string)=>notices.claimTelegramTaskNotice(worker,chat,at(day,time));
 const due=await makeTask('Сдать готовый результат к 15:00',at(day,'18:00'));
 const pending=await makeTask('Перенос у согласующего',at('2035-01-03','12:00'));
 await assignmentTime(due,at(day,'12:00'));
 await db.pool.query('UPDATE telegram_settings SET task_delivery=false WHERE id=1');
 const approval=randomUUID();
 await db.pool.query(`INSERT INTO approvals(id,task_id,requester_id,type,reason,plan,proposed_deadline,task_version,state,route,route_version)
  SELECT $1,id,$2,'deadline','Причина запроса','План работ',$3,version,'pending',$4,1 FROM tasks WHERE id=$5`,
  [approval,worker.id,at(day,'18:00').toISOString(),JSON.stringify([{userId:director.id,label:'Руководитель'}]),pending]);
 const prepare=await tick('13:00');
 assert.equal(prepare?.prepare,'prepare');assert.deepEqual(prepare?.today.map(t=>t.id),[due]);
 assert.deepEqual(prepare?.assignments,[]);
 assert.equal(prepare?.overdue.length,0);assert.ok(prepare?.waiting);
 assert.equal(await tick('13:01'),null);
 const lastCall=await tick('14:30');assert.equal(lastCall?.prepare,'last_call');
 assert.equal(await tick('14:31'),null);
 await setStatus(due,'completed');
 assert.equal(await tick('15:00'),null);
 await db.pool.query('UPDATE approvals SET clarification_requested_at=$2 WHERE id=$1',[approval,at(day,'15:00').toISOString()]);
 assert.equal(await tick('15:01'),null);
 const control=randomUUID(),pressing=randomUUID(),summary=randomUUID();
 await db.pool.query("INSERT INTO control_requests(id,task_id,assignee_id,state,due_at) VALUES($1,$2,$3,'waiting',$4)",
  [control,pending,worker.id,at(day,'14:00').toISOString()]);
 await db.pool.query("INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key,created_at) VALUES($1,$2,$3,'Запрос объяснений',$4,$5)",
  [pressing,pending,worker.id,'control:'+control,at(day,'14:10').toISOString()]);
 await db.pool.query("INSERT INTO outbox(id,recipient_id,body,dedupe_key,task_notice) VALUES($1::uuid,$2,'Старая сводка',($1::uuid)::text,$3)",
  [summary,worker.id,JSON.stringify({hasDeadlines:true,deadlineTaskIds:[pending],taskIds:[pending]})]);
 const {pendingOutbox}=await import('../server/telegram-pilot.js');
 const eligible=await pendingOutbox(worker,at(day,'09:00').toISOString(),at(day,'09:00').toISOString(),null,at(day,'15:01'));
 assert(!eligible.some(row=>row.id===pressing));
 const overview=(await api(worker,'/bootstrap')).body;
 assert(!overview.controls.some((row:{id:string})=>row.id===control));
 assert(!overview.notifications.some((row:{id:string})=>row.id===summary));
 const {remind}=await import('../server/service.js');
 await remind(director,at(day,'15:01'));
 assert.equal((await db.pool.query('SELECT reminders FROM control_requests WHERE id=$1',[control])).rows[0].reminders,0);
 await db.pool.query("UPDATE approvals SET state='rejected' WHERE id=$1",[approval]);
 assert.deepEqual((await tick('15:02'))?.overdue.map(t=>t.id),[pending]);
 await db.pool.query("UPDATE control_requests SET state='resolved' WHERE id=$1",[control]);
 await db.pool.query('UPDATE outbox SET withdrawn_at=now() WHERE id=ANY($1::uuid[])',[[pressing,summary]]);
 await setStatus(pending,'completed');
 await db.pool.query('UPDATE telegram_settings SET task_delivery=true WHERE id=1');
});

test('web push is opt-in per device, rejects internal URLs and sends one private summary',async()=>{
 const status=await api(worker,'/notifications/push');assert.deepEqual(status.body,{publicKey:keys.publicKey,active:false});
 const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:keys.publicKey,auth:randomBytes(16).toString('base64url')}};
 assert.equal((await api(worker,'/notifications/push','POST',{...subscription,endpoint:'https://127.0.0.1/internal'})).status,400);
 assert.equal((await api(worker,'/notifications/push','POST',subscription)).status,200);
 await api(other,'/notifications/push','DELETE',{endpoint:subscription.endpoint});
 assert.equal((await api(worker,'/notifications/push')).body.active,true);
 const day='2035-01-04',id=await makeTask('Содержимое задачи остаётся внутри приложения',null);
 await assignmentTime(id,at(day,'20:00'));const time=at(day,'20:10');
 await notices.generateWebTaskNotices(time);
 const messages:string[]=[],send=webpush.sendNotification;
 try{
  webpush.sendNotification=async(_sub,payload)=>{messages.push(String(payload));return {statusCode:201,body:'',headers:{}};};
  assert.equal((await api(other,'/notifications/push/test','POST',{endpoint:subscription.endpoint})).status,409);
  assert.equal((await api(worker,'/notifications/push/test','POST',{endpoint:subscription.endpoint})).body.sent,true);
  assert.match(messages.shift()!,/ruspet-push-test/);
  await Promise.all([push.deliverWebPush(time),push.deliverWebPush(time)]);
  assert.equal(messages.length,1);
  assert.match(messages[0],/Вам поставили новые задачи/);assert(!messages[0].includes('Содержимое задачи'));
 }finally{webpush.sendNotification=send;}
 await api(worker,'/auth/logout','POST',{});
 assert.equal((await db.pool.query('SELECT 1 FROM web_push_subscriptions WHERE user_id=$1',[worker.id])).rowCount,0);
});

test('branch inactivity is captured once and reaches the next working day report',async()=>{
 const management=await import('../server/management-notices.js');
 await db.pool.query("INSERT INTO users(id,name,role,branch_id,position,company_branch_access) VALUES('branch-fixture','Руководитель фикстуры','branch_manager','Тест','Рукфил',true)");
 await db.pool.query("INSERT INTO approval_hierarchy(id,branch_manager_id,sales_head_id) VALUES(1,'branch-fixture',$1)",[director.id]);
 const day='2035-01-05',now=at(day,'17:30');
 const idle=await makeTask('Задача без действия',at('2035-01-04','11:30'),worker);
 const worked=await makeTask('Задача с ответом',at('2035-01-04','11:30'),other);
 await db.pool.query("INSERT INTO task_events(id,task_id,actor_id,kind,message,created_at) VALUES($1,$2,$3,'comment','Есть ответ',$4)",
  [randomUUID(),worked,other.id,at(day,'14:00').toISOString()]);
 await management.reviewInactivity(day,now);
 await management.reviewInactivity(day,now);
 const rows=(await db.pool.query("SELECT body FROM outbox WHERE recipient_id='branch-fixture' AND management_notice->>'kind'='inactivity'")).rows;
 assert.equal(rows.length,1);assert(rows[0].body.includes(worker.name));assert(!rows[0].body.includes(other.name));assert(rows[0].body.includes('#'+idle));
 await management.morningManagementReport('2035-01-08','fixture-report');
 const morning=(await db.pool.query("SELECT body,management_notice FROM outbox WHERE recipient_id=$1 AND management_notice->>'kind'='morning-report'",[director.id])).rows[0];
 assert(morning.body.includes(worker.name));assert.equal(morning.management_notice.reportId,'fixture-report');
});

test('director is notified through the normal approval queue without a manual batch',async()=>{
 const service=await import('../server/service.js');
 const adminUser=(await db.pool.query<User>("SELECT * FROM users WHERE id='admin'")).rows[0];
 const branch=(await db.pool.query<User>("SELECT * FROM users WHERE id='branch-fixture'")).rows[0];
 await db.pool.query("INSERT INTO org_reporting(employee_id,manager_id) VALUES($1,$2),($2,$3)",[worker.id,branch.id,director.id]);
 const id=await makeTask('РВМ* Работа для проверки руководителями',null);
 const a=await service.requestApproval(worker,id,{type:'deadline',reason:'Уточнение нового срока задачи',
  proposedDeadline:at('2035-01-10','16:00').toISOString(),expectedVersion:1});
 await service.decide(branch,a.id,{decision:'approve',comment:''});
 const result=await makeTask('Отдельная приёмка у постановщика',null);
 assert.equal((await workflow.reviewTask(worker,result,'submit','Подготовили результат',1)).state,'review');
 const {rows:[completion]}=await db.pool.query("SELECT route FROM approvals WHERE task_id=$1 AND type='completion'",[result]);
 assert.deepEqual(completion.route,[{userId:director.id,label:'Постановщик'}]);
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM outbox WHERE recipient_id=$1 AND dedupe_key LIKE $2",[director.id,'approval:'+a.id+':%'])).rows[0].n,1);
 await login(adminUser);
 assert.equal((await api(adminUser,'/director-approval-batches','POST',{})).status,404);
 const bot=await import('../server/bot.js');
 const home=await bot.botView(director,'team-test');
 assert(home.buttons.flat().some(button=>button.text==='Мои задачи'));
 const team=await bot.botClick(director,'team-test',home.buttons.flat().find(button=>button.text==='Задачи команды')!.token);
 assert(!team.text.includes('Работа для проверки руководителями'));
 assert(!team.buttons.flat().some(button=>button.text===other.name));
 const personal=await bot.botClick(director,'team-test',team.buttons.flat().find(button=>button.text===worker.name)!.token);
 assert(personal.text.includes(worker.name));assert(!personal.text.includes(other.name));
});

test('personal, team and company reports are independent and use the reporting hierarchy',async()=>{
 const service=await import('../server/service.js');
 const branch=(await db.pool.query<User>("SELECT * FROM users WHERE id='branch-fixture'")).rows[0];
 const deadline=at('2035-01-09','11:30'),now=at('2035-01-09','15:00');
 const mine=await makeTask('Личная задача руководителя',deadline,branch);
 const team=await makeTask('Подчинённый в отчёте',deadline,worker);
 const outside=await makeTask('Другой сотрудник компании',deadline,other);
 const requests={queue:'today' as const};
 const personal=await service.makeReport(branch,'snapshot','scope-personal',now,requests);
 const group=await service.makeReport(branch,'snapshot','scope-team',now,{...requests,view:'team'});
 const company=await service.makeReport(director,'snapshot','scope-company',now,requests);
 assert.deepEqual(personal.rows.map(task=>task.id),[mine]);
 assert.deepEqual(group.rows.map(task=>task.id),[team]);
 assert.deepEqual(new Set(company.rows.map(task=>task.id)),new Set([mine,team,outside]));
 assert.equal((await service.getReport(branch,group.id)).id,group.id);
 await assert.rejects(()=>service.getReport(director,personal.id),/недоступен/);
 await assert.rejects(()=>service.makeReport(branch,'snapshot','scope-forbidden',now,{view:'company'}),/недоступен/);
 assert.deepEqual((await service.listReports(branch,{view:'mine',page:0})).items.map(report=>report.id),[personal.id]);
 assert.deepEqual((await service.listReports(branch,{view:'team',page:0})).items.map(report=>report.id),[group.id]);
 const bot=await import('../server/bot.js');
 const entry=await bot.botView(branch,'team-reports');
 const archive=await bot.botClick(branch,'team-reports',entry.buttons.flat().find(button=>button.text==='Мои отчёты')!.token);
 assert.match(archive.text,/Отчёты · Мои задачи/);
});

test('Friday evening sends one private digest with the Monday plan and creator report',async()=>{
 const service=await import('../server/service.js'),automation=await import('../server/automation.js'),telegram=await import('../server/telegram-pilot.js');
 const day='2035-01-12',now=at(day,'19:02'),monday='2035-01-15';
 const work=await makeTask('Задача к понедельнику',at(monday,'12:00'));
 const tooLate=await makeTask('Задача на вторник',at('2035-01-16','11:00'));
 const self=await makeTask('Личная задача на понедельник',at(monday,'09:00'));
 await db.pool.query('UPDATE tasks SET creator_id=assignee_id WHERE id=$1',[self]);
 const withoutDate=await makeTask('Задача без срока в плане',null);
 const placed=await makeTask('Моя поставленная просрочка',at(day,'12:00'),other);
 await db.pool.query('UPDATE tasks SET creator_id=$2 WHERE id=$1',[placed,worker.id]);
 await db.pool.query('UPDATE approval_hierarchy SET direct_assignee_ids=ARRAY[$1,$2]::text[] WHERE id=1',[worker.id,other.id]);
 await db.pool.query("UPDATE automation_config SET enabled=true,morning='09:00',evening='19:01' WHERE id=1");
 await db.pool.query('UPDATE telegram_settings SET enabled=true,delivery=false,task_delivery=false,deadline_delivery=false,workday_delivery=true WHERE id=1');
 assert.equal((await db.pool.query("SELECT 1 FROM outbox WHERE dedupe_key=$1",['workday:'+day+':'+worker.id])).rows.length,0);
 await automation.tick(now);await automation.tick(now);
 const rows=(await db.pool.query("SELECT body,management_notice FROM outbox WHERE dedupe_key=$1",['workday:'+day+':'+worker.id])).rows;
 assert.equal(rows.length,1);
 const {planReportId,creatorReportId}=rows[0].management_notice;
 const plan:Report=await service.getReport(worker,planReportId),creator:Report=await service.getReport(worker,creatorReportId);
 assert.equal(plan.summary?.tomorrow.day,monday);
 assert(plan.summary?.tomorrow.ids.includes(work));
 assert(!plan.summary?.tomorrow.ids.some(id=>[tooLate,withoutDate,placed,self].includes(id)));
 assert.deepEqual(creator.summary?.creatorProgress?.idleOverdueIds,[placed]);
 assert.deepEqual(creator.rows.map(t=>t.id),[placed]);
 await login(worker);await login(other);
 const archive=await api(worker,'/reports?view=created');
 assert.equal(archive.status,200,JSON.stringify(archive.body));
 assert.equal(archive.body.items[0].id,creatorReportId);
 assert.equal((await api(other,'/reports/'+creatorReportId)).status,404);
 assert.equal((await api(worker,'/reports','POST',{kind:'daily',parameters:{view:'created',creatorId:director.id}})).status,403);
 assert(rows[0].body.includes('понедельник'));
 const previous=process.env.TELEGRAM_BOT_TOKEN,fetch=globalThis.fetch,sent:any[]=[];
 process.env.TELEGRAM_BOT_TOKEN='fixture-workday';
 globalThis.fetch=(async(_url,options)=>{
  sent.push(JSON.parse(String(options?.body)));
  return new Response(JSON.stringify({ok:true,result:{message_id:901}}));
 }) as typeof globalThis.fetch;
 try{
  await Promise.all([telegram.deliver(now),telegram.deliver(now)]);
  assert.equal(sent.length,1);assert.equal(sent[0].chat_id,chat);
  const buttons=sent[0].reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length,2);
  const bot=await import('../server/bot.js');
  const view=await bot.botClick(worker,'telegram:'+chat,buttons[0].callback_data);
  const tasks=await bot.botClick(worker,'telegram:'+chat,view.buttons.flat().find(b=>b.text==='Задачи из плана')!.token);
  assert.match(tasks.text,/Задачи из плана/);
 }finally{
  globalThis.fetch=fetch;
  if(previous===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=previous;
 }
});

test('pricing controls deadline approvals and only the creator accepts completion',async()=>{
 const hierarchy=await import('../server/approval-hierarchy.js'),service=await import('../server/service.js');
 const adminUser=(await db.pool.query<User>("SELECT * FROM users WHERE id='admin'")).rows[0];
 const liza=(await db.pool.query<User>("SELECT * FROM users WHERE id='anna'")).rows[0];
 await db.pool.query(`INSERT INTO users(id,name,role,branch_id,position,company_branch_access)
  VALUES('branch-fixture','Руководитель фикстуры','branch_manager','Тест','Рукфил',true) ON CONFLICT(id) DO NOTHING`);
 const old=at('2035-01-22','12:00').toISOString(),next=at('2035-01-23','12:00').toISOString();
 const create=async(creator:User,assignee:User,price:number)=>{
  const input={title:'Задача проверки маршрута',description:'Фикстура маршрута согласования',assigneeId:assignee.id,price,deadline:old,
   plannedStart:null,plannedEnd:null,important:false,customerRisk:false,parentId:null};
  const task=await workflow.createTask(creator.id===assignee.id?creator:director,input);
  if(creator.id!==assignee.id)await db.pool.query('UPDATE tasks SET creator_id=$2 WHERE id=$1',[task.id,creator.id]);
  return task.id;
 };
 const request=(id:string,actor:User)=>service.requestApproval(actor,id,{type:'deadline',reason:'Причина переноса проверена',
  proposedDeadline:next,expectedVersion:1});
 const deadline=async(id:string)=>(await db.pool.query('SELECT deadline FROM tasks WHERE id=$1',[id])).rows[0].deadline;
 const approval=async(taskId:string)=>(await db.pool.query("SELECT * FROM approvals WHERE task_id=$1 AND state='pending'",[taskId])).rows[0];
 const route=async(id:string)=>(await approval(id))?.route.map((step:{userId:string})=>step.userId);
 const allow=async(taskId:string,actor:User)=>{
  const current=await approval(taskId);
  return service.decide(actor,current.id,{decision:'approve',comment:'Согласовано',expectedStep:current.current_step,expectedRevision:current.action_revision});
 };
 await hierarchy.setApprovalHierarchy(adminUser,'branch-fixture',director.id,false,[worker.id]);
 const previous=await create(liza,worker,85);
 await request(previous,worker);
 assert.deepEqual(await route(previous),[director.id]);
 await hierarchy.setApprovalHierarchy(adminUser,'branch-fixture',director.id,false,[worker.id],{
  creatorApproverId:liza.id,extraDeadlineAssigneeIds:[worker.id],onlySelfDirect:true,
 });
 assert.deepEqual(await route(previous),[liza.id,director.id]);
 assert.equal((await approval(previous)).action_revision,2);
 assert.equal(await deadline(previous),old);

 const self=await create(worker,worker,200);
 assert.equal((await request(self,worker)).applied,true);
 assert.equal(await deadline(self),next);
 assert.equal(await approval(self),undefined);
 await assert.rejects(()=>workflow.reviewTask(worker,self,'complete','',2),/Укажите результат/);
 assert.equal((await workflow.reviewTask(worker,self,'complete','Сверено и готово',2)).state,'completed');

 const ordinary=await create(adminUser,other,85);
 await request(ordinary,other);
 assert.deepEqual(await route(ordinary),[director.id]);
 assert.equal(await deadline(ordinary),old);

 const low=await create(liza,other,4999.99),boundary=await create(liza,other,5000),maksim=await create(liza,worker,85);
 await db.pool.query("INSERT INTO bitrix_task_snapshots(external_id,snapshot) VALUES(890009,'{}')");
 await db.pool.query("INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,890009,'{}',1)",[maksim]);
 await db.pool.query('UPDATE bitrix_live_config SET sync_linked_tasks=true WHERE id=1');
 const writeCount=async()=>Number((await db.pool.query("SELECT count(*) FROM bitrix_operations WHERE task_id=$1 AND payload->>'kind'='deadline_changed'",[maksim])).rows[0].count);
 for(const [id,actor,expected] of [[low,other,[liza.id]],[boundary,other,[liza.id,director.id]],[maksim,worker,[liza.id,director.id]]] as const){
  await request(id,actor);
  assert.deepEqual(await route(id),expected);
  assert.equal(await deadline(id),old);
 }
 assert.equal(await writeCount(),0);
 await assert.rejects(()=>allow(maksim,director),/другой согласующий/);
 const original=await approval(maksim),earlier=at('2035-01-22','17:00').toISOString();
 await login(liza);await login(director);
 const decidePath='/approvals/'+original.id+'/decision';
 const first={expectedStep:0,expectedRevision:original.action_revision};
 assert.equal(original.plan,'');
 assert.equal((await api(liza,decidePath,'POST',{...first,decision:'reject'})).status,400);
 assert.equal((await api(liza,decidePath,'POST',{...first,decision:'clarify'})).status,400);
 assert.equal((await api(liza,decidePath,'POST',{...first,decision:'approve',approvedDeadline:earlier})).body.state,'pending');
 assert.equal((await approval(maksim)).approved_deadline,earlier);
 assert.equal(await deadline(maksim),old);assert.equal(await writeCount(),0);
 const final={expectedStep:1,expectedRevision:original.action_revision};
 assert.equal((await api(director,decidePath,'POST',{...final,decision:'approve',approvedDeadline:'2000-01-01T12:00:00+03:00'})).status,400);
 assert.equal((await api(director,decidePath,'POST',{...final,decision:'approve'})).body.state,'approved');
 assert.equal(await deadline(maksim),earlier);assert.equal(await writeCount(),1);
 const history=(await api(director,'/tasks/'+maksim)).body;
 assert.equal(history.approvals[0].proposed_deadline,next);assert.equal(history.approvals[0].approved_deadline,earlier);
 assert.equal(history.deadlineHistory[0].from,old);assert.equal(history.deadlineHistory[0].to,earlier);
 const notice=(await db.pool.query('SELECT body FROM outbox WHERE dedupe_key=$1',['approved:'+original.id])).rows[0]?.body;
 assert.match(notice,/22\.01\.2035, 17:00 МСК.*23\.01\.2035, 12:00 МСК/);
 const bot=await import('../server/bot.js');
 const lowCard=await bot.botView(liza,'deadline-creator-fixture',{op:'task_approval',id:low});
 const upperCard=await bot.botView(liza,'deadline-creator-fixture',{op:'task_approval',id:boundary});
 assert(lowCard.buttons.flat().some(button=>button.text==='Выбрать другой срок'));
 assert(!upperCard.buttons.flat().some(button=>button.text==='Выбрать другой срок'));
 const lowRequest=await approval(low),boundaryRequest=await approval(boundary);
 const lizaDecision=(request:typeof lowRequest)=>api(liza,'/approvals/'+request.id+'/decision','POST',{
  decision:'approve',expectedStep:0,expectedRevision:request.action_revision,approvedDeadline:earlier
 });
 assert.equal((await lizaDecision(boundaryRequest)).status,403);
 assert.equal((await lizaDecision(lowRequest)).body.state,'approved');
 assert.equal(await deadline(low),earlier);
 const lowHistory=(await api(liza,'/tasks/'+low)).body;
 assert.equal(lowHistory.approvals[0].proposed_deadline,next);
 assert.equal(lowHistory.approvals[0].approved_deadline,earlier);
 assert.equal(lowHistory.deadlineHistory[0].to,earlier);
 const lowNotice=(await db.pool.query('SELECT body FROM outbox WHERE dedupe_key=$1',['approved:'+lowRequest.id])).rows[0]?.body;
 assert.match(lowNotice,/22\.01\.2035, 17:00 МСК.*23\.01\.2035, 12:00 МСК/);

 const work=await create(liza,other,5000);
 await assert.rejects(()=>workflow.reviewTask(liza,work,'complete','',1),/приёмке/);
 assert.equal((await workflow.reviewTask(other,work,'submit','Результат подготовлен',1)).state,'review');
 assert.deepEqual(await route(work),[liza.id]);
 await assert.rejects(()=>allow(work,director),/постановщик/);
 const beforeEdit=await approval(work);
 await login(liza);await login(other);
 assert.equal((await api(other,'/tasks/'+work+'/price','PATCH',{price:7800,expectedVersion:2})).status,403);
 assert.equal((await api(liza,'/tasks/'+work+'/price','PATCH',{price:7800,expectedVersion:2})).status,200);
 const changed=await approval(work);
 assert.equal(changed.id,beforeEdit.id);
 assert.equal(changed.task_version,3);assert.equal(changed.current_step,0);
 assert.equal(changed.action_revision,beforeEdit.action_revision+1);
 assert.deepEqual(changed.task_change.fields,[{field:'price',before:5000,after:7800}]);
 const {lastUndo,undoLastAction}=await import('../server/undo.js');
 const last=await lastUndo(liza,work);assert(last);
 await undoLastAction(liza,last.id);
 assert.equal((await approval(work)).task_change,null);
 assert.equal((await approval(work)).current_step,0);
 assert.equal((await api(liza,'/tasks/'+work+'/price','PATCH',{price:4999.99,expectedVersion:4})).status,200);
 assert.deepEqual(await route(work),[liza.id]);assert.equal((await approval(work)).current_step,0);
 assert.equal((await approval(work)).task_change.routeChanged,false);
 const {prepareVoiceAction}=await import('../server/bot-voice-actions.js');
 const voice=await prepareVoiceAction(liza,{kind:'accept',id:work,values:{}},db.pool);
 assert.equal(voice.payload.kind,'approve');assert.equal(voice.payload.target,(await approval(work)).id);
 assert.equal((await allow(work,liza)).state,'approved');
 const existing=await create(liza,other,5000);
 await setStatus(existing,'review');
 await assert.rejects(()=>workflow.reviewTask(director,existing,'accept','',1),/постановщик/);
 assert.equal((await workflow.reviewTask(liza,existing,'accept','',1)).state,'completed');
 assert.equal(await approval(existing),undefined);
 const submittedForWorker=await create(liza,other,7000);
 assert.equal((await workflow.reviewTask(liza,submittedForWorker,'submit','Результат сотрудника передан',1)).state,'review');
 assert.deepEqual(await route(submittedForWorker),[liza.id]);
 const legacy=await approval(submittedForWorker);
 await db.pool.query("UPDATE approvals SET current_step=1,route=$2 WHERE id=$1",
  [legacy.id,JSON.stringify([{userId:liza.id,label:'Постановщик'},{userId:director.id,label:'Руководитель продаж'}])]);
 const previousDecision=randomUUID();
 await db.pool.query("INSERT INTO decisions(id,approval_id,actor_id,step_index,decision,comment) VALUES($1,$2,$3,0,'approve','Ранее проверенный результат')",
  [previousDecision,legacy.id,liza.id]);
 await db.pool.query(await readFile(new URL('../server/migrations/051_creator_accepts_completion.sql',import.meta.url),'utf8'));
 assert.deepEqual(await route(submittedForWorker),[liza.id]);
 assert.equal((await approval(submittedForWorker)).action_revision,legacy.action_revision+1);
 assert.equal((await db.pool.query('SELECT actor_id FROM decisions WHERE id=$1',[previousDecision])).rows[0].actor_id,liza.id);
 await assert.rejects(()=>service.decide(director,legacy.id,{decision:'approve',comment:'',expectedRevision:legacy.action_revision,expectedStep:1}),/Версия согласования изменилась/);
 await assert.rejects(()=>allow(submittedForWorker,director),/постановщик/);
 assert.equal((await workflow.reviewTask(liza,submittedForWorker,'accept','',2)).state,'completed');
});

test('mobile Tasks switches between assigned and created without changing who can see them',async()=>{
 const withMe=await makeTask('Список только исполнителя',at('2000-01-03','12:00'));
 const fromMe=await makeTask('Список только постановщика',at('2000-01-03','13:00'),other);
 const foreign=await makeTask('Задача другого сотрудника',at('2000-01-03','14:00'),other);
 await db.pool.query('UPDATE tasks SET creator_id=$2 WHERE id=$1',[fromMe,worker.id]);
 await login(worker);
 const open=(scope?:'mine'|'created')=>api(worker,'/bot/screen?channel=mobile','POST',{screen:'tasks',scope});
 const assigned=await open();
 assert.equal(assigned.status,200);
 assert.equal(assigned.body.taskScope,'mine');
 assert.match(assigned.body.text,new RegExp('#'+withMe));
 assert(!assigned.body.text.includes('#'+fromMe)&&!assigned.body.text.includes('#'+foreign));
 const created=await open('created');
 assert.equal(created.status,200);
 assert.equal(created.body.taskScope,'created');
 assert.match(created.body.text,new RegExp('#'+fromMe));
 assert(!created.body.text.includes('#'+withMe)&&!created.body.text.includes('#'+foreign));
 assert.equal((await open('mine')).body.taskScope,'mine');
});

test('an employee can assign a new task across branches from the form, chat and voice',async()=>{
 const colleague:User={id:'fixture-cross-branch',name:'Кирилл Зареченский',role:'employee',branch_id:'Другой филиал',position:'Менеджер'};
 await db.pool.query("INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,$4,$5)",[colleague.id,colleague.name,colleague.role,colleague.branch_id,colleague.position]);
 await db.pool.query("INSERT INTO login_accounts(username,user_id,password_hash,enabled) VALUES('blocked-colleague',$1,'fixture',false)",[other.id]);
 await login(worker);await login(colleague);
 const people=await api(worker,'/task-assignees');
 assert.equal(people.status,200);
 assert(people.body.some((person:User)=>person.id===colleague.id));
 assert(!people.body.some((person:User)=>person.id===other.id));

 const input={title:'Проверить макет наклейки',description:'Задача сотруднику из другого филиала',assigneeId:colleague.id,price:2000,deadline:null,
  plannedStart:null,plannedEnd:null,important:false,customerRisk:false,parentId:null};
 const made=await api(worker,'/tasks','POST',input);
 assert.equal(made.status,201);
 const own=await api(worker,'/tasks/'+made.body.id);
 const incoming=await api(colleague,'/tasks/'+made.body.id);
 assert.equal(incoming.status,200);
 assert.equal(own.body.task.creator_id,worker.id);
 assert.equal(incoming.body.task.assignee_id,colleague.id);
 assert.equal(incoming.body.task.branch_id,colleague.branch_id);
 assert.equal((await api(worker,'/tasks','POST',{...input,assigneeId:other.id})).status,403);
 assert.equal((await db.pool.query('SELECT recipient_id FROM outbox WHERE task_id=$1 AND task_assignment',[made.body.id])).rows[0].recipient_id,colleague.id);

 const {botClick,botText,botView,botVoiceDraft}=await import('../server/bot.js');
 const pick=(screen:Awaited<ReturnType<typeof botView>>,label:string)=>screen.buttons.flat().find(choice=>choice.text===label)!.token;
 const channel='mobile:assignment';
 const home=await botView(worker,channel);
 await botClick(worker,channel,pick(home,'Новая задача'));
 const title=await botText(worker,channel,'Уточнить готовность макета',randomUUID());
 assert.match(title.text,/Имя и фамилия исполнителя/);
 assert(title.buttons.flat().some(item=>item.text==='Себе'));
 const who=await botText(worker,channel,'Зареченскому',randomUUID());
 assert.match(who.text,/Цена задачи/);
 for(const value of ['2000','без срока'])await botText(worker,channel,value,randomUUID());
 const confirmation=await botText(worker,channel,'Сверить макет с клиентом',randomUUID());
 assert.match(confirmation.text,/Исполнитель: Кирилл Зареченский/);
 const saved=await botClick(worker,channel,pick(confirmation,'Подтвердить и отправить'));
 assert.match(saved.text,/поставлена/);

 const voice=await botVoiceDraft(worker,channel,'Поставь задачу Зареченскому: Сверить цвета макета. Цена 2000.',randomUUID());
 assert.match(voice.text,/Исполнитель: Кирилл Зареченский/);
 assert(voice.buttons.flat().some(item=>item.text==='Подтвердить и отправить'),voice.text);
 assert.match((await botClick(worker,channel,pick(voice,'Подтвердить и отправить'))).text,/поставлена/);
 const voiceNoOwner=await botVoiceDraft(worker,channel,'Поставь задачу: сверить макет. Цена 2000.',randomUUID());
 assert.match(voiceNoOwner.text,/Имя и фамилия исполнителя/);
});

test('Telegram topics and push settings are independent',async()=>{
 assert.equal((await api(worker,'/notifications/preferences','PUT',{
  telegramDigest:true,telegramTopics:{assignments:false},pushEnabled:false,pushTopics:{deadlines:false}
 })).status,200);
 const saved=await api(worker,'/notifications/preferences');
 assert.deepEqual(saved.body,{telegramDigest:true,telegramTopics:{assignments:false},pushEnabled:false,pushTopics:{deadlines:false}});
 const id=await makeTask('Проверка подписки на назначения',null);
 const now=at('2035-02-01','10:15');
 await assignmentTime(id,at('2035-02-01','10:00'));
 const notice=await notices.claimTelegramTaskNotice(worker,chat,now);
 assert(!notice?.assignments.some(task=>task.id===id));
 await notices.generateWebTaskNotices(now);
 const feed=await api(worker,'/notifications');
 assert(feed.body.some((item:{task_notice?:{taskIds:string[]}})=>item.task_notice?.taskIds.includes(id)));
});

test('an assigned task stays unaccepted until the manager sets a plan, with separate calendar dates',async()=>{
 const calendar=await import('../server/personal-calendar.js'),service=await import('../server/service.js');
 const actor={...other,id:'calendar-manager',position:'Менеджер по продажам'};
 await db.pool.query('INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,$4,$5)',[actor.id,actor.name,actor.role,actor.branch_id,actor.position]);
 const stamp=at('2035-03-12','12:00'),personal=at('2035-03-11','14:00');
 const id=await makeTask('Назначение с отдельным личным планом',stamp,actor);
 const pending=(await service.visibleTasks(actor)).find(task=>task.id===id);
 assert.equal(pending?.assignment_pending,true);
 const {personalPlan}=await service.detail(actor,id);
 assert.equal(personalPlan?.needsAcceptance,true);
 await calendar.saveTaskPlan(actor,id,{epoch:personalPlan!.epoch,revision:personalPlan!.revision,plannedAt:personal.toISOString(),accept:true});
 assert.equal((await service.visibleTasks(actor)).find(task=>task.id===id)?.assignment_pending,false);
 const month=await calendar.personalCalendar(actor,'2035-03');
 assert.equal(Date.parse(month.deadlines?.find(task=>task.id===id)?.deadline??''),+stamp);
 assert.equal(Date.parse(month.scheduled.find(task=>task.id===id)!.plan.plannedAt!),+personal);
});
