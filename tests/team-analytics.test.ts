import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import pg from 'pg';
import type {Task,User} from '../shared/types.js';

const database='ruspet_analytics_test_'+randomBytes(6).toString('hex');
const now=new Date('2026-11-20T12:00:00+03:00');
const today=(time:string)=>'2026-11-20T'+time+':00+03:00';
const yesterday=(time:string)=>'2026-11-19T'+time+':00+03:00';
const tomorrow=(time:string)=>'2026-11-21T'+time+':00+03:00';
let connection:pg.Client,db:typeof import('../server/db.js'),analytics:typeof import('../server/team-analytics.js');
const people=new Map<string,User>();

async function task(id:string,person:string,branch:string,deadline:string|null,status:Task['status']='active',completedAt:string|null=null,title='Задача для проверки '+id){
 return (await db.pool.query<Task>(`INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,deadline,status,priority,code,created_at,completed_at)
  VALUES($1,$2,'Подробности задачи',$3,$4,'director',$5,$6,'normal','РЗМ*','2026-11-16T08:30:00+03:00',$7) RETURNING *`,
 [id,title,branch,person,deadline,status,completedAt])).rows[0];
}
async function change(kind:string,before:Task,after:Task,at:string,more:Record<string,unknown>={}){
 const id=randomUUID();
 await db.pool.query('INSERT INTO task_events(id,task_id,actor_id,kind,message,data,created_at) VALUES($1,$2,$3,$4,$4,$5,$6)',
  [id,after.id,before.assignee_id,kind,JSON.stringify({before,after,...more}),at]);
 return id;
}
before(async()=>{
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 connection=new pg.Client({connectionString:current});await connection.connect();await connection.query(`CREATE DATABASE ${database}`);
 const url=new URL(current);url.pathname='/'+database;process.env.DATABASE_URL=url.toString();
 db=await import('../server/db.js');await (await import('../scripts/migrate.js')).migrate();
 analytics=await import('../server/team-analytics.js');
 const staff=[
  ['director','Директор','director','Руководство','Генеральный директор'],
  ['deputy','Заместитель директора','admin','Головной офис / Продажи','Заместитель директора отдела продаж'],
  ['tech-admin','Администратор','admin','Технический отдел','Администратор'],
  ['head-crimea','Руководитель Крыма','employee','Крым','Руководитель филиала Крым'],
  ['head-krasnodar','Руководитель Краснодара','branch_manager','Краснодар','Руководитель филиала Краснодар'],
  ['rep-crimea','Продажи Крым','employee','Крым','Менеджер по продажам'],
  ['rep-aquas','Продажи AQUAS','employee','AQUAS','Менеджер по продажам'],
  ['multibranch','Продажи двух филиалов','employee','Не указан','Менеджер по продажам'],
  ['purchasing','Отдел закупок','branch_manager','Закупки','Руководитель отдела закупок'],
  ['buyer','Специалист по закупкам','employee','Закупки','Специалист по закупкам']
 ];
 for(const person of staff){
  const {rows:[user]}=await db.pool.query<User>('INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,$4,$5) RETURNING *',person);
  people.set(user.id,user);
 }
 await db.pool.query(`INSERT INTO org_reporting(employee_id,manager_id) VALUES
  ('rep-crimea','head-crimea'),('rep-aquas','head-crimea'),('multibranch','head-krasnodar'),('buyer','purchasing')`);
 await db.pool.query(`INSERT INTO staff_directory(id,source_key,name,name_key,organisation,department,emails,phones,user_id)
  VALUES($1,'staff-head-crimea','Руководитель Крыма','руководитель крыма','РУСПЭТ','AQUAS','{}','{}','head-crimea')`,[randomUUID()]);
 await db.pool.query("UPDATE users SET sales_analytics_access=true WHERE id='deputy'");
 people.set('deputy',{...people.get('deputy')!,sales_analytics_access:true});
 const {rows:[version]}=await db.pool.query("INSERT INTO rule_versions(config,author_id) VALUES('{}','director') RETURNING version");

 await task('old','rep-crimea','Крым',yesterday('09:00'));
 await task('expired','rep-crimea','Крым',today('09:00'));
 await task('due','rep-crimea','Крым',today('15:00'));
 const closed=await task('closed','rep-crimea','Крым',today('11:00'),'completed',today('10:20'));
 await change('bitrix_change',{...closed,status:'active',completed_at:null},closed,today('10:25'));
 const moved=await task('moved','rep-crimea','Крым',tomorrow('12:00'));
 await change('deadline_changed',{...moved,deadline:today('10:00')},moved,today('08:40'));
 await task('await','rep-crimea','Крым',yesterday('11:00'));
 const approval=randomUUID();
 await db.pool.query(`INSERT INTO approvals(id,task_id,requester_id,type,reason,plan,proposed_deadline,task_version,state,route,route_version,created_at)
  VALUES($1,'await','rep-crimea','deadline','Согласование','Подготовка',$2,1,'pending',$3,$4,$5)`,
 [approval,tomorrow('14:00'),JSON.stringify([{label:'Согласующий',userId:'director'}]),version.version,today('08:00')]);
 const previous=await task('last-day','rep-crimea','Крым',yesterday('09:00'),'completed',yesterday('12:00'));
 await change('task_completed',{...previous,status:'active',completed_at:null},previous,yesterday('12:00'));
 await task('aquas','rep-aquas','AQUAS',today('16:00'));
 await task('buyer','buyer','Закупки',yesterday('08:00'));
 await task('cross-k','multibranch','Крым',today('16:00'));
 await task('cross-r','multibranch','Краснодар',today('17:00'));
 await task('cross-unassigned','multibranch','Не указан',today('18:00'));
 await task('excluded','rep-crimea','Крым',yesterday('07:00'),'active',null,'Утренний чек-лист');
});

