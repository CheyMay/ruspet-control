import {carryApprovalBatch} from './approval-updates.js';
import {lockDelegationChain} from './delegation-lock.js';
import {undoDelegatedSource} from './delegation-review.js';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {actionState,sameState,spawnedTasks,type ActionState} from './undo-record.js';
import {assert,canSee} from './domain.js';
import {event,notify,notifyTaskAssignment,refreshTaskFindings} from './service.js';
import {MockTaskProvider} from './providers.js';
import {canRestoreLinkedFields} from './bitrix-live.js';
import {completionApprovalRoute} from '../shared/actions.js';
import type {User,Task} from '../shared/types.js';
import {businessDay} from '../shared/queues.js';

const ownWindowMs=5*60*1000;
const changedSince='После этого действия задача или правила изменились.';
const bitrixNeedsReview='Изменение уже отправлялось в Битрикс24 и требует отдельной сверки.';
const syncNeedsReview='Изменение уже передавалось внешнему обработчику и требует отдельной сверки.';
const supportsUndo=()=>!process.env.TASK_PROVIDER||process.env.TASK_PROVIDER==='mock';
const ensureStaffUndo=(u:User)=>assert(u.role==='admin'&&u.staff_undo_access===true,403,'Отмена действий сотрудников недоступна по вашей роли.');
type UndoRow={id:string;task_id:string;actor_id:string;label:string;created_at:string;undone_at:string|null;
 supported:boolean;before_state:ActionState;after_state:ActionState};

async function syncUndoPlan(db:Db,taskId:string,before:ActionState,after:ActionState,originalIds:string[],lock=false){
 const cancelIds:string[]=[],verifiedVersions:number[]=[];
 if(await spawnedTasks(db,originalIds))return {cancelIds,problem:'После этого действия автоматизация уже создала новые задачи.'};
 const operations=(await db.query(`SELECT event_id,state,phase,attempts,payload FROM bitrix_operations
  WHERE event_id=ANY($1::uuid[]) ORDER BY sequence${lock?' FOR UPDATE':''}`,[originalIds])).rows;
 for(const op of operations){
  if(op.state==='canceled')continue;
  if(['pending','failed','blocked'].includes(op.state)&&(op.attempts===0||op.attempts===1&&op.phase==='reading')){
   cancelIds.push(op.event_id);
   continue;
  }
  // Reconcile verified writes by queuing an inverse change. A sent comment or an
  // operation with unknown outcome has no safe inverse through this workflow.
  const version=op.payload.data?.after?.version;
  const cfg=op.state==='sent'&&op.phase==='done'&&op.payload.kind!=='comment'&&version===after.task.version&&
   (await db.query(`SELECT c.* FROM bitrix_live_config c JOIN bitrix_task_links l ON l.task_id=$1 WHERE c.id=1`,[taskId])).rows[0];
  if(!cfg||!canRestoreLinkedFields(before.task,after.task,cfg))return {cancelIds,problem:bitrixNeedsReview};
  verifiedVersions.push(version);
 }
 const legacy=(await db.query(`SELECT 1 FROM task_sync_queue WHERE task_id=$1 AND task_version>$2
  AND (state='sent' OR attempts>0) AND NOT (state='sent' AND task_version=ANY($3::int[])) LIMIT 1`,
 [taskId,before.task.version,verifiedVersions])).rowCount;
 return {cancelIds,problem:legacy?syncNeedsReview:null};
}

function addedEvents(before:ActionState,after:ActionState):string[]{
 const previous=new Set(before.events.map(e=>e.id));
 return after.events.filter(e=>!previous.has(e.id)).map(e=>e.id);
}

