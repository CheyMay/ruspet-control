import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import type {Server} from 'node:http';
import type {User,Task} from '../shared/types.js';
import type {BitrixRequest} from '../server/bitrix-rest.js';
const name='ruspet_delegation_'+randomBytes(5).toString('hex'),okbName=name+'_okb';
const saved={demo:process.env.DEMO_AUTH,okb:process.env.OKB_DATABASE_URL};
let adminConnection:pg.Client,server:Server,base:string;const cookies=new Map<string,string>();
let db:typeof import('../server/db.js'),workflow:typeof import('../server/workflow.js'),okb:typeof import('../server/okb.js'),companies:typeof import('../server/company-responsibility.js'),reviews:typeof import('../server/delegation-review.js');
let people:User[],admin:User,director:User,lead:User,anna:User,ivan:User;
const person=(id:string)=>people.find(p=>p.id===id)!;
const input=(assigneeId:string,companyId?:string)=>({title:'ТЕСТ* Поручение по компании',description:'Тестовая проверка результата',price:12000,assigneeId,deadline:null,plannedStart:null,plannedEnd:null,important:false,customerRisk:false,parentId:null,companyId});
const row=async(id:string)=>(await db.pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
async function source(companyId?:string){return (await workflow.createTask(director,input(lead.id,companyId))).id;}
async function submit(id:string,actor:User){return workflow.reviewTask(actor,id,'submit','Проверка выполнена, результат приложен',(await row(id)).version);}
async function accept(id:string){return workflow.reviewTask(lead,id,'accept','',(await row(id)).version);}
async function company(managerId:string|null=anna.id){return okb.saveCompany(director,{name:'Вымышленная компания',taxId:null,status:'active',contact:'',notes:'',managerId});}
async function request(actor:User,path:string,body?:unknown,method=body?'POST':'GET'){
 const result=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',Cookie:cookies.get(actor.id)||''},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:result.status,data:await result.json() as any};
}
before(async()=>{
 const current=process.env.DATABASE_URL||JSON.parse(await readFile('.local/connection.json','utf8')).url;
 adminConnection=new pg.Client({connectionString:current});await adminConnection.connect();
 await adminConnection.query('CREATE DATABASE '+name);await adminConnection.query('CREATE DATABASE '+okbName);
 const url=new URL(current);url.pathname='/'+name;process.env.DATABASE_URL=url.toString();url.pathname='/'+okbName;process.env.OKB_DATABASE_URL=url.toString();process.env.DEMO_AUTH='true';
 db=await import('../server/db.js');await (await import('../scripts/migrate.js')).migrate();
 const seed=await import('../scripts/seed.js');await seed.seed();people=seed.demoUsers;
 admin=person('admin');director=person('director');lead=person('lead-msk');anna=person('anna');ivan=person('ivan');
 workflow=await import('../server/workflow.js');okb=await import('../server/okb.js');await okb.migrateOkb();await okb.migrateOkb();
 companies=await import('../server/company-responsibility.js');reviews=await import('../server/delegation-review.js');
 await db.pool.query("UPDATE bitrix_rest_gate SET portal='fixture.bitrix24.ru' WHERE id=1");
 await db.pool.query("INSERT INTO bitrix_user_links(user_id,external_id) VALUES('anna',202),('ivan',203)");
 server=(await import('../server/app.js')).createApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const actor of people){const login=await fetch(base+'/api/demo/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:actor.id})});assert.equal(login.status,200);cookies.set(actor.id,login.headers.get('set-cookie')!.split(';')[0]);}
});
after(async()=>{
 if(server)await new Promise<void>(r=>server.close(()=>r()));await okb?.closeOkb();await db?.pool.end();
 for(const [key,value] of Object.entries({DEMO_AUTH:saved.demo,OKB_DATABASE_URL:saved.okb}))if(value===undefined)delete process.env[key];else process.env[key]=value;
 if(adminConnection){await adminConnection.query('DROP DATABASE IF EXISTS '+name);await adminConnection.query('DROP DATABASE IF EXISTS '+okbName);await adminConnection.end();}
});

test('company manager drives delegation through shared API; a changed recommendation cannot be confirmed',async()=>{
 const c=await company(),id=await source(c.id);
 const targets=await request(lead,'/tasks/'+id+'/delegation-targets');assert.equal(targets.status,200);
 assert.equal(targets.data.responsibility.managerId,anna.id);assert.equal(targets.data.responsibility.source,'okb');
 assert.equal((await request(anna,'/okb/companies/'+c.id+'/responsibility')).status,403);
 assert.equal((await request(director,'/okb/companies/'+c.id+'/responsibility')).data.manager.id,anna.id);
 await okb.saveCompany(director,{name:c.name,taxId:null,status:c.status,contact:'',notes:'',managerId:ivan.id,version:c.version},c.id);
 assert.equal((await request(lead,'/tasks/'+id+'/delegate',{expectedVersion:1,responsibilityToken:targets.data.responsibility.token})).status,409);
 const next=(await workflow.delegationTargets(lead,id)).responsibility;
 const made=await request(lead,'/tasks/'+id+'/delegate',{expectedVersion:1,responsibilityToken:next.token});assert.equal(made.status,201);
 assert.equal((await row(made.data.id)).assignee_id,ivan.id);assert.equal(Number((await row(id)).price),12000);
 const c2=await company(person('olga').id),id2=await source(c2.id);
 assert.equal((await workflow.delegationTargets(lead,id2)).responsibility.managerId,null);
 assert.equal((await request(lead,'/tasks/'+id2+'/delegate',{expectedVersion:1})).status,422);
 assert.equal((await request(lead,'/tasks/'+id2+'/delegate',{expectedVersion:1,assigneeId:'olga'})).status,403);
 assert.equal((await request(lead,'/tasks/'+id2+'/delegate',{expectedVersion:1,assigneeId:anna.id})).status,201);
 assert.equal((await request(director,'/tasks/'+id2+'/delegate',{expectedVersion:1})).status,403);
});

test('CRM snapshots preserve all fields, map external managers, keep business status and support dry-run and repeat sync',async()=>{
 const item={externalId:'7101',name:'Фиктивный клиент CRM',externalManagerId:'202',raw:{ID:'7101',TITLE:'Фиктивный клиент CRM',ASSIGNED_BY_ID:'202',UF_SPECIAL:{code:'fixture'}}};
 const batch={portal:'fixture.bitrix24.ru',companies:[item]};
 assert.equal((await request(lead,'/integrations/v1/companies/batch',batch)).status,403);
 assert.equal((await request(director,'/integrations/v1/companies/batch',batch)).status,403);
 assert.equal((await request(admin,'/integrations/v1/companies/batch',{...batch,portal:'other.bitrix24.ru'})).status,409);
 const dry=await request(admin,'/integrations/v1/companies/batch',batch);assert.equal(dry.status,200);assert.equal(dry.data.dryRun,true);
 assert.equal((await okb.okbPool().query('SELECT count(*)::int n FROM companies WHERE bitrix_id=7101')).rows[0].n,0);
 const applied=await request(admin,'/integrations/v1/companies/batch',{...batch,dryRun:false});assert.equal(applied.status,200);
 const id=applied.data.companies[0].companyId,c=await okb.getCompany(director,id);
 assert.equal(c.status,'unclassified');assert.equal(c.manager_id,anna.id);assert.deepEqual(c.bitrix_snapshot,item.raw);
 await companies.syncCompanySnapshots(admin,{...batch,dryRun:false});assert.equal((await okb.getCompany(director,id)).version,c.version);
 const savedCompany=await okb.saveCompany(director,{name:c.name,taxId:null,status:'active',contact:'Сохранить контакт',notes:'Сохранить заметку',version:c.version},id);
 assert.equal(savedCompany.manager_id,anna.id);assert.equal(savedCompany.manager_source,'bitrix');
 const changed={...item,externalManagerId:'203',raw:{...item.raw,ASSIGNED_BY_ID:'203'}};
 await companies.syncCompanySnapshots(admin,{...batch,dryRun:false,companies:[changed]});const updated=await okb.getCompany(director,id);
 assert.equal(updated.manager_id,ivan.id);assert.equal(updated.status,'active');assert.equal(updated.contact,savedCompany.contact);assert.equal(updated.notes,savedCompany.notes);
 assert.equal(updated.version,savedCompany.version+1);
 const sourceId=await source(id);assert.equal((await workflow.delegationTargets(lead,sourceId)).responsibility.managerId,ivan.id);
 await okb.saveCompany(director,{name:updated.name,taxId:null,status:updated.status,contact:updated.contact,notes:updated.notes,version:updated.version,managerId:null},id);
 assert.match((await workflow.delegationTargets(lead,sourceId)).responsibility.reason!,/не указан/);
 assert.equal((await request(admin,'/integrations/v1/companies/batch',{...batch,companies:[{...item,externalManagerId:'203'}]})).status,400);
 await companies.syncCompanySnapshots(admin,{...batch,dryRun:false,companies:[{...item,externalManagerId:'9999',raw:{...item.raw,ASSIGNED_BY_ID:'9999'}}]});
 assert.match((await workflow.delegationTargets(lead,sourceId)).responsibility.reason!,/не сопоставлен/);
 assert.equal((await request(admin,'/integrations/v1/companies/batch',{...batch,companies:[item,item]})).status,400);
 assert.equal((await okb.okbPool().query('SELECT count(*)::int n FROM companies WHERE bitrix_id=7101')).rows[0].n,1);
});

test('task CRM company references resolve without exposing the registry; contacts and ambiguous companies are not guessed',async()=>{
 const id=await source(),c=await company();await okb.okbPool().query("UPDATE companies SET bitrix_portal='fixture.bitrix24.ru',bitrix_id=7201 WHERE id=$1",[c.id]);
 await db.pool.query("INSERT INTO bitrix_task_snapshots(external_id,snapshot,raw) VALUES(7301,'{}',$1)",[JSON.stringify({ufCrmTask:['CO_7201','C_888']})]);
 await db.pool.query("INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,7301,'{}',1)",[id]);
 assert.equal((await workflow.delegationTargets(lead,id)).responsibility.managerId,anna.id);
 const autoCopy=await workflow.delegateTask(lead,id,{expectedVersion:1});assert.equal((await row(autoCopy.id)).company_id,c.id);
 await db.pool.query("UPDATE bitrix_task_snapshots SET raw=$1 WHERE external_id=7301",[JSON.stringify({UF_CRM_TASK:['CO_7201','CO_7202']})]);
 assert.match((await workflow.delegationTargets(lead,id)).responsibility.reason!,/несколько компаний/);
 await db.pool.query("UPDATE bitrix_task_snapshots SET raw=$1 WHERE external_id=7301",[JSON.stringify({UF_CRM_TASK:['C_7201']})]);
 assert.equal((await workflow.delegationTargets(lead,id)).responsibility.managerId,null);
});

test('CRM pagination uses documented fields and stable IDs, rejects malformed pages',async()=>{
 const request:BitrixRequest=async<T>(method:Parameters<BitrixRequest>[0],params:object)=>{assert.equal(method,'crm.company.list');assert.deepEqual(params,{order:{ID:'ASC'},filter:{'>ID':'7'},select:['*','UF_*'],start:0});return [{ID:'8',TITLE:'Фикстура',ASSIGNED_BY_ID:'202',UF_EXTRA:'value'}] as T;};
 const result=await companies.fetchBitrixCompanies(request,'7');assert.equal(result.cursor,'8');assert.equal(result.complete,true);assert.equal(result.companies[0].externalManagerId,'202');assert.equal(result.companies[0].raw.UF_EXTRA,'value');
 await assert.rejects(()=>companies.fetchBitrixCompanies((async()=>[{ID:'7',TITLE:'Фикстура'}]) as BitrixRequest,'7'),/порядок/);
});

test('only acceptance of every delegated task submits the source once, with explicit automatic result and manual final acceptance',async()=>{
 const id=await source();const a=await workflow.delegateTask(lead,id,{assigneeId:anna.id,expectedVersion:1}),b=await workflow.delegateTask(lead,id,{assigneeId:ivan.id,expectedVersion:1});
 await assert.rejects(()=>submit(id,lead),/всех делегированных/);
 await submit(a.id,anna);assert.equal((await row(id)).status,'active');await accept(a.id);assert.equal((await row(id)).status,'active');
 await submit(b.id,ivan);assert.equal((await row(id)).status,'active');await accept(b.id);
 assert.equal((await row(id)).status,'review');assert.equal((await row(id)).version,2);assert.equal(Number((await row(id)).price),12000);
 const submission=(await db.pool.query('SELECT * FROM task_submissions WHERE task_id=$1',[id])).rows[0];
 assert.equal(submission.automatic,true);assert.deepEqual(submission.based_on_tasks.sort(),[a.id,b.id].sort());assert.match(submission.result,/Проверка выполнена/);
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM outbox WHERE task_id=$1 AND recipient_id=$2',[id,director.id])).rows[0].n,1);
 await db.transaction(client=>reviews.delegatedTaskAccepted(client,b.id));assert.equal(await reviews.runDelegationReviews(),0);
 assert.equal((await db.pool.query('SELECT count(*)::int n FROM task_submissions WHERE task_id=$1',[id])).rows[0].n,1);
 await workflow.reviewTask(director,id,'accept','',2);assert.equal((await row(id)).status,'completed');
});

test('concurrent sibling acceptances serialize the source; ordinary parent links do not trigger automatic submission',async()=>{
 const id=await source(),a=await workflow.delegateTask(lead,id,{assigneeId:anna.id,expectedVersion:1}),b=await workflow.delegateTask(lead,id,{assigneeId:ivan.id,expectedVersion:1});
 await submit(a.id,anna);await submit(b.id,ivan);await Promise.all([accept(a.id),accept(b.id)]);
 assert.equal((await row(id)).status,'review');assert.equal((await db.pool.query('SELECT count(*)::int n FROM delegation_auto_reviews WHERE source_id=$1',[id])).rows[0].n,1);
 const plainParent=await source(),plain=await workflow.createTask(lead,{...input(anna.id),parentId:plainParent});await submit(plain.id,anna);await accept(plain.id);assert.equal((await row(plainParent)).status,'active');
});

test('an active source approval defers automatic submission until it is resolved; a returned source is not repeatedly resubmitted',async()=>{
 const id=await source(),child=await workflow.delegateTask(lead,id,{assigneeId:anna.id,expectedVersion:1});
 const approval=randomUUID();await db.pool.query("INSERT INTO approvals(id,task_id,requester_id,type,reason,plan,task_version,state,route,route_version) SELECT $1,$2,$3,'completion','Фикстура согласования','Проверить результат',1,'pending',$4,max(version) FROM rule_versions",[approval,id,lead.id,JSON.stringify([{userId:director.id,label:'Директор'}])]);
 await submit(child.id,anna);await accept(child.id);assert.equal((await row(id)).status,'active');assert.equal(await reviews.runDelegationReviews(),0);
 // Fixture resolves the source route without making an unrelated external call.
 await db.pool.query("UPDATE approvals SET state='rejected' WHERE task_id=$1 AND state='pending'",[id]);assert(approval);
 assert.equal(await reviews.runDelegationReviews(),1);assert.equal((await row(id)).status,'review');
 await workflow.reviewTask(director,id,'return','Нужна дополнительная проверка',2);await reviews.runDelegationReviews();assert.equal((await row(id)).status,'active');
});

test('undo of a contributing acceptance also withdraws the automatic source submission and preserves history',async()=>{
 const id=await source(),child=await workflow.delegateTask(lead,id,{assigneeId:anna.id,expectedVersion:1});await submit(child.id,anna);await accept(child.id);
 const undo=await import('../server/undo.js'),action=await undo.lastUndo(lead,child.id);assert(action);await undo.undoLastAction(lead,action.id);
 assert.equal((await row(child.id)).status,'review');assert.equal((await row(id)).status,'active');
 const entries=(await db.pool.query('SELECT * FROM task_submissions WHERE task_id=$1',[id])).rows;assert.equal(entries.length,1);assert(entries[0].withdrawn_at);
 assert((await db.pool.query('SELECT reverted_at FROM delegation_auto_reviews WHERE source_id=$1',[id])).rows[0].reverted_at);
 await accept(child.id);assert.equal((await row(id)).status,'review');
});

test('undo refuses to revert a source after later activity or external publication, leaving both tasks consistent',async()=>{
 const undo=await import('../server/undo.js');
 for(const mode of ['activity','published']){
  const id=await source(),child=await workflow.delegateTask(lead,id,{assigneeId:anna.id,expectedVersion:1});await submit(child.id,anna);await accept(child.id);
  const action=await undo.lastUndo(lead,child.id);assert(action);
  if(mode==='activity')await (await import('../server/service.js')).addComment(director,id,'Проверяем принятый результат');
  else await db.pool.query("UPDATE task_sync_queue SET attempts=1,state='sent' WHERE task_id=$1 AND task_version=2",[id]);
  await assert.rejects(()=>undo.undoLastAction(lead,action.id),/Основная задача|Основная|основной/);
  assert.equal((await row(child.id)).status,'completed');assert.equal((await row(id)).status,'review');
 }
});

test('undo handles an earlier contributor accepted by another reviewer and a deferred automatic submission',async()=>{
 const id=await source(),a=await workflow.delegateTask(lead,id,{assigneeId:anna.id,expectedVersion:1}),b=await workflow.delegateTask(lead,id,{assigneeId:ivan.id,expectedVersion:1});
 await submit(a.id,anna);await submit(b.id,ivan);await accept(a.id);
 const undo=await import('../server/undo.js'),action=await undo.lastUndo(lead,a.id);assert(action);
 await workflow.reviewTask(director,b.id,'accept','',(await row(b.id)).version);assert.equal((await row(id)).status,'review');
 await undo.undoLastAction(lead,action.id);assert.equal((await row(a.id)).status,'review');assert.equal((await row(b.id)).status,'completed');assert.equal((await row(id)).status,'active');
 // A pending route makes the next acceptance produce its automatic effect later.
 await db.pool.query("INSERT INTO approvals(id,task_id,requester_id,type,reason,plan,task_version,state,route,route_version) SELECT $1,$2,$3,'completion','Фикстура','Проверить',3,'pending',$4,max(version) FROM rule_versions",[randomUUID(),id,lead.id,JSON.stringify([{userId:director.id,label:'Директор'}])]);
 await accept(a.id);const deferred=await undo.lastUndo(lead,a.id);assert(deferred);assert.equal((await row(id)).status,'active');
 await db.pool.query("UPDATE approvals SET state='rejected' WHERE task_id=$1 AND state='pending'",[id]);await reviews.runDelegationReviews();assert.equal((await row(id)).status,'review');
 await undo.undoLastAction(lead,deferred.id);assert.equal((await row(id)).status,'active');assert.equal((await row(a.id)).status,'review');
});

test('Telegram previews the company manager, keeps manual fallback and makes confirmation idempotent',async()=>{
 const c=await company(),id=await source(c.id),bot=await import('../server/bot.js'),channel='fixture-company-delegation';
 const preview=await bot.botView(lead,channel,{op:'delegate_list',id});assert.match(preview.text,/Ответственный компании/);assert.match(preview.text,new RegExp(anna.name));
 const manual=await bot.botClick(lead,channel,preview.buttons.flat().find(b=>b.text==='Другой сотрудник')!.token);assert(manual.buttons.flat().some(b=>b.text===ivan.name));
 const fresh=await bot.botView(lead,channel,{op:'delegate_list',id});
 const confirm=fresh.buttons.flat().find(b=>b.text==='Создать поручение')!.token;
 const result=await bot.botClick(lead,channel,confirm);assert.deepEqual(await bot.botClick(lead,channel,confirm),result);
 const copies=(await db.pool.query('SELECT * FROM tasks WHERE delegated_from_id=$1',[id])).rows;assert.equal(copies.length,1);assert.equal(copies[0].assignee_id,anna.id);
 const id2=await source(c.id),stale=await bot.botView(lead,channel,{op:'delegate_list',id:id2});
 const updated=await okb.getCompany(director,c.id);await okb.saveCompany(director,{name:c.name,taxId:null,status:'active',contact:'',notes:'',version:updated.version,managerId:ivan.id},c.id);
 await assert.rejects(()=>bot.botClick(lead,channel,stale.buttons.flat().find(b=>b.text==='Создать поручение')!.token),/Ответственный компании изменился/);
});