after(async()=>{
 await db?.pool.end();
 if(connection){await connection.query(`DROP DATABASE IF EXISTS ${database}`);await connection.end();}
});

const person=(id:string)=>people.get(id)!;
test('live front and week use task history, distinguish elapsed deadlines and retain actionable drilldown',async()=>{
 const group=['branch:Крым','person:rep-crimea'];
 const today=await analytics.analyticsOverview(person('deputy'),group,'day',now);
 assert.equal(today.numbers.front.length,6);
 assert.deepEqual(today.numbers.closed,['closed']);
 assert.deepEqual(today.numbers.moved,['moved']);
 assert.deepEqual(today.numbers.earlier,['old','await']);
 assert.deepEqual(today.numbers.expired,['expired']);
 assert.deepEqual(today.numbers.due,['due']);
 assert.deepEqual(today.numbers.waiting,['await']);
 assert.deepEqual(today.numbers.stuck,['await']);
 assert(!today.numbers.idle.includes('await'));
 assert(today.attention.some(row=>row.id==='await'&&row.person==='Директор'));
 assert.equal(today.numbers.front.length,today.numbers.closed.length+today.numbers.remaining.length+today.numbers.moved.length);

 const week=await analytics.analyticsOverview(person('deputy'),group,'week',now);
 const thursday=week.days.find(day=>day.date==='2026-11-19')!;
 const friday=week.days.find(day=>day.date==='2026-11-20')!;
 assert.deepEqual(thursday.numbers.late,['last-day']);
 assert(!thursday.numbers.overdue.includes('last-day'));
 assert.deepEqual(friday.numbers.onTime,['closed']);
 assert(!friday.numbers.overdue.includes('moved'));
 const drill=await analytics.analyticsTasks(person('deputy'),[...today.numbers.waiting,'buyer','excluded']);
 assert.equal(drill.length,1);assert.equal(drill[0].nextPerson,'Директор');assert.equal(drill[0].id,'await');
});

test('director sees company, authorized deputy sees sales, org leader keeps employee role and cross-branch tasks follow task branch',async()=>{
 const company=await analytics.analyticsOverview(person('director'),[],'day',now);
 assert(company.numbers.overdue.includes('buyer'));
 assert(company.rows.some(row=>row.label==='Продажи'));
 const sales=await analytics.analyticsOverview(person('deputy'),[],'day',now);
 assert(!sales.numbers.overdue.includes('buyer'));
 assert(sales.rows.some(row=>row.label==='На сверку'&&row.numbers.front.includes('cross-unassigned')));
 const lead=await analytics.analyticsOverview(person('head-crimea'),[],'day',now);
 assert.equal(person('head-crimea').role,'employee');
 assert(lead.numbers.front.includes('aquas'));assert(lead.numbers.front.includes('cross-k'));
 assert(!lead.numbers.front.includes('cross-r'));assert(!lead.numbers.front.includes('cross-unassigned'));
 const byTeam=await analytics.analyticsTasks(person('head-crimea'),['aquas','cross-k','cross-r','buyer']);
 assert.deepEqual(byTeam.map(task=>task.id),['aquas','cross-k']);
 assert(byTeam.every(task=>!task.nativeCard));
 await assert.rejects(()=>analytics.analyticsTasks(person('tech-admin'),['buyer']),{status:403});
 await assert.rejects(()=>analytics.analyticsOverview(person('rep-crimea'),[],'day',now),{status:403});
 await assert.rejects(()=>analytics.analyticsOverview(person('deputy'),['department:Закупки'],'day',now),{status:404});
});

test('analytics API checks company and team scopes for both dashboard and requested task IDs',async t=>{
 process.env.DEMO_AUTH='true';
 const {createApp}=await import('../server/app.js');
 const server=createApp().listen(0,'127.0.0.1');
 await new Promise<void>(resolve=>server.once('listening',resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api';
 const login=async(id:string)=>{
  const result=await fetch(base+'/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:id})});
  assert.equal(result.status,200);
  return result.headers.get('set-cookie')!.split(';')[0];
 };
 const deputy=await login('deputy'),employee=await login('rep-crimea'),administrator=await login('tech-admin'),director=await login('director');
 const overview=async(cookie:string,search='')=>fetch(base+'/analytics/overview'+search,{headers:{Cookie:cookie}});
 const drill=async(cookie:string)=>fetch(base+'/analytics/tasks',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({ids:['cross-k','buyer']})});
 assert.equal((await overview(employee)).status,403);
 assert.equal((await drill(administrator)).status,403);
 assert.equal((await overview(deputy,'?'+new URLSearchParams({group:'department:Закупки'}))).status,404);
 const query=new URLSearchParams([['period','week'],['group','department:Продажи'],['group','branch:Крым']]);
 const department=await overview(director,'?'+query);
 assert.equal(department.status,200);
 assert.equal((await department.json()).path.at(-1).label,'Крым');
 const sales=await drill(deputy);
 assert.equal(sales.status,200);assert.deepEqual((await sales.json()).map((row:{id:string})=>row.id),['cross-k']);
 assert.equal((await fetch(base+'/analytics/overview',{headers:{Cookie:deputy,'X-Ruspet-View-As':'head-crimea'}})).status,403);
});
