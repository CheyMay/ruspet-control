import {randomUUID} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {assert} from './domain.js';
import {approvalHierarchy} from './approval-hierarchy.js';
import {controlsTask,staffWorkIds} from './staff-rollout.js';
import {teamMemberIds} from './org.js';
import {event,visibleTasks} from './service.js';
import {businessDay,taskQueue} from '../shared/queues.js';
import {branchCovers,canApproveBranch,unassignedBranch} from '../shared/branches.js';
import {workKinds} from '../shared/report-summary.js';
import type {ManagementNotice,Task,User} from '../shared/types.js';

export async function managementNotice(db:Db,recipient:string,body:string,key:string,details:ManagementNotice,now=new Date()){
 await db.query(`INSERT INTO outbox(id,recipient_id,body,dedupe_key,management_notice,created_at)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING`,[randomUUID(),recipient,body,key,JSON.stringify(details),now.toISOString()]);
}

const ready=`a.state='pending' AND a.canceled_at IS NULL AND a.route->a.current_step->>'userId'=$1
 AND (a.task_change->>'routeIssue') IS DISTINCT FROM 'true'
 AND (a.clarification_requested_at IS NULL OR a.clarification_answered_at IS NOT NULL)
 AND (a.deferred_until IS NULL OR a.deferred_until<=now()) AND a.task_version=t.version
 AND NOT EXISTS(SELECT 1 FROM director_approval_batch_items i WHERE i.approval_id=a.id
  AND i.step=a.current_step AND i.revision=a.action_revision)`;

type BatchCandidate={id:string;current_step:number;action_revision:number;task_id:string};
export async function remindAboutApprovalBatch(day:string){
 await transaction(async db=>{
  const hierarchy=await approvalHierarchy(db);
  if(!hierarchy)return;
  const {count}=(await db.query<{count:number}>(`SELECT count(*)::int AS count
   FROM approvals a JOIN tasks t ON t.id=a.task_id WHERE ${ready}`,[hierarchy.sales_head_id])).rows[0];
  if(!count)return;
  const recipients=(await db.query<{id:string}>(`SELECT u.id FROM users u WHERE u.role='admin' AND
   EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)`)).rows;
  for(const {id} of recipients)await managementNotice(db,id,`Пакет согласований к 15:00 МСК · ${count} запросов. Откройте согласования и отправьте пакет руководителю.`,
   'approval-batch-ready:'+day+':'+id,{kind:'approval-batch-ready'});
 });
}
export async function directorBatchStatus(actor:User){
 assert(actor.role==='admin',403,'Отправка пакетов доступна администратору.');
 const hierarchy=await approvalHierarchy(pool);
 if(!hierarchy)return null;
 const day=businessDay(new Date())+'T00:00:00+03:00';
 const head=(await pool.query<{name:string;linked:boolean}>(`SELECT u.name,EXISTS(SELECT 1 FROM telegram_binding b WHERE b.user_id=u.id) AS linked
  FROM users u WHERE u.id=$1`,[hierarchy.sales_head_id])).rows[0];
 const rows=(await pool.query(`WITH work AS (
   SELECT e.actor_id, count(DISTINCT e.task_id)::int n FROM task_events e
   WHERE e.kind=ANY($2) AND e.created_at >= $3 AND NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id)
   GROUP BY e.actor_id
  ), approvals_by_employee AS (
   SELECT t.assignee_id,
    count(*) FILTER(WHERE a.state='pending' AND a.route->a.current_step->>'label' IN ('Руководитель филиала','Постановщик')
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.route) step WHERE step->>'userId'=$1))::int AS waiting,
    count(*) FILTER(WHERE ${ready})::int AS ready,
    count(*) FILTER(WHERE EXISTS(SELECT 1 FROM decisions d WHERE d.approval_id=a.id AND a.route->d.step_index->>'label' IN ('Руководитель филиала','Постановщик')
     AND d.decision='approve' AND d.created_at >= $3
     AND NOT EXISTS(SELECT 1 FROM decision_retractions r WHERE r.decision_id=d.id)))::int AS approved
   FROM approvals a JOIN tasks t ON t.id=a.task_id GROUP BY t.assignee_id
  ) SELECT u.id,u.name,coalesce(w.n,0)::int AS processed,coalesce(a.waiting,0)::int AS waiting,
   coalesce(a.approved,0)::int AS approved,coalesce(a.ready,0)::int AS ready
  FROM users u LEFT JOIN work w ON w.actor_id=u.id LEFT JOIN approvals_by_employee a ON a.assignee_id=u.id
  WHERE ($4::text[] IS NULL OR u.id=ANY($4) OR a.waiting+a.ready+a.approved>0)
   AND (w.n>0 OR (a.waiting+a.ready+a.approved)>0) ORDER BY u.name`,
  [hierarchy.sales_head_id,[...workKinds],day,await staffWorkIds(pool)])).rows;
 const last=(await pool.query(`SELECT b.created_at,d.state FROM director_approval_batches b
  LEFT JOIN outbox o ON o.dedupe_key='director-batch:'||b.id::text
  LEFT JOIN telegram_delivery d ON d.outbox_ids ? o.id::text
  WHERE b.recipient_id=$1 ORDER BY b.created_at DESC LIMIT 1`,[hierarchy.sales_head_id])).rows[0]??null;
 return {head,rows,total:rows.reduce((n,row)=>n+row.ready,0),last};
}

