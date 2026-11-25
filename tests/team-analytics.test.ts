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
const monday=(time:string)=>'2026-11-23T'+time+':00+03:00';
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
 await db.pool.query("UPDATE tasks SET deadline='2026-11-25T09:00:00+03:00' WHERE id='closed'");
 await task('done-expired','rep-crimea','Крым',today('09:00'),'completed',today('11:00'));
 await task('done-monday','rep-crimea','Крым',monday('09:00'),'completed',today('11:01'));
 await task('done-later','rep-crimea','Крым','2026-11-24T09:00:00+03:00','completed',today('11:02'));
 await task('done-undated','rep-crimea','Крым',null,'completed',today('11:03'));
 const moved=await task('moved','rep-crimea','Крым',tomorrow('12:00'));
 await change('deadline_changed',{...moved,deadline:today('10:00')},moved,today('08:40'));
 await task('await','rep-crimea','Крым',yesterday('11:00'));
 await task('await-later','rep-crimea','Крым','2026-11-24T18:00:00+03:00');
 await task('ready-monday','rep-crimea','Крым',monday('16:00'));
 await task('ready-later','rep-crimea','Крым','2026-11-24T18:00:00+03:00');
 await task('ready-undated','rep-crimea','Крым',null);
 await task('await-review','rep-crimea','Крым',yesterday('16:00'),'review');
 const approval=randomUUID();
 await db.pool.query(`INSERT INTO approvals(id,task_id,requester_id,type,reason,plan,proposed_deadline,task_version,state,route,route_version,created_at)
  VALUES($1,'await','rep-crimea','deadline','Согласование','Подготовка',$2,1,'pending',$3,$4,$5)`,
 [approval,tomorrow('14:00'),JSON.stringify([{label:'Согласующий',userId:'director'}]),version.version,today('08:00')]);
 await db.pool.query(`INSERT INTO approvals(id,task_id,requester_id,type,reason,plan,proposed_deadline,task_version,state,route,route_version,created_at)
  VALUES($1,'await-later','rep-crimea','deadline','Согласование','Подготовка',$2,1,'pending',$3,$4,$5)`,
 [randomUUID(),monday('14:00'),JSON.stringify([{label:'Согласующий',userId:'director'}]),version.version,today('08:00')]);
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
test('analytics totals reconcile by deadline, show Monday on Friday and count approvals separately',async()=>{
 const group=['sales:branches','branch:Крым','person:rep-crimea'];
 const today=await analytics.analyticsOverview(person('deputy'),group,'day',now);
 assert.equal(today.nextWorkday,'2026-11-23');
 assert.deepEqual(today.numbers.remaining,{total:7,overdue:2,today:1,nextWorkday:2,later:1,withoutDeadline:1});
 assert.deepEqual(today.numbers.completed,{total:5,overdue:1,today:1,nextWorkday:1,later:1,withoutDeadline:1});
 assert.equal(today.numbers.approvals,2);
 assert.equal(today.numbers.review,1);
 assert.equal(today.numbers.outside,2);
 assert.equal(today.rows.length,0);
 assert.deepEqual(today.morning,{total:15,worked:5,untouched:10});
 assert.equal(today.waiting.find(wait=>wait.stage==='approval')?.count,2);
 assert.equal(today.waiting.find(wait=>wait.stage==='approval')?.oldest,'2026-11-20T05:00:00.000Z');
 const drill=await analytics.analyticsOverview(person('deputy'),group,'day',now,{metric:'remaining:later'});
 assert.deepEqual(drill.selection,{ids:['ready-later'],total:1});

 const week=await analytics.analyticsOverview(person('deputy'),group,'week',now);
 const thursday=week.days.find(day=>day.date==='2026-11-19')!;
 const friday=week.days.find(day=>day.date==='2026-11-20')!;
 assert.equal(thursday.completed,1);
 assert.equal(friday.completed,5);
 assert.equal(week.numbers.completed.total,6);
 assert.equal(week.days.reduce((sum,day)=>sum+day.completed,0),week.numbers.completed.total);
 assert.deepEqual(week.numbers.remaining,today.numbers.remaining);
});

