import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool,transaction,type Db} from './db.js';
import {assert,AppError,canSee,globalAccess} from './domain.js';
import {createTask,validateTaskAssignment} from './workflow.js';
import {notify} from './service.js';
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
 name:z.string().trim().min(3).max(120),
 trigger:z.enum(['company_status','task_accepted','company_quiet']).default('company_status'),
 companyId:z.uuid().nullable().optional(),quietDays:z.number().int().min(1).max(365).optional(),
 field:z.enum(['company.name','company.status','company.previousStatus','task.title','task.assigneeId']),
 operator:z.enum(['=','!=','contains','exists']),
 value:z.string().trim().max(250),
 branch:z.enum(['yes','no']),
 title:z.string().trim().min(3).max(500),assigneeId:z.string().trim().min(1).max(100),
 description:z.string().trim().max(10000).optional(),customFields:customFieldsInput.optional(),
 price:z.number().min(0).max(999999999999.99),deadlineHours
}).refine(input=>input.operator==='exists'||input.value.length>0,'Укажите значение условия.')
 .refine(input=>input.trigger!=='company_quiet'||!!input.quietDays,'Укажите срок без контакта.')
 .refine(input=>input.trigger==='task_accepted'||!input.field.startsWith('task.'),'Поле задачи доступно для события приёмки.');
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
function processTask(value:Definition,context:Record<string,unknown>,at:Date){
 return withDue(taskInput.parse({title:renderTemplate(value.title,context),description:value.description||'Создана бизнес-процессом «'+value.name+'».',customFields:value.customFields,
  companyId:z.uuid().safeParse((context.company as {id?:string}|undefined)?.id).data,assigneeId:value.assigneeId,price:value.price,deadline:null,plannedStart:null,plannedEnd:null,parentId:null,important:null,customerRisk:null}),at,value.deadlineHours);
}
export function previewProcess(actor:User,body:unknown){
 requireOkbAccess(actor);
 const {definition,sample,task}=z.object({definition:processInput,sample:companySample,task:z.object({title:z.string().max(500),assigneeId:z.string().max(100)}).optional()}).parse(body);
 const context={company:sample,task},branch=chooseBranch(definition,context);
 return {branch,title:branch===definition.branch?processTask(definition,context,new Date()).title:null};
}
export async function saveProcess(actor:User,body:unknown,existingId?:string){
 requireOkbAccess(actor);
 const value=processInput.parse(body);
 if(value.companyId)await getCompany(actor,value.companyId);
 const sample={company:{name:'Компания',status:'active',previousStatus:'prospect'},task:{title:'Исходная задача'}};
 return transaction(async db=>{
  await validateTaskAssignment(db,actor,processTask(value,sample,new Date()));
  const id=existingId??randomUUID();
  if(existingId){
   const updated=await db.query('UPDATE business_processes SET name=$2,definition=$3,revision=revision+1 WHERE id=$1 AND NOT enabled',[id,value.name,JSON.stringify(value)]);
   assert(updated.rowCount,409,'Остановите процесс перед изменением.');
   return {id};
  }
  await db.query('INSERT INTO business_processes(id,actor_id,name,definition) VALUES($1,$2,$3,$4)',[id,actor.id,value.name,JSON.stringify(value)]);
  return {id};
 });
}
export async function listProcesses(actor:User){
 requireOkbAccess(actor);
 const items=(await pool.query('SELECT id,actor_id,name,definition,enabled,enabled_since,revision FROM business_processes ORDER BY created_at DESC LIMIT 100')).rows;
 const runs=(await pool.query('SELECT process_id,branch,task_id,error,created_at FROM business_runs ORDER BY created_at DESC LIMIT 30')).rows;
 return {items,runs};
}
export async function toggleProcess(actor:User,id:string,enabled:boolean,expectedRevision?:number){
 requireOkbAccess(actor);
 const cursor=enabled?(await okbPool().query('SELECT coalesce(max(id),0) cursor FROM company_status_events')).rows[0].cursor:null;
 const changed=await pool.query('UPDATE business_processes SET enabled=$2,revision=revision+1,enabled_since=CASE WHEN $2 AND NOT enabled THEN clock_timestamp() ELSE enabled_since END,quiet_cursor=CASE WHEN $2 AND NOT enabled THEN NULL ELSE quiet_cursor END,event_cursor=CASE WHEN $2 AND NOT enabled THEN $3 ELSE event_cursor END WHERE id=$1 AND ($4::int IS NULL OR revision=$4)',
  [id,enabled,cursor,expectedRevision??null]);
 assert(changed.rowCount,expectedRevision===undefined?404:409,expectedRevision===undefined?'Процесс не найден.':'Процесс изменился. Обновите список и подтвердите ещё раз.');
}
type RunContext={company?:{id?:string;name:string;status:string;previousStatus?:string|null};task?:{title:string;assigneeId:string}};
async function executeProcess(db:Db,row:{id:string;actor_id:string},definition:Definition,eventId:string,context:RunContext,now:Date){
 const branch=chooseBranch(definition,context);
 let taskId:string|null=null,error:string|null=null;
 if(branch===definition.branch){
  await db.query('SAVEPOINT process_task');
  try{
   const actor=(await db.query<User>('SELECT * FROM users WHERE id=$1',[row.actor_id])).rows[0];
   requireOkbAccess(actor);
   taskId=await makeTask(db,actor,processTask(definition,context,now),'process:'+row.id+':'+eventId);
  }catch(e){
   await db.query('ROLLBACK TO SAVEPOINT process_task');
   error=e instanceof AppError?e.message:'Не удалось создать задачу для события.';
  }
  await db.query('RELEASE SAVEPOINT process_task');
 }
 await db.query('INSERT INTO business_runs(process_id,event_id,branch,task_id,error) VALUES($1,$2,$3,$4,$5)',[row.id,eventId,branch,taskId,error]);
}
async function runProcess(id:string,now:Date){
 await transaction(async db=>{
  const row=(await db.query('SELECT * FROM business_processes WHERE id=$1 AND enabled FOR UPDATE SKIP LOCKED',[id])).rows[0];
  if(!row)return;
  const definition=processInput.parse(row.definition);
  if(definition.trigger==='company_status'){
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
 if(!okbConfigured())return;
 const processes=(await pool.query('SELECT id FROM business_processes WHERE enabled ORDER BY last_polled_at NULLS FIRST,id LIMIT 8')).rows;
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
