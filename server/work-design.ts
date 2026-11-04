import {measureTasks} from '../shared/process-metrics.js';
import {processGraph} from './process-graph-input.js';
import {graphErrors,runGraph,type GraphAction,type PlannedAction,type Trace} from '../shared/process-graph.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,type Db} from './db.js';
import {assert,AppError,canSee,globalAccess} from './domain.js';
import {createTask,validateTaskAssignment} from './workflow.js';
import {notify,visibleTasks} from './service.js';
import {customFieldsInput,taskInput,type TaskInput} from './task-input.js';
import {getCompany,okbConfigured,okbPool,requireOkbAccess} from './okb.js';
import {chooseBranch,renderTemplate} from '../shared/draw-run-rules.js';
import type {Task,User} from '../shared/types.js';

const date=z.iso.datetime({offset:true});
const frequency=z.enum(['daily','weekly','monthly']);
type Frequency=z.infer<typeof frequency>;
const deadlineHours=z.number().int().min(1).max(8760).nullable();
export const scheduleInput=z.object({template:taskInput,frequency,every:z.number().int().min(1).max(30),startsAt:date,deadlineHours});
export const processInput=z.object({
 name:z.string().trim().min(3).max(120),graph:processGraph.optional(),
 trigger:z.enum(['company_status','task_accepted','company_quiet','monitor']).default('company_status'),
 monitor:z.object({subjectId:z.string().trim().min(1).max(100),everyMinutes:z.number().int().min(5).max(1440)}).optional(),
 companyId:z.uuid().nullable().optional(),quietDays:z.number().int().min(1).max(365).optional(),
 field:z.enum(['company.name','company.status','company.previousStatus','task.title','task.assigneeId']),
 operator:z.enum(['=','!=','contains','exists']),
 value:z.string().trim().max(250),
 branch:z.enum(['yes','no']),
 title:z.string().trim().min(3).max(500),assigneeId:z.string().trim().min(1).max(100),
 description:z.string().trim().max(10000).optional(),customFields:customFieldsInput.optional(),
 price:z.number().min(0).max(999999999999.99),deadlineHours
}).refine(input=>!!input.graph||input.operator==='exists'||input.value.length>0,'Укажите значение условия.')
 .refine(input=>input.trigger!=='monitor'||!!input.graph&&!!input.monitor,'Настройте проверку по расписанию и добавьте схему.')
 .refine(input=>input.trigger!=='company_quiet'||!!input.quietDays,'Укажите срок без контакта.')
 .refine(input=>!!input.graph||input.trigger==='task_accepted'||!input.field.startsWith('task.'),'Поле задачи доступно для события приёмки.');
type Definition=z.infer<typeof processInput>;
const companySample=z.object({name:z.string().max(250),status:z.enum(['active','former','prospect']),previousStatus:z.enum(['active','former','prospect']).nullable()});
const msDay=86400000,moscow=10800000;

