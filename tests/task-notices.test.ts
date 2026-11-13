import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Server} from 'node:http';
import pg from 'pg';
import webpush from 'web-push';
import type {User} from '../shared/types.js';

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
 await db.pool.query("UPDATE telegram_settings SET enabled=true,task_delivery=true,task_delivery_enabled_at='2035-01-01T00:00:00+03:00'");
 await db.pool.query("INSERT INTO telegram_binding(id,chat_id,user_id,paired_at) VALUES(1,$1,$2,'2035-01-01T00:00:00+03:00')",[chat,worker.id]);
 workflow=await import('../server/workflow.js');notices=await import('../server/task-notices.js');push=await import('../server/web-push.js');
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const user of [worker,other]){
  const res=await fetch(origin+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user.id})});
  assert.equal(res.status,200);cookies.set(user.id,res.headers.get('set-cookie')!.split(';')[0]);
 }
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
 const excluded=await makeTask('Дневной чек-лист',at(yesterday,'16:00'));
 const tick=(time:string)=>notices.claimTelegramTaskNotice(worker,chat,at(day,time));
 assert.equal(await tick('08:59'),null);
 const first=await tick('09:00');assert(first);
 assert.deepEqual(first.overdue.map(t=>t.id),[late]);
 assert.deepEqual(first.today.map(t=>t.id),[early,later]);
 assert(!first.overdue.some(t=>t.id===foreign||t.id===excluded));
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
 assert(!summary.body.includes('Чужая просрочка')&&!summary.body.includes('Дневной чек-лист'));
 await setStatus(later,'completed');await setStatus(foreign,'completed');await setStatus(excluded,'completed');
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

test('director gets one batch for current requests and the admin cannot send it twice',async()=>{
 const management=await import('../server/management-notices.js'),service=await import('../server/service.js');
 const adminUser=(await db.pool.query<User>("SELECT * FROM users WHERE id='admin'")).rows[0];
 const branch=(await db.pool.query<User>("SELECT * FROM users WHERE id='branch-fixture'")).rows[0];
 const id=await makeTask('РВМ* Работа для проверки руководителями',null);
 const first=await workflow.reviewTask(worker,id,'submit','Подготовили результат',1);
 assert.equal(first.state,'review');
 const a=(await db.pool.query('SELECT id FROM approvals WHERE task_id=$1',[id])).rows[0];
 await service.decide(branch,a.id,{decision:'approve',comment:''});
 assert.equal((await db.pool.query("SELECT count(*)::int n FROM outbox WHERE recipient_id=$1 AND dedupe_key LIKE $2",[director.id,'approval:'+a.id+':%'])).rows[0].n,0);
 assert.equal((await management.directorBatchStatus(adminUser))?.total,1);
 await assert.rejects(()=>management.sendDirectorBatch(worker),/администратору/);
 const concurrent=await Promise.allSettled([management.sendDirectorBatch(adminUser),management.sendDirectorBatch(adminUser)]);
 const sent=concurrent.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
 assert.equal(sent.length,1);assert.equal(sent[0].count,1);
 assert.equal((await management.directorBatchTasks(director,sent[0].id))[0].task_id,id);
 await assert.rejects(()=>management.directorBatchTasks(worker,sent[0].id),/недоступен/);
 assert.equal((await management.directorBatchStatus(adminUser))?.total,0);
 const bot=await import('../server/bot.js');
 const home=await bot.botView(director,'team-test');
 assert(home.buttons.flat().some(button=>button.text==='Мои задачи'));
 const team=await bot.botClick(director,'team-test',home.buttons.flat().find(button=>button.text==='Задачи команды')!.token);
 assert(!team.text.includes('Работа для проверки руководителями'));
 const personal=await bot.botClick(director,'team-test',team.buttons.flat().find(button=>button.text===worker.name)!.token);
 assert(personal.text.includes(worker.name));assert(!personal.text.includes(other.name));
});