export async function sendDirectorBatch(actor:User){
 assert(actor.role==='admin',403,'Отправка пакетов доступна администратору.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const hierarchy=await approvalHierarchy(db);
  assert(hierarchy,409,'Сначала настройте руководителя продаж в маршруте согласований.');
  const recipient=hierarchy.sales_head_id;
  const candidates=(await db.query<BatchCandidate>(`SELECT a.id,a.current_step,a.action_revision,a.task_id FROM approvals a
   JOIN tasks t ON t.id=a.task_id WHERE ${ready} ORDER BY a.created_at,a.id FOR UPDATE OF a`,[recipient])).rows;
  assert(candidates.length,409,'Нет новых согласований для отправки.');
  const id=randomUUID();
  await db.query('INSERT INTO director_approval_batches(id,recipient_id,created_by) VALUES($1,$2,$3)',[id,recipient,actor.id]);
  await db.query(`INSERT INTO director_approval_batch_items(batch_id,approval_id,step,revision)
   SELECT $1,id,current_step,action_revision FROM jsonb_to_recordset($2::jsonb)
   AS item(id uuid,current_step int,action_revision int)`,[id,JSON.stringify(candidates)]);
  await managementNotice(db,recipient,'На согласование передан пакет. Запросов: '+candidates.length+'.','director-batch:'+id,{kind:'director-approvals',batchId:id});
  await event(db,null,actor.id,'director_batch_sent','Передан пакет согласований руководителю продаж',{id,recipient,count:candidates.length});
  return {id,count:candidates.length};
 });
}

export async function directorBatchTasks(actor:User,id:string){
 const access=(await pool.query('SELECT 1 FROM director_approval_batches WHERE id=$1 AND recipient_id=$2',[id,actor.id])).rowCount;
 assert(access,404,'Пакет согласований недоступен.');
 return (await pool.query<Pick<BatchCandidate,'id'|'task_id'>>(`SELECT a.id,a.task_id FROM director_approval_batch_items i JOIN approvals a ON a.id=i.approval_id
  JOIN tasks t ON t.id=a.task_id
  WHERE i.batch_id=$1 AND a.state='pending' AND a.current_step=i.step AND a.action_revision=i.revision AND a.task_version=t.version
  AND a.route->a.current_step->>'userId'=$2 ORDER BY a.created_at,a.id`,[id,actor.id])).rows;
}

type Inactive={id:string;name:string;ids:string[]};
export async function reviewInactivity(day:string,now:Date){
 return transaction(async db=>{
  const hierarchy=await approvalHierarchy(db);
  if(!hierarchy)return;
  const managers=hierarchy.direct_assignee_ids?(await db.query<User>('SELECT * FROM users WHERE id=$1',[hierarchy.sales_head_id])).rows:
   (await db.query<User>("SELECT * FROM users WHERE role IN ('branch_manager','admin') AND (branch_id<>$1 OR (id=$2 AND company_branch_access)) ORDER BY id",
    [unassignedBranch,hierarchy.branch_manager_id])).rows.filter(canApproveBranch);
  const scope=await staffWorkIds(db);
  const combined=new Map<string,Inactive>();
  const byManager=new Map<string,Inactive[]>();
  for(const manager of managers){
   const inactive=await inactiveTeam(db,manager,day,now,scope,hierarchy.direct_assignee_ids!==null);
   byManager.set(manager.id,inactive);
   for(const person of inactive){
    const current=combined.get(person.id);
    combined.set(person.id,current?{...person,ids:[...new Set([...current.ids,...person.ids])]}:person);
   }
  }
  const snapshot=[...combined.values()].sort((a,b)=>b.ids.length-a.ids.length||a.name.localeCompare(b.name,'ru'));
  const saved=await db.query('INSERT INTO inactivity_reviews(day,details,captured_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
   [day,JSON.stringify(snapshot),now.toISOString()]);
  if(!saved.rowCount)return;
  for(const [id,inactive] of byManager)if(inactive.length)await managementNotice(db,id,
   'Просрочки без действий за день\nПроверьте задачи сотрудников:\n\n'+inactivityLines(inactive),
   'inactivity:'+day+':'+id,{kind:'inactivity'});
 });
}