test('director sees company, authorized deputy sees sales, org leader keeps employee role and cross-branch tasks follow task branch',async()=>{
 const company=await analytics.analyticsOverview(person('director'),[],'day',now);
 assert.equal(company.rows.find(row=>row.label==='Закупки')?.numbers.remaining.overdue,1);
 assert(company.rows.some(row=>row.label==='Продажи'));
 const sales=await analytics.analyticsOverview(person('deputy'),[],'day',now);
 assert.equal(company.numbers.remaining.overdue,sales.numbers.remaining.overdue+1);
 assert(sales.rows.some(row=>row.label==='Команда продаж'));
 const branches=await analytics.analyticsOverview(person('deputy'),['sales:branches'],'day',now);
 assert(branches.rows.some(row=>row.label==='На сверку'&&row.numbers.remaining.today===1));
 const lead=await analytics.analyticsOverview(person('head-crimea'),[],'day',now);
 assert.equal(person('head-crimea').role,'employee');
 assert.equal(lead.numbers.remaining.today,3);
 assert.equal((await analytics.analyticsOverview(person('head-crimea'),['person:multibranch'],'day',now)).numbers.remaining.today,1);
 await assert.rejects(()=>analytics.analyticsOverview(person('tech-admin'),[],'day',now),{status:403});
 await assert.rejects(()=>analytics.analyticsOverview(person('rep-crimea'),[],'day',now),{status:403});
 await assert.rejects(()=>analytics.analyticsOverview(person('deputy'),['department:Закупки'],'day',now),{status:404});
});