export function nextOccurrence(startsAt:string,unit:Frequency,every:number,after:Date){
 const anchor=Date.parse(startsAt);
 if(after.getTime()<anchor)return new Date(anchor);
 if(unit!=='monthly'){
  const step=msDay*every*(unit==='weekly'?7:1);
  return new Date(anchor+(Math.floor((after.getTime()-anchor)/step)+1)*step);
 }
 const initial=new Date(anchor+moscow),end=new Date(after.getTime()+moscow);
 const months=(end.getUTCFullYear()-initial.getUTCFullYear())*12+end.getUTCMonth()-initial.getUTCMonth();
 for(let i=Math.floor(months/every);;i++){
  const target=new Date(initial);
  target.setUTCDate(1);target.setUTCMonth(initial.getUTCMonth()+i*every);
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(initial.getUTCDate(),last));
  const result=new Date(target.getTime()-moscow);
  if(result>after)return result;
 }
}
function withDue(input:TaskInput,at:Date,hours:number|null):TaskInput{
 return {...input,deadline:hours===null?null:new Date(at.getTime()+hours*3600000).toISOString()};
}
async function makeTask(db:Db,actor:User,input:TaskInput,key:string){
 const {id}=await createTask(actor,input);
 if(actor.id!==input.assigneeId)await notify(db,id,input.assigneeId,'Новая задача #'+id+' · '+input.title,key);
 return id;
}
export async function saveSchedule(actor:User,input:unknown){
 const value=scheduleInput.parse(input);
 assert(Date.parse(value.startsAt)>=Date.now()-60000,400,'Укажите ближайшее или будущее время запуска.');
 if(value.template.companyId)await getCompany(actor,value.template.companyId);
 assert(value.template.price!==undefined,400,'Укажите цену задачи.');
 assert(!value.template.plannedStart&&!value.template.plannedEnd,400,'Для повторений используются относительные крайние сроки.');
 return transaction(async db=>{
  await validateTaskAssignment(db,actor,value.template);
  const id=randomUUID();
  await db.query('INSERT INTO task_schedules(id,actor_id,template,frequency,every,starts_at,next_at,deadline_hours) VALUES($1,$2,$3,$4,$5,$6,$6,$7)',
   [id,actor.id,JSON.stringify(value.template),value.frequency,value.every,value.startsAt,value.deadlineHours]);
  return {id};
 });
}
export async function listSchedules(actor:User){
 return (await pool.query(`SELECT id,actor_id,template->>'title' title,frequency,every,next_at,enabled,last_task_id,last_error
  FROM task_schedules WHERE actor_id=$1 OR $2 ORDER BY next_at,id LIMIT 100`,[actor.id,globalAccess(actor)])).rows;
}
export async function toggleSchedule(actor:User,id:string,enabled:boolean){
 const changed=await pool.query('UPDATE task_schedules SET enabled=$3 WHERE id=$1 AND (actor_id=$2 OR $4)',[id,actor.id,enabled,globalAccess(actor)]);
 assert(changed.rowCount,404,'Расписание не найдено.');
}
export async function runSchedules(now=new Date()){
 for(let i=0;i<8;i++){
  let selectedId:string|undefined;
  try{
   const found=await transaction(async db=>{
    const item=(await db.query(`SELECT * FROM task_schedules WHERE enabled AND next_at<=$1 AND (retry_at IS NULL OR retry_at<=$1)
     ORDER BY next_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[now.toISOString()])).rows[0];
    if(!item)return false;
    selectedId=item.id;
    const actor=(await db.query<User>('SELECT * FROM users WHERE id=$1',[item.actor_id])).rows[0];
    const input=withDue(taskInput.parse(item.template),now,item.deadline_hours);
    const id=await makeTask(db,actor,input,'schedule:'+item.id+':'+item.next_at);
    await db.query('UPDATE task_schedules SET next_at=$2,last_task_id=$3,retry_at=NULL,last_error=NULL WHERE id=$1',
     [item.id,nextOccurrence(item.starts_at,item.frequency,item.every,now).toISOString(),id]);
    return true;
   });
   if(!found)break;
  }catch(e){
   if(!selectedId)throw e;
   await pool.query("UPDATE task_schedules SET last_error=$2,retry_at=$3 WHERE id=$1 AND next_at<=$4",
    [selectedId,e instanceof AppError?e.message:'Не удалось создать задачу.',new Date(now.getTime()+300000).toISOString(),now.toISOString()]);
  }
 }
}
function processTask(value:Definition,context:Record<string,unknown>,at:Date,action:GraphAction=value){
 return withDue(taskInput.parse({title:renderTemplate(action.title,context),description:value.description||'Создана бизнес-процессом «'+value.name+'».',customFields:value.customFields,
  monitor:z.object({subjectId:z.string().trim().min(1).max(100),everyMinutes:z.number().int().min(5).max(1440)}).optional(),
 companyId:z.uuid().safeParse((context.company as {id?:string}|undefined)?.id).data,assigneeId:action.assigneeId,price:action.price,deadline:null,plannedStart:null,plannedEnd:null,parentId:null,important:null,customerRisk:null}),at,action.deadlineHours);
}
function processPlan(value:Definition,context:Record<string,unknown>,measurements:Record<string,number>={}):{branch:'yes'|'no';actions:PlannedAction[];trace:Trace[]}{
 if(value.graph)return runGraph(value.graph,context,measurements);
 const branch=chooseBranch(value,context);
 return {branch,actions:branch===value.branch?[{type:'task',id:'task',config:value,context}]:[],trace:[{nodeId:'condition',label:value.field+' '+value.operator+' '+value.value,branch}]};
}
function validateGraph(value:Definition){
 if(!value.graph)return;
 const errors=graphErrors(value.graph,value.trigger);
 if(value.trigger==='monitor'&&!value.graph.nodes.some(node=>node.type==='metric'))errors.push('Добавьте условие по показателю.');
 if(value.trigger!=='monitor'&&value.graph.nodes.some(node=>node.type==='notify'||node.type==='task'&&node.config.assigneeId.startsWith('@')))errors.push('Динамические получатели и уведомления доступны в проверках по расписанию.');
 assert(!errors.length,400,errors.join(' '));
}
type Person=Pick<User,'id'|'name'>;
function measurement(value:Definition,tasks:Task[],at:Date){
 const values:Record<string,number>={},matched=new Map<string,Task>();
 for(const node of value.graph?.nodes??[]){
  if(node.type!=='metric')continue;
  const result=measureTasks(tasks,node.config,at);
  values[node.id]=result.value;
  for(const task of result.matched)matched.set(task.id,task);
 }
 return {values,matched:[...matched.values()]};
}
async function processSubjects(value:Definition,db:Db=pool,previewId?:string):Promise<Person[]>{
 if(!value.monitor)return [];
 const subjectId=value.monitor.subjectId;
 if(subjectId==='*'){
  return (await db.query<Person>(`SELECT id,name FROM users WHERE role='employee' AND ($1::text IS NULL OR id=$1) ORDER BY id`,[previewId??null])).rows;
 }
 return (await db.query<Person>('SELECT id,name FROM users WHERE id=$1',[subjectId])).rows;
}
async function validateTargets(db:Db,actor:User,value:Definition){
 const sample={company:{name:'Компания',status:'active',previousStatus:'prospect'},task:{title:'Исходная задача'},subject:{name:'Сотрудник'},metric:{value:6}};
 for(const action of value.graph?value.graph.nodes.flatMap(node=>node.type==='task'?[node.config]:[]):[value]){
  const dynamic=value.trigger==='monitor'&&['@manager','@subject'].includes(action.assigneeId);
  await validateTaskAssignment(db,actor,processTask(value,sample,new Date(),dynamic?{...action,assigneeId:actor.id}:action));
 }
 if(value.monitor?.subjectId&&value.monitor.subjectId!=='*')assert((await processSubjects(value,db)).length,400,'Выберите сотрудника для проверки.');
}
export async function previewProcess(actor:User,body:unknown){
 requireOkbAccess(actor);
 const {definition,sample,task,previewSubject}=z.object({definition:processInput,sample:companySample,task:z.object({title:z.string().max(500),assigneeId:z.string().max(100)}).optional(),previewSubject:z.string().max(100).optional()}).parse(body);
 validateGraph(definition);
 const now=new Date(),subject=definition.monitor?(await processSubjects(definition,pool,previewSubject)).at(0):undefined;
 if(definition.monitor)assert(subject,400,'Выберите сотрудника для пробного запуска.');
 const tasks=definition.graph?.nodes.some(node=>node.type==='metric')?await visibleTasks(actor):[];
 const scope=tasks.filter(row=>(!subject||row.assignee_id===subject.id)&&(!definition.companyId||row.company_id===definition.companyId));
 const context=definition.trigger==='monitor'?{subject}:{company:sample,task},measured=measurement(definition,scope,now);
 const plan=processPlan(definition,context,measured.values);
 const titles=plan.actions.flatMap(action=>action.type==='task'?[processTask(definition,action.context,now,action.config).title]:[]);
 const notices=plan.actions.flatMap(action=>action.type==='notify'?[renderTemplate(action.config.message,action.context)]:[]);
 return {branch:plan.branch,title:titles[0]??null,...(definition.graph?{titles,trace:plan.trace,...(notices.length?{notices}:{})}:{}),...(subject?{subject:subject.name}:{})};
}
export async function saveProcess(actor:User,body:unknown,existingId?:string){
 requireOkbAccess(actor);
 const value=processInput.parse(body);
 if(value.companyId)await getCompany(actor,value.companyId);
 return transaction(async db=>{
  await validateTargets(db,actor,value);
  const id=existingId??randomUUID();
  if(existingId){
   const updated=await db.query('UPDATE business_processes SET name=$2,definition=$3,revision=revision+1 WHERE id=$1',[id,value.name,JSON.stringify(value)]);
   assert(updated.rowCount,404,'Процесс не найден.');
   return {id};
  }
  await db.query('INSERT INTO business_processes(id,actor_id,name,definition) VALUES($1,$2,$3,$4)',[id,actor.id,value.name,JSON.stringify(value)]);
  return {id};
 });
}
export async function listProcesses(actor:User){
 requireOkbAccess(actor);
 const items=(await pool.query('SELECT p.id,p.actor_id,p.name,p.definition,p.enabled,p.enabled_since,p.revision,p.published_revision,v.definition AS published_definition FROM business_processes p LEFT JOIN business_versions v ON v.process_id=p.id AND v.revision=p.published_revision ORDER BY p.created_at DESC LIMIT 100')).rows;
 const runs=(await pool.query(`SELECT r.process_id,r.branch,r.task_id,r.error,r.created_at,r.trace,r.process_revision,
  (SELECT json_agg(t.task_id ORDER BY t.task_id) FROM business_run_tasks t WHERE t.process_id=r.process_id AND t.event_id=r.event_id) AS task_ids
  FROM business_runs r ORDER BY created_at DESC LIMIT 30`)).rows;
 return {items,runs};
}
export async function toggleProcess(actor:User,id:string,enabled:boolean,expectedRevision?:number){
 requireOkbAccess(actor);
 await transaction(async db=>{
  const row=(await db.query('SELECT * FROM business_processes WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert(row,404,'Процесс не найден.');
  assert(expectedRevision===undefined||row.revision===expectedRevision,409,'Процесс изменился. Обновите список и подтвердите ещё раз.');
  if(!enabled){await db.query('UPDATE business_processes SET enabled=false,revision=revision+1 WHERE id=$1',[id]);return;}
  const definition=processInput.parse(row.definition);
  validateGraph(definition);
  const owner=(await db.query<User>('SELECT * FROM users WHERE id=$1',[row.actor_id])).rows[0];
  requireOkbAccess(owner);
  await validateTargets(db,owner,definition);
  const cursor=definition.trigger==='company_status'?(await okbPool().query('SELECT coalesce(max(id),0) cursor FROM company_status_events')).rows[0].cursor:0;
  const revision=row.revision+1;
  await db.query('INSERT INTO business_versions(process_id,revision,definition,published_by) VALUES($1,$2,$3,$4)',[id,revision,JSON.stringify(definition),actor.id]);
  await db.query(`UPDATE business_processes SET enabled=true,revision=$2,published_revision=$2,enabled_since=clock_timestamp(),
   quiet_cursor=NULL,event_cursor=$3,monitor_next_at=NULL WHERE id=$1`,[id,revision,cursor]);
 });
}
type RunContext={company?:{id?:string;name:string;status:string;previousStatus?:string|null};task?:{title:string;assigneeId:string};subject?:Person};
type ProcessRow={id:string;actor_id:string;published_revision:number};
type Plan=ReturnType<typeof processPlan>;
async function recipient(db:Db,id:string,subject?:Person){
 if(id==='@subject'){assert(subject,400,'Укажите сотрудника для проверки.');return subject.id;}
 if(id!=='@manager')return id;
 assert(subject,400,'Укажите сотрудника для поиска руководителя.');
 const manager=(await db.query('SELECT manager_id FROM org_reporting WHERE employee_id=$1',[subject.id])).rows[0]?.manager_id;
 assert(manager,409,'В оргструктуре не назначен руководитель для '+subject.name+'.');
 return manager as string;
}
async function executeProcess(db:Db,row:ProcessRow,definition:Definition,eventId:string,context:RunContext,now:Date,
 prepared?:{plan:Plan;matched:Task[]}){
 const actor=(await db.query<User>('SELECT * FROM users WHERE id=$1',[row.actor_id])).rows[0];
 const tasks=!prepared&&definition.graph?.nodes.some(node=>node.type==='metric')?await visibleTasks(actor,db):[];
 const plan=prepared?.plan??processPlan(definition,context,measurement(definition,tasks.filter(task=>!definition.companyId||task.company_id===definition.companyId),now).values);
 const taskIds:string[]=[];
 let error:string|null=null;
 if(plan.actions.length){
  await db.query('SAVEPOINT process_task');
  try{
   requireOkbAccess(actor);
   for(const action of plan.actions){
    const key='process:'+row.id+':'+eventId+':'+action.id;
    const id=await recipient(db,action.type==='task'?action.config.assigneeId:action.config.recipientId,context.subject);
    if(prepared){
     const target=(await db.query<User>('SELECT * FROM users WHERE id=$1',[id])).rows[0];
     assert(target,400,'Получатель не найден.');
     assert(prepared.matched.every(task=>canSee(target,task)),403,'Получатель не видит все задачи из выборки.');
    }
    if(action.type==='task')taskIds.push(await makeTask(db,actor,processTask(definition,action.context,now,{...action.config,assigneeId:id}),key));
    else{
     const message=renderTemplate(action.config.message,action.context).trim();
     assert(message.length>0&&message.length<=220,400,'Текст уведомления после подстановки должен содержать до 220 символов.');
     await notify(db,null,id,message,key);
    }
   }
  }catch(e){
   await db.query('ROLLBACK TO SAVEPOINT process_task');
   taskIds.length=0;
   error=e instanceof AppError?e.message:'Не удалось выполнить действия процесса.';
  }
  await db.query('RELEASE SAVEPOINT process_task');
 }
 const trace=context.subject?[{nodeId:'subject',label:context.subject.name},...plan.trace]:plan.trace;
 await db.query('INSERT INTO business_runs(process_id,event_id,branch,task_id,error,process_revision,trace) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [row.id,eventId,plan.branch,taskIds[0]??null,error,row.published_revision,JSON.stringify(trace)]);
 for(const taskId of taskIds)await db.query('INSERT INTO business_run_tasks(process_id,event_id,task_id) VALUES($1,$2,$3)',[row.id,eventId,taskId]);
 return !error;
}
async function runMonitor(db:Db,row:ProcessRow&{monitor_next_at:string|null},definition:Definition,now:Date){
 if(row.monitor_next_at&&Date.parse(row.monitor_next_at)>now.getTime())return;
 const actor=(await db.query<User>('SELECT * FROM users WHERE id=$1',[row.actor_id])).rows[0];
 requireOkbAccess(actor);
 const tasks=await visibleTasks(actor,db);
 const grouped=new Map<string,Task[]>();
 for(const task of tasks){
  if(definition.companyId&&task.company_id!==definition.companyId)continue;
  const group=grouped.get(task.assignee_id);
  if(group)group.push(task);else grouped.set(task.assignee_id,[task]);
 }
 const subjects=await processSubjects(definition,db);
 const states=(await db.query<{subject_id:string;active_nodes:string[]}>('SELECT subject_id,active_nodes FROM business_monitor_states WHERE process_id=$1',[row.id])).rows;
 for(const subject of subjects){
  const scope=grouped.get(subject.id)??[];
  const measured=measurement(definition,scope,now),context={subject};
  const plan=processPlan(definition,context,measured.values),active=plan.actions.map(action=>action.id);
  const previous=states.find(state=>state.subject_id===subject.id);
  const pending=plan.actions.filter(action=>!previous?.active_nodes.includes(action.id));
  const changed=!previous||previous.active_nodes.some(id=>!active.includes(id))||pending.length>0;
  if(!changed)continue;
  const ok=await executeProcess(db,row,definition,randomUUID(),context,now,{plan:{...plan,actions:pending},matched:measured.matched});
  if(ok)await db.query(`INSERT INTO business_monitor_states(process_id,subject_id,active_nodes) VALUES($1,$2,$3)
   ON CONFLICT(process_id,subject_id) DO UPDATE SET active_nodes=excluded.active_nodes`,[row.id,subject.id,active]);
 }
 await db.query('UPDATE business_processes SET monitor_next_at=$2 WHERE id=$1',[row.id,new Date(now.getTime()+definition.monitor!.everyMinutes*60000).toISOString()]);
}
async function runProcess(id:string,now:Date){
 await transaction(async db=>{
  const row=(await db.query('SELECT * FROM business_processes WHERE id=$1 AND enabled FOR UPDATE SKIP LOCKED',[id])).rows[0];
  if(!row)return;
  const published=(await db.query('SELECT definition FROM business_versions WHERE process_id=$1 AND revision=$2',[row.id,row.published_revision])).rows[0];
  if(!published)return;
  const definition=processInput.parse(published.definition);
  if(definition.trigger==='monitor')await runMonitor(db,row,definition,now);
  else if(definition.trigger==='company_status'){
   if(!okbConfigured())return;
   const events=(await okbPool().query('SELECT id,event_id,snapshot FROM company_status_events WHERE id>$1 AND ($2::timestamptz IS NULL OR occurred_at>=$2) ORDER BY id LIMIT 5',[row.event_cursor,row.enabled_since])).rows;
   for(const item of events){
    if(!definition.companyId||definition.companyId===item.snapshot.id)await executeProcess(db,row,definition,item.event_id,{company:item.snapshot},now);
    await db.query('UPDATE business_processes SET event_cursor=$2 WHERE id=$1',[row.id,item.id]);
   }
  }else if(definition.trigger==='task_accepted'){
   const events=(await db.query(`SELECT s.event_id,s.task_id FROM task_acceptance_events s JOIN tasks t ON t.id=s.task_id
    WHERE s.occurred_at>=$2 AND s.available_at<=$3 AND t.status='completed' AND ($4::uuid IS NULL OR t.company_id=$4)
    AND NOT EXISTS(SELECT 1 FROM business_runs r WHERE r.process_id=$1 AND r.event_id=s.event_id)
    AND NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=s.event_id)
    AND NOT EXISTS(SELECT 1 FROM undo_actions a WHERE a.task_id=t.id AND a.undone_at IS NULL
      AND a.created_at>=($3::timestamptz-interval '5 minutes') AND a.after_state->'task'->>'version'=t.version::text)
    ORDER BY s.occurred_at,s.event_id LIMIT 5 FOR SHARE OF t`,[row.id,row.enabled_since,now.toISOString(),definition.companyId??null])).rows;
   const actor=(await db.query<User>('SELECT * FROM users WHERE id=$1',[row.actor_id])).rows[0];
   if(!globalAccess(actor)){await db.query('UPDATE business_processes SET enabled=false WHERE id=$1',[id]);return;}
   for(const item of events){
    const t=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[item.task_id])).rows[0];
    if(!canSee(actor,t)){
     await db.query("INSERT INTO business_runs(process_id,event_id,branch) VALUES($1,$2,'no')",[row.id,item.event_id]);
     continue;
    }
    const company=t.company_id?await getCompany(actor,t.company_id):undefined;
    await executeProcess(db,row,definition,item.event_id,{company,task:{title:t.title,assigneeId:t.assignee_id}},now);
   }
  }else{
   if(!okbConfigured())return;
   const companies=(await okbPool().query(`SELECT id,name,status,coalesce(last_contact_at,created_at) AS quiet_since FROM companies
    WHERE status='active' AND ($1::uuid IS NULL OR id>$1) AND ($2::uuid IS NULL OR id=$2)
    AND coalesce(last_contact_at,created_at)+make_interval(days=>$3::int) BETWEEN $4 AND $5
    ORDER BY id LIMIT 10`,[row.quiet_cursor,definition.companyId??null,definition.quietDays,row.enabled_since,now.toISOString()])).rows;
   for(const company of companies){
    const claimed=await db.query(`INSERT INTO business_quiet_runs(process_id,company_id,quiet_since) VALUES($1,$2,$3)
     ON CONFLICT DO NOTHING`,[row.id,company.id,company.quiet_since]);
    if(claimed.rowCount)await executeProcess(db,row,definition,randomUUID(),{company},now);
   }
   await db.query('UPDATE business_processes SET quiet_cursor=$2 WHERE id=$1',[row.id,companies.length===10?companies.at(-1).id:null]);
  }
  await db.query('UPDATE business_processes SET last_polled_at=clock_timestamp() WHERE id=$1',[id]);
 });
}
export async function runProcesses(now=new Date()){
 const processes=(await pool.query('SELECT id FROM business_processes WHERE enabled AND (monitor_next_at IS NULL OR monitor_next_at<=$1) ORDER BY last_polled_at NULLS FIRST,id LIMIT 8',[now.toISOString()])).rows;
 for(const {id} of processes){
  try{await runProcess(id,now);}
  catch{
   await pool.query('UPDATE business_processes SET last_polled_at=clock_timestamp() WHERE id=$1',[id]);
   console.error('Business process polling failed');
  }
 }
}
export function startWorkDesign(){
 let running=false;
 const tick=async()=>{
  if(running)return;
  running=true;
  try{
   await runSchedules().catch(()=>console.error('Task schedule tick failed'));
   await runProcesses().catch(()=>console.error('Business process tick failed'));
  }finally{running=false;}
 };
 void tick();
 const timer=setInterval(()=>void tick(),30000);timer.unref();
 return ()=>clearInterval(timer);
}