async function inactiveTeam(db:Db,branch:User,day:string,now:Date,scope:string[]|null,central:boolean){
  const team=(central&&scope?scope:await teamMemberIds(branch,db)).filter(id=>id!==branch.id&&(!scope||scope.includes(id)));
  if(!team.length)return [];
  const teamIds=new Set(team);
  const tasks=(await visibleTasks(branch,db)).filter(task=>teamIds.has(task.assignee_id)&&controlsTask(task,null)&&(central||branch.company_branch_access||branchCovers(branch.branch_id,task.branch_id)));
  const people=(await db.query<User>("SELECT * FROM users WHERE id=ANY($1)",[team])).rows;
  const byId=new Map<string,Task>(tasks.map(task=>[task.id,task]));
  const actions=(await db.query<{actor_id:string;task_id:string;assignee:string|null}>(`SELECT e.actor_id,e.task_id,
   coalesce(e.data->'before'->>'assignee_id',e.data->'after'->>'assignee_id') AS assignee
   FROM task_events e WHERE e.created_at BETWEEN $1 AND $2 AND e.kind=ANY($3) AND e.task_id=ANY($4)
   AND NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id)`,
  [day+'T00:00:00+03:00',now.toISOString(),[...workKinds,'created','task_delegated'],tasks.map(task=>task.id)])).rows;
  const worked=new Set(actions.filter(e=>(e.assignee??byId.get(e.task_id)?.assignee_id)===e.actor_id).map(e=>e.actor_id));
  return people.filter(person=>!worked.has(person.id)).flatMap(person=>{
   const ids=tasks.filter(task=>task.assignee_id===person.id&&taskQueue(task,now)==='overdue').map(task=>task.id);
   return ids.length?[{id:person.id,name:person.name,ids}]:[];
  }).sort((a,b)=>b.ids.length-a.ids.length||a.name.localeCompare(b.name,'ru'));
}

function inactivityLines(rows:Inactive[]){
 const shown=rows.slice(0,15);
 return shown.map(row=>row.name+' · '+row.ids.length+' просроч. · '+row.ids.slice(0,3).map(id=>'#'+id).join(', ')).join('\n')+
  (rows.length>shown.length?'\nЕщё сотрудников: '+(rows.length-shown.length):'');
}

export async function morningManagementReport(day:string,reportId:string){
 await transaction(async db=>{
  const hierarchy=await approvalHierarchy(db);
  if(!hierarchy)return;
  const actor=(await db.query<User>('SELECT * FROM users WHERE id=$1',[hierarchy.sales_head_id])).rows[0];
  if(!actor||!['director','sales_head'].includes(actor.role))return;
  const previous=new Date(day+'T12:00:00+03:00');
  do{previous.setUTCDate(previous.getUTCDate()-1);}while([0,6].includes(previous.getUTCDay()));
  const previousDay=businessDay(previous);
  const saved=(await db.query<{details:Inactive[]}>('SELECT details FROM inactivity_reviews WHERE day=$1',[previousDay])).rows[0];
  const scope=await staffWorkIds(db);
  const previousIds=(saved?.details??[]).flatMap(person=>person.ids);
  const stillControlled=new Set((await db.query<{id:string}>('SELECT id FROM tasks WHERE id=ANY($1) AND creator_id<>assignee_id',[previousIds])).rows.map(task=>task.id));
  const rows=(saved?.details??[]).filter(person=>!scope||scope.includes(person.id))
   .map(person=>({...person,ids:person.ids.filter(id=>stillControlled.has(id))})).filter(person=>person.ids.length);
  const body='Утренний отчёт'+(rows.length?'\n\nБез действий при просрочках за '+previousDay.split('-').reverse().join('.')+':\n'+inactivityLines(rows):
   saved?'\n\nЗа прошлый рабочий день просрочек без действий не зафиксировано.':'\n\nЗа прошлый рабочий день нет снимка активности.');
  await managementNotice(db,actor.id,body,'management-morning:'+day+':'+actor.id,{kind:'morning-report',reportId});
 });
}