export async function lastUndo(u:User,taskId?:string,db:Db=pool){
 const row=(await db.query(`SELECT id,task_id,label,created_at,undone_at,supported,
  (after_state->'task'->>'version')::int expected_version,jsonb_array_length(after_state->'events') event_count
  FROM undo_actions WHERE actor_id=$1 AND ($2::text IS NULL OR task_id=$2) ORDER BY created_at DESC,id DESC LIMIT 1`,[u.id,taskId??null])).rows[0];
 if(!row||!row.supported||row.undone_at)return null;
 const expires=Date.parse(row.created_at)+ownWindowMs;
 if(expires<=Date.now())return null;
 const task=(await db.query('SELECT t.*,(SELECT count(*)::int FROM task_events e WHERE e.task_id=t.id) event_count FROM tasks t WHERE id=$1',[row.task_id])).rows[0];if(!task||!canSee(u,task)||task.version!==row.expected_version||task.event_count!==row.event_count)return null;
 return {id:row.id,task_id:row.task_id,label:row.label,created_at:row.created_at,expiresAt:new Date(expires).toISOString(),remainingMs:Math.max(0,expires-Date.now())};
}

export async function staffUndoHistory(u:User,taskId:string,db:Db=pool){
 ensureStaffUndo(u);
 const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
 assert(task&&canSee(u,task),404,'Задача недоступна.');
 const now=new Date(Date.now());
 const {rows}=await db.query<UndoRow&{author:string;undone_by_name:string|null;undo_reason:string|null}>(`SELECT h.*,
  actor.name author,admin.name undone_by_name FROM undo_actions h JOIN users actor ON actor.id=h.actor_id
  LEFT JOIN users admin ON admin.id=h.undone_by
  WHERE h.task_id=$1 AND h.created_at >= $2::timestamptz AND h.created_at<=$3
  ORDER BY h.created_at DESC,h.id DESC`,[taskId,businessDay(now)+'T00:00:00+03:00',now]);
 const live=rows[0]?.supported&&!rows[0].undone_at?await actionState(db,taskId):null;
 const items=[];
 for(const [index,row] of rows.entries()){
  let problem:string|null=null;
  if(row.undone_at)problem='Действие уже отменено.';
  else if(!row.supported||!supportsUndo())problem='Для этого действия автоматическая отмена недоступна.';
  else if(index!==0||!live||!sameState(live,row.after_state))problem=changedSince;
  else problem=(await syncUndoPlan(db,taskId,row.before_state,row.after_state,addedEvents(row.before_state,row.after_state))).problem;
  items.push({id:row.id,label:row.label,author:row.author,createdAt:row.created_at,undoneAt:row.undone_at,
   undoneBy:row.undone_by_name,reason:row.undo_reason,problem});
 }
 return items;
}

export async function undoLastAction(u:User,id:string){return undoAction(u,id);}
export async function undoStaffAction(u:User,id:string,reason:string){
 ensureStaffUndo(u);
 const note=reason.trim();
 assert(note.length>=5&&note.length<=1000,400,'Укажите причину отмены от 5 до 1000 символов.');
 return undoAction(u,id,note);
}

