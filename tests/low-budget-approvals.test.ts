import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import pg from 'pg';
import type {Approval,Task,User} from '../shared/types.js';

const database='ruspet_low_budget_'+randomBytes(6).toString('hex');
let admin:pg.Client,db:typeof import('../server/db.js'),service:typeof import('../server/service.js'),workflow:typeof import('../server/workflow.js');
let server:Server,base:string,owner:User;
const cookies=new Map<string,string>();
const creator={id:'budget-creator',name:'Постановщик фикстуры',role:'employee',branch_id:'Крым',position:'Специалист'} as User;
const worker={id:'budget-worker',name:'Исполнитель фикстуры',role:'employee',branch_id:'Крым',position:'Менеджер по продажам'} as User;
const krasWorker={...worker,id:'budget-kras-worker',branch_id:'Краснодар'};
const sales={id:'budget-sales',name:'Владимир Тестовый',role:'sales_head',branch_id:'Головной офис / Продажи',position:'Руководитель продаж'} as User;
const kras={id:'budget-kras',name:'Макаренко Тестовый',role:'branch_manager',branch_id:'Краснодар',position:'Руководитель филиала'} as User;
const future=(days=4)=>new Date(Date.now()+days*86400000).toISOString();
async function api(user:User,path:string,body?:unknown,method=body===undefined?'GET':'POST'){
 const res=await fetch(base+'/api'+path,{method,headers:{Cookie:cookies.get(user.id)??'','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,data:await res.json() as any};
}
before(async()=>{
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 admin=new pg.Client({connectionString:current});await admin.connect();await admin.query('CREATE DATABASE '+database);
 const url=new URL(current);url.pathname='/'+database;process.env.DATABASE_URL=url.href;process.env.DEMO_AUTH='true';
 db=await import('../server/db.js');await (await import('../scripts/migrate.js')).migrate();await (await import('../scripts/seed.js')).seed();
 service=await import('../server/service.js');workflow=await import('../server/workflow.js');
 owner=(await db.pool.query<User>("SELECT * FROM users WHERE id='admin'")).rows[0];
 for(const user of [creator,worker,krasWorker,sales,kras])await db.pool.query('INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,$4,$5)',[user.id,user.name,user.role,user.branch_id,user.position]);
 await db.pool.query(`INSERT INTO approval_hierarchy(id,creator_first,branch_manager_id,sales_head_id,sales_head_approves_all,extra_deadline_assignee_ids)
  VALUES(1,true,$1,$2,true,$3) ON CONFLICT(id) DO UPDATE SET creator_first=true,branch_manager_id=$1,sales_head_id=$2,sales_head_approves_all=true,
  extra_deadline_assignee_ids=$3`,[kras.id,sales.id,[worker.id,krasWorker.id]]);
 const {createApp}=await import('../server/app.js');server=createApp().listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const user of [owner,creator,worker,krasWorker,sales,kras]){
  const res=await fetch(base+'/api/demo/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user.id})});assert.equal(res.status,200);
  cookies.set(user.id,res.headers.get('set-cookie')!.split(';')[0]);
 }
 assert.equal((await api(owner,'/approval-branch-leads',[{branchId:'Крым',userId:sales.id},{branchId:'Краснодар',userId:kras.id}],'PUT')).status,200);
});
after(async()=>{
 if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 if(db)await db.pool.end();
 if(admin){await admin.query('DROP DATABASE IF EXISTS '+database);await admin.end();}
});
async function make(price:number|null=4999.99,branch='Крым',by=creator){
 const assignee=branch==='Краснодар'?krasWorker:worker;
 const task=await workflow.createTask(owner,{title:'РВМ* Проверить тестовый результат',description:'Фикстура бюджета',price:price??0,assigneeId:assignee.id,
  deadline:future(1),plannedStart:null,plannedEnd:null,important:false,customerRisk:false,parentId:null});
 return (await db.pool.query<Task>('UPDATE tasks SET creator_id=$2,branch_id=$3,price=$4,source_fields=\'{}\' WHERE id=$1 RETURNING *',[task.id,by.id,branch,price])).rows[0];
}
async function request(task:Task){
 const user=task.assignee_id===krasWorker.id?krasWorker:worker;
 const response=await api(user,'/tasks/'+task.id+'/approvals',{type:'deadline',proposedDeadline:future(),reason:'Нужно проверить тестовый результат',expectedVersion:task.version});
 assert.equal(response.status,201,JSON.stringify(response.data));
 return (await db.pool.query<Approval>('SELECT * FROM approvals WHERE id=$1',[response.data.id])).rows[0];
}
const decision=(a:Approval,extra:object={})=>({decision:'approve',expectedStep:a.current_step,expectedRevision:a.action_revision,...extra});

test('all low budgets use only the creator, including sales staff, code В, control marks and zero price',async()=>{
 for(const price of [0,4999.99]){
  const task=await make(price);await (await import('../server/approval-hierarchy.js')).setApprovalWatch(sales,task.id,true);
  const a=await request(task);assert.deepEqual(a.route.map(step=>step.userId),[creator.id]);
  assert.equal((await api(sales,'/approvals/'+a.id+'/decision',decision(a))).status,403);
  assert.equal((await api(creator,'/approvals/'+a.id+'/decision',decision(a))).status,200);
  const after=(await service.detail(creator,task.id)).task;assert.equal(after.version,task.version+1);assert.equal(after.transfer_count,1);
 }
 for(const price of [5000,null])assert.deepEqual((await request(await make(price))).route.map(step=>step.userId),[creator.id,sales.id]);
 const ownRequest=await make(1000);
 const direct=await api(creator,'/tasks/'+ownRequest.id+'/approvals',{type:'deadline',reason:'Постановщик изменяет тестовый срок',proposedDeadline:future(),expectedVersion:1});
 assert.equal(direct.status,201);assert.equal(direct.data.applied,true);
});

test('a creator can explicitly approve and forward to the correct branch head without changing the deadline early',async()=>{
 for(const [branch,lead] of [['Крым',sales],['Краснодар',kras]] as const){
  const task=await make(1000,branch),a=await request(task);
  const workspace=await service.bootstrap(creator,true);
  assert(workspace.users.some(user=>user.id===lead.id),'A creator must see the branch approver before forwarding the request.');
  const forwarded=await api(creator,'/approvals/'+a.id+'/decision',decision(a,{forwardToBranch:true}));assert.equal(forwarded.status,200,JSON.stringify(forwarded.data));
  const pending=(await db.pool.query<Approval>('SELECT * FROM approvals WHERE id=$1',[a.id])).rows[0];
  assert.equal(pending.current_step,1);assert.equal(pending.branch_review_user_id,lead.id);assert.deepEqual(pending.route.map(step=>step.userId),[creator.id,lead.id]);
  assert.equal((await service.detail(creator,task.id)).task.deadline,task.deadline);assert.equal((await service.detail(creator,task.id)).task.version,task.version);
  assert.equal((await api(creator,'/approvals/'+a.id+'/decision',decision(a,{forwardToBranch:true}))).status,409);
  const wrong=lead.id===sales.id?kras:sales;assert([403,404].includes((await api(wrong,'/approvals/'+a.id+'/decision',decision(pending))).status));
  const accepted=await api(lead,'/approvals/'+a.id+'/decision',decision(pending,{approvedDeadline:future(6)}));assert.equal(accepted.status,200,JSON.stringify(accepted.data));
  const final=await service.detail(creator,task.id);assert.equal(final.task.transfer_count,1);assert.equal(final.task.version,task.version+1);
  assert.equal(final.decisions.filter(item=>item.approval_id===a.id).length,2);
 }
});

test('the Crimea branch head and sales head share one stage when one person has both responsibilities',async()=>{
 const {approvalHierarchy,hierarchyRoute}=await import('../server/approval-hierarchy.js');
 const hierarchy=await approvalHierarchy(db.pool);assert(hierarchy);
 const route=await hierarchyRoute(db.pool,{...hierarchy,creator_first:false,direct_assignee_ids:null,
  creator_approver_id:null,extra_deadline_assignee_ids:[],only_self_direct:false},await make(5000),worker.id);
 assert.deepEqual(route.map(step=>step.userId),[sales.id]);
});

test('explicit branch review survives price edits and cannot be silently removed by route recalculation',async()=>{
 const task=await make(1000,'Краснодар'),a=await request(task);
 assert.equal((await api(creator,'/approvals/'+a.id+'/decision',decision(a,{forwardToBranch:true}))).status,200);
 const edited=await api(owner,'/tasks/'+task.id+'/price',{price:2000,expectedVersion:task.version},'PATCH');assert.equal(edited.status,200,JSON.stringify(edited.data));
 const pending=(await db.pool.query<Approval>('SELECT * FROM approvals WHERE id=$1',[a.id])).rows[0];
 assert.equal(pending.state,'pending');assert.equal(pending.current_step,1);assert.deepEqual(pending.route.map(step=>step.userId),[creator.id,kras.id]);
 assert.equal((await api(kras,'/approvals/'+a.id+'/decision',decision(pending))).status,200);
});

test('forwarding enforces budget, role and a configured distinct branch approver',async()=>{
 const high=await request(await make(5000));assert.equal((await api(creator,'/approvals/'+high.id+'/decision',decision(high,{forwardToBranch:true}))).status,403);
 const selfHead=await request(await make(1000,'Крым',sales));assert.equal((await api(sales,'/approvals/'+selfHead.id+'/decision',decision(selfHead,{forwardToBranch:true}))).status,422);
 assert.equal((await api(creator,'/approval-branch-leads',[{branchId:'Крым',userId:sales.id}],'PUT')).status,403);
 assert.equal((await api(owner,'/approval-branch-leads',[{branchId:'Крым',userId:kras.id}],'PUT')).status,400);
 assert.equal((await api(owner,'/approval-branch-leads',[{branchId:'Крым',userId:null}],'PUT')).status,200);
 const missing=await request(await make());assert.equal((await api(creator,'/approvals/'+missing.id+'/decision',decision(missing,{forwardToBranch:true}))).status,422);
 assert.equal((await api(creator,'/approvals/'+missing.id+'/decision',decision(missing))).status,200);
 assert.equal((await api(owner,'/approval-branch-leads',[{branchId:'Крым',userId:sales.id}],'PUT')).status,200);
});

test('Telegram exposes an explicit branch handoff and confirms it with the same protected decision',async()=>{
 const bot=await import('../server/bot.js'),task=await make(),a=await request(task),channel='budget-branch-confirmation';
 const screen=await bot.botView(creator,channel,{op:'task_approval',id:task.id});
 const button=screen.buttons.flat().find(item=>item.text==='Согласовать и передать рукфилу');assert(button);
 const confirmation=await bot.botClick(creator,channel,button.token);assert.match(confirmation.text,/передать руководителю филиала/);
 const confirm=confirmation.buttons.flat().find(item=>item.text==='Да, передать рукфилу');assert(confirm);
 await bot.botClick(creator,channel,confirm.token);
 assert.equal((await db.pool.query<Approval>('SELECT * FROM approvals WHERE id=$1',[a.id])).rows[0].branch_review_user_id,sales.id);
});

test('undo restores the creator-only route and removes the explicit branch handoff marker',async()=>{
 const task=await make(),a=await request(task);
 assert.equal((await api(creator,'/approvals/'+a.id+'/decision',decision(a,{forwardToBranch:true}))).status,200);
 const undo=await api(creator,'/undo/last');assert.equal(undo.status,200);assert(undo.data?.id);
 assert.equal((await api(creator,'/undo',{id:undo.data.id,confirmed:true})).status,200);
 const restored=(await db.pool.query<Approval>('SELECT * FROM approvals WHERE id=$1',[a.id])).rows[0];
 assert.equal(restored.branch_review_user_id,null);assert.equal(restored.current_step,0);assert.deepEqual(restored.route.map(step=>step.userId),[creator.id]);
 assert.equal((await api(creator,'/approvals/'+restored.id+'/decision',decision(restored))).status,200);
});

test('migration assigns Crimea to the sales head Vladimir and Krasnodar to Makarenko and repairs only open low-budget routes',async()=>{
 const task=await make(),a=await request(task),high=await request(await make(5000));
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');await client.query('DROP TABLE approval_branch_leads');await client.query('ALTER TABLE approvals DROP COLUMN branch_review_user_id');
  await client.query('UPDATE approvals SET route=$2,current_step=1 WHERE id=$1',[a.id,JSON.stringify([{userId:creator.id,label:'Постановщик'},{userId:sales.id,label:'Руководитель продаж'}])]);
  await client.query('INSERT INTO decisions(id,approval_id,actor_id,step_index,decision,comment) VALUES($1,$2,$3,0,\'approve\',\'Ранее согласовано постановщиком\')',[randomUUID(),a.id,creator.id]);
  await client.query(await readFile(new URL('../server/migrations/062_low_budget_branch_review.sql',import.meta.url),'utf8'));
  const leads=(await client.query<{branch_id:string;user_id:string}>('SELECT * FROM approval_branch_leads ORDER BY branch_id')).rows;
  assert.equal(leads.find(item=>item.branch_id==='Крым')?.user_id,sales.id);assert.equal(leads.find(item=>item.branch_id==='Краснодар')?.user_id,kras.id);
  const reset=(await client.query<Approval>('SELECT * FROM approvals WHERE id=$1',[a.id])).rows[0];assert.equal(reset.current_step,0);assert.deepEqual(reset.route.map(step=>step.userId),[creator.id]);
  assert.equal((await client.query('SELECT id FROM decisions WHERE approval_id=$1',[a.id])).rowCount,1);
  assert.equal((await client.query<Approval>('SELECT * FROM approvals WHERE id=$1',[high.id])).rows[0].route.length,2);
  assert.equal((await client.query<Task>('SELECT * FROM tasks WHERE id=$1',[task.id])).rows[0].deadline,task.deadline);
 }finally{await client.query('ROLLBACK');client.release();}
});