test('analytics API enforces scopes and returns aggregate figures without task details',async t=>{
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
 assert.equal((await overview(administrator)).status,403);
 assert.equal((await drill(director)).status,404);
 assert.equal((await overview(deputy,'?'+new URLSearchParams({group:'department:Закупки'}))).status,404);
 const query=new URLSearchParams([['period','week'],['group','department:Продажи'],['group','branch:Крым']]);
 const department=await overview(director,'?'+query);
 assert.equal(department.status,200);
 assert.equal((await department.json()).path.at(-1).label,'Крым');
 const sales=await (await overview(deputy)).json();
 assert.equal(typeof sales.numbers.remaining.overdue,'number');
 assert.equal(sales.attention,undefined);
 assert(!JSON.stringify(sales).includes('Задача для проверки'));
 const path=new URLSearchParams([['metric','remaining'],['group','sales:branches'],['group','branch:Крым']]);
 const list=await fetch(base+'/analytics/drilldown?'+path,{headers:{Cookie:deputy}});
 assert.equal(list.status,200);
 const selection=await list.json();
 assert(selection.ids.includes('cross-k'));
 assert(!selection.ids.includes('cross-r'));
 assert(!selection.ids.includes('buyer'));
 const layout=async(cookie:string,body?:unknown)=>fetch(base+'/analytics/layout',{
  method:body?'PUT':'GET',headers:{Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined
 });
 assert.equal((await layout(employee)).status,403);
 assert.equal((await layout(deputy,{column:'person',width:180})).status,200);
 assert.deepEqual(await (await layout(deputy)).json(),{person:180});
 assert.deepEqual(await (await layout(director)).json(),{});
 assert.equal((await fetch(base+'/owner/work-log.xlsx',{headers:{Cookie:administrator}})).status,403);
 assert.equal((await fetch(base+'/workspace/labels',{method:'PUT',headers:{Cookie:administrator,'Content-Type':'application/json'},
  body:JSON.stringify({key:'overview',label:'Недоступно для администратора'})})).status,403);
 assert.equal((await fetch(base+'/analytics/overview',{headers:{Cookie:deputy,'X-Ruspet-View-As':'head-crimea'}})).status,403);
});

test('a sales deputy sees the same disjoint teams in work, reports and the bot without gaining write access',async()=>{
 const {rows:[deputy]}=await db.pool.query<User>(`INSERT INTO users(id,name,role,branch_id,position,sales_analytics_access)
  VALUES('regional-deputy','Заместитель по продажам','branch_manager','Головной офис / Продажи','Заместитель руководителя продаж',true) RETURNING *`);
 await db.pool.query(`INSERT INTO users(id,name,role,branch_id,position) VALUES
  ('sales-analyst','Аналитик','employee','Головной офис / Продажи','Аналитик продаж'),
  ('analyst-assistant','Ассистент','employee','Головной офис / Продажи','Ассистент аналитика')`);
 await db.pool.query(`INSERT INTO org_reporting(employee_id,manager_id) VALUES
  ('sales-analyst','regional-deputy'),('analyst-assistant','sales-analyst')`);
 await db.pool.query(`INSERT INTO staff_directory(id,source_key,name,name_key,organisation,department,emails,phones,user_id) VALUES
  ($1,'sales-analyst','Аналитик','аналитик','РУСПЭТ','аналитики','{}','{}','sales-analyst'),
  ($2,'analyst-assistant','Ассистент','ассистент','РУСПЭТ','аналитики','{}','{}','analyst-assistant')`,[randomUUID(),randomUUID()]);
 await task('analyst-work','sales-analyst','Головной офис / Продажи',today('16:00'));
 await task('assistant-work','analyst-assistant','Головной офис / Продажи',today('16:00'));
 await task('deputy-work','regional-deputy','Головной офис / Продажи',today('16:00'));
 await task('warehouse-work','rep-crimea','Крым / Склад',today('16:00'));

 const service=await import('../server/service.js');
 const {workQueue}=await import('../shared/work-queue.js');
 const {managementProgress}=await import('../server/management.js');
 const {renderBotNavigation}=await import('../server/bot-navigation.js');
 const data={...await service.bootstrap(deputy,true),serverTime:now.toISOString()};
 assert.deepEqual(data.salesTeams?.team.slice().sort(),['analyst-work','assistant-work']);
 assert(data.salesTeams?.sales.includes('due')&&data.salesTeams.sales.includes('aquas'));
 assert(!data.salesTeams?.sales.some(id=>['buyer','excluded','warehouse-work','deputy-work'].includes(id)));
 assert(data.tasks.find(task=>task.id==='due')?.workspace_read_only);
 assert.equal((await service.detail(deputy,'due')).editAccess.canEdit,false);
 await assert.rejects(()=>service.addComment(deputy,'due','Попытка изменения вне обычных прав'),{status:404});
 await assert.rejects(()=>service.detail(deputy,'buyer'),{status:404});
 assert.deepEqual(workQueue(data,'team').today.map(row=>row.task.id).sort(),['analyst-work','assistant-work']);
 assert(workQueue(data,'sales').today.some(row=>row.task.id==='aquas'));
 assert(!workQueue(data,'sales').today.some(row=>row.task.id==='analyst-work'));
 assert(workQueue(data,'mine').today.some(row=>row.task.id==='deputy-work'));
 const teamProgress=await managementProgress(deputy,{team:'team'});
 assert.deepEqual(teamProgress.rows.map(row=>row.id).sort(),['analyst-assistant','sales-analyst']);
 assert((await managementProgress(deputy,{team:'sales'})).rows.some(row=>row.id==='rep-crimea'));
 const teamReport=await service.makeReport(deputy,'today','deputy-team-fixture',now,{view:'team'});
 const salesReport=await service.makeReport(deputy,'today','deputy-sales-fixture',now,{view:'sales'});
 assert.deepEqual(teamReport.rows.map(row=>row.id).sort(),['analyst-work','assistant-work']);
 assert(salesReport.rows.some(row=>row.id==='aquas'));
 assert(!salesReport.rows.some(row=>['buyer','warehouse-work','analyst-work'].includes(row.id)));
 await assert.rejects(()=>service.getReport({...deputy,sales_analytics_access:false},teamReport.id),{status:404});
 const menu=await renderBotNavigation(deputy,'deputy-fixture',{op:'inbox'});
 assert(menu.buttons.flat().some(button=>button.text==='Моя команда'));
 assert(menu.buttons.flat().some(button=>button.text==='Команда продаж'));
 const sales=await renderBotNavigation(deputy,'deputy-fixture',{op:'inbox',team:'sales'});
 assert.match(sales.text,/Сроки и действия · Команда продаж/);
});

test('a sales branch shows the shared director from the reporting tree when no local lead is assigned',async()=>{
 await db.pool.query("UPDATE users SET branch_id='AQUAS',position='Сотрудник AQUAS' WHERE id='head-crimea'");
 await db.pool.query("UPDATE org_reporting SET manager_id='director' WHERE employee_id='rep-crimea'");
 const overview=await analytics.analyticsOverview({...person('deputy'),role:'branch_manager'},['sales:branches'],'day',now);
 assert.equal(overview.access,'sales');
 assert.equal(overview.rows.find(row=>row.key==='branch:Крым')?.caption,'Руководитель · Директор');
 assert(!overview.rows.some(row=>row.label==='Закупки'));
 assert.equal((await db.pool.query("SELECT manager_id FROM org_reporting WHERE employee_id='rep-aquas'")).rows[0].manager_id,'head-crimea');
});

test('a sales employee is split by client branch even when tasks inherit the employee branch',async()=>{
 const previous=process.env.OKB_DATABASE_URL;
 process.env.OKB_DATABASE_URL=process.env.DATABASE_URL;
 const okb=await import('../server/okb.js');
 try{
  await okb.migrateOkb();
  for(const [name,branch] of [['Альфа Тара','КРЫМ'],['Бета Розлив','КРАСНОДАР']]){
   await okb.okbPool().query(`INSERT INTO companies(id,name,status,contact,notes,xlsx_source) VALUES($1,$2,'active','','',$3)`,
    [randomUUID(),name,JSON.stringify({branch})]);
  }
  await task('okb-crimea','multibranch','Краснодар',today('16:00'));
  await task('okb-krasnodar','multibranch','Краснодар',today('17:00'),'active',null,'Отправить предложение для Бета Розлив');
  await db.pool.query(`UPDATE tasks SET source_fields=jsonb_build_object('Компания','Альфа Тара') WHERE id='okb-crimea'`);
  const crimea=await analytics.analyticsOverview(person('deputy'),['sales:branches','branch:Крым','person:multibranch'],'day',now,{metric:'remaining'});
  const krasnodar=await analytics.analyticsOverview(person('deputy'),['sales:branches','branch:Краснодар','person:multibranch'],'day',now,{metric:'remaining'});
  assert(crimea.selection?.ids.includes('okb-crimea'));
  assert(!crimea.selection?.ids.includes('okb-krasnodar'));
  assert(krasnodar.selection?.ids.includes('okb-krasnodar'));
  assert(!krasnodar.selection?.ids.includes('okb-crimea'));
 }finally{
  await okb.closeOkb();
  if(previous===undefined)delete process.env.OKB_DATABASE_URL;else process.env.OKB_DATABASE_URL=previous;
 }
});

test('the morning snapshot keeps the original assignee when a later reassignment was undone',async()=>{
 const original=await task('undo-reassignment','rep-crimea','Крым',today('16:00'));
 const reassigned={...original,assignee_id:'rep-aquas',branch_id:'AQUAS',version:original.version+1};
 const edit=await change('task_edited',original,reassigned,today('10:00'));
 const undoId=randomUUID();
 await db.pool.query(`INSERT INTO undo_actions(id,task_id,actor_id,label,before_state,after_state)
  VALUES($1,$2,'director','Отмена переназначения','{}','{}')`,[undoId,original.id]);
 await change('action_undone',reassigned,{...original,version:reassigned.version+1},today('11:00'));
 await db.pool.query('INSERT INTO event_retractions(event_id,undo_id,created_at) VALUES($1,$2,$3)',[edit,undoId,today('11:00')]);
 const drill=await analytics.analyticsOverview(person('deputy'),['sales:branches','branch:Крым','person:rep-crimea'],'day',now,{metric:'untouched'});
 assert(drill.selection?.ids.includes(original.id));
});