async function undoAction(u:User,id:string,reason?:string){return transaction(async db=>{
 const isStaff=reason!==undefined;
 const lookup=(await db.query('SELECT task_id FROM undo_actions WHERE id=$1 AND ($2::text IS NULL OR actor_id=$2)',[id,isStaff?null:u.id])).rows[0];assert(lookup,404,'Действие не найдено.');
 await lockDelegationChain(db,lookup.task_id);
 const current=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[lookup.task_id])).rows[0] as Task;assert(current&&canSee(u,current),404,'Задача недоступна.');
 const row=(await db.query<UndoRow>('SELECT * FROM undo_actions WHERE id=$1 FOR UPDATE',[id])).rows[0];
 const latest=(await db.query(`SELECT id FROM undo_actions WHERE task_id=$1 AND ($2::text IS NULL OR actor_id=$2)
  ORDER BY created_at DESC,id DESC LIMIT 1`,[current.id,isStaff?null:u.id])).rows[0];
 assert(row.supported&&latest?.id===id&&!row.undone_at,409,'Можно отменить только последнее действие, один раз.');
 assert(supportsUndo(),409,'Отмена внешних изменений пока не поддерживается.');
 const before=row.before_state as ActionState,after=row.after_state as ActionState,live=await actionState(db,current.id);
 assert(canSee(u,before.task),403,'Прежнее состояние задачи больше недоступно по вашей роли.');
 await db.query('SELECT pg_advisory_xact_lock(431011)');
 if(before.task.parent_id){
  const parent=(await db.query('SELECT * FROM tasks WHERE id=$1',[before.task.parent_id])).rows[0];assert(parent&&canSee(u,parent),409,'Прежняя родительская задача недоступна.');
  const chain=(await db.query('WITH RECURSIVE tree AS (SELECT id,parent_id,ARRAY[id] path FROM tasks WHERE id=$1 UNION ALL SELECT t.id,t.parent_id,tree.path||t.id FROM tasks t JOIN tree ON t.id=tree.parent_id WHERE NOT(t.id=ANY(tree.path))) SELECT id FROM tree',[before.task.parent_id])).rows;
  assert(!chain.some(t=>t.id===current.id),409,'Отмена создаст цикл в иерархии задач. Требуется отдельное исправление.');
 }
 const now=Date.now(),createdAt=Date.parse(row.created_at);
 assert(isStaff?createdAt<=now&&businessDay(row.created_at)===businessDay(new Date(now)):now-createdAt<ownWindowMs,
  409,isStaff?'Можно отменять действия только за текущий день по Москве.':'Пять минут на отмену истекли.');
 assert(sameState(live,after),409,changedSince);
 const originalIds=addedEvents(before,after);
 const {cancelIds,problem}=await syncUndoPlan(db,current.id,before,after,originalIds,true);
 if(problem)assert(false,409,problem);
 await db.query("UPDATE bitrix_operations SET state='canceled' WHERE event_id=ANY($1::uuid[])",[cancelIds]);
 if(before.task.status!==after.task.status&&after.task.status==='completed')await undoDelegatedSource(db,current,id,u);
 // Resolve newly opened records before restoring the original active route/control.
 const beforeApprovals=new Set(before.approvals.map(a=>a.id));
 for(const a of after.approvals)if(!beforeApprovals.has(a.id))await db.query("UPDATE approvals SET state='stale',canceled_at=now(),deferred_until=NULL WHERE id=$1",[a.id]);
 const mutableApproval=['state','current_step','deferred_until','clarification_question','clarification_answer','clarification_requested_at','clarification_answered_at','canceled_at','route','task_change','approved_deadline','branch_review_user_id'];
 for(const entry of before.approvals){
  const active=entry.state==='pending'&&entry.task_version===before.task.version;
  let a=entry;
  if(active&&entry.type==='completion'){
   const route=completionApprovalRoute({...before.task,creator_id:current.creator_id});
   if(!route.length)a={...entry,state:'stale',canceled_at:new Date(now).toISOString(),deferred_until:null};
   else if(entry.current_step!==0||!isDeepStrictEqual(entry.route,route))a={...entry,route,current_step:0,deferred_until:null,
    task_change:entry.task_change?{...entry.task_change,routeIssue:false}:null};
  }
  const values=mutableApproval.map(k=>a[k]==null?null:['route','task_change'].includes(k)?JSON.stringify(a[k]):a[k]);
  const {rows:[next]}=await db.query(`UPDATE approvals SET ${mutableApproval.map((k,i)=>`${k}=$${i+2}`).join(',')},
   action_revision=action_revision+1,task_version=$${mutableApproval.length+2} WHERE id=$1 RETURNING action_revision`,
   [a.id,...values,active?current.version+1:a.task_version]);
  if(active&&a.type==='deadline')await carryApprovalBatch(db,a.id,a.current_step,a.action_revision,next.action_revision);
 }
 const oldDecisions=new Set(before.decisions.map(d=>d.id));for(const d of after.decisions)if(!oldDecisions.has(d.id))await db.query('INSERT INTO decision_retractions(decision_id,undo_id) VALUES($1,$2)',[d.id,id]);
 // Keep the original submission and its outcome. A restored review is a new,
 // explicitly linked projection, not a rewritten acceptance/return record.
 for(const s of after.submissions){const old=before.submissions.find(x=>x.id===s.id);if(!old||!isDeepStrictEqual(old,s))await db.query('UPDATE task_submissions SET withdrawn_at=now() WHERE id=$1',[s.id]);}
 for(const s of before.submissions){const actual=after.submissions.find(x=>x.id===s.id);if(s.state==='review'&&(!actual||!isDeepStrictEqual(s,actual)))await db.query("INSERT INTO task_submissions(id,task_id,round,result,author_id,state,restored_from,automatic,based_on_tasks) SELECT $1,$2,coalesce(max(round),0)+1,$3,$4,'review',$5,$6,$7 FROM task_submissions WHERE task_id=$2",[randomUUID(),current.id,s.result,s.author_id,s.id,s.automatic??false,s.based_on_tasks??[]]);}
 const oldControls=new Set(before.controls.map(c=>c.id));for(const c of after.controls)if(!oldControls.has(c.id))await db.query("UPDATE control_requests SET state='resolved' WHERE id=$1",[c.id]);
 for(const c of before.controls)await db.query('UPDATE control_requests SET state=$2,reason=$3,progress=$4,plan=$5,due_at=$6,reminders=$7 WHERE id=$1',[c.id,c.state,c.reason,c.progress,c.plan,c.due_at,c.reminders]);
 const oldComments=new Set(before.comments.map(c=>c.id));for(const c of after.comments)if(!oldComments.has(c.id))await db.query('UPDATE comments SET withdrawn_at=now() WHERE id=$1',[c.id]);
 for(const eventId of originalIds)await db.query('INSERT INTO event_retractions(event_id,undo_id) VALUES($1,$2)',[eventId,id]);
 const oldOutbox=new Set(before.outbox.map(n=>n.id)),withdrawn=after.outbox.filter(n=>!oldOutbox.has(n.id)).map(n=>n.id);
 const recipients=(await db.query('UPDATE outbox SET withdrawn_at=now() WHERE id=ANY($1::uuid[]) RETURNING recipient_id',[withdrawn])).rows;
 const fields=['title','description','assignee_id','branch_id','deadline','planned_start','planned_end','status','priority','code','important','customer_risk','transfer_count','completed_at','parent_id','price','custom_fields','company_id','critical','result_required'];
 const restored=(await db.query(`UPDATE tasks SET ${fields.map((k,i)=>`${k}=$${i+2}`).join(',')},version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[current.id,...fields.map(k=>k==='custom_fields'?JSON.stringify(before.task.custom_fields??[]):before.task[k as keyof Task]??(k==='result_required'?true:k==='critical'?false:null))])).rows[0];
 await new MockTaskProvider().applyApprovedChange(db,restored,current.version);
 await db.query("UPDATE task_sync_queue SET state='canceled' WHERE task_id=$1 AND task_version>$2 AND state IN ('pending','failed')",[current.id,before.task.version]);
 await refreshTaskFindings(db,restored,u);
 await event(db,current.id,u.id,'action_undone',`Отменено действие: ${row.label}`,{undoId:id,before:current,after:restored,originalEvents:originalIds,
  originalActorId:row.actor_id,...(isStaff?{staffUndo:true,reason}:{})});
 if(restored.status==='active'&&restored.assignee_id!==current.assignee_id)
  await notifyTaskAssignment(db,restored,null,'Вам вернули задачу');
 // Also notify the task participants even if no original notification was generated.
 for(const recipient of new Set([...recipients.map(r=>r.recipient_id),current.assignee_id,current.creator_id,row.actor_id]))if(recipient!==u.id)await notify(db,current.id,recipient,`По задаче #${current.id} действие «${row.label}» отменено (${u.name}). Проверьте актуальное состояние задачи.`,`undo:${id}:${recipient}`);
 await db.query("UPDATE bot_buttons SET revoked=true WHERE payload->>'id'=$1 AND receipt IS NULL",[current.id]);
 await db.query("DELETE FROM bot_sessions WHERE data->'payload'->>'id'=$1",[current.id]);
 await db.query('UPDATE undo_actions SET undone_at=clock_timestamp(),undone_by=$2,undo_reason=$3 WHERE id=$1',[id,u.id,reason??null]);return {taskId:current.id};
});}
