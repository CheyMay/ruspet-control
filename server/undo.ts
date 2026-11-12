import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {actionState,sameState,type ActionState} from './undo-record.js';
import {assert,canSee} from './domain.js';
import {event,notify,refreshTaskFindings} from './service.js';
import {MockTaskProvider} from './providers.js';
import type {User,Task} from '../shared/types.js';

export async function lastUndo(u:User,taskId?:string,db:Db=pool){
 const row=(await db.query("SELECT id,task_id,label,created_at,undone_at,supported,(after_state->'task'->>'version')::int expected_version,jsonb_array_length(after_state->'events') event_count FROM undo_actions WHERE actor_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[u.id])).rows[0];
 if(!row||!row.supported||row.undone_at||taskId&&row.task_id!==taskId||Date.now()-Date.parse(row.created_at)>300000)return null;
 const task=(await db.query('SELECT t.*,(SELECT count(*)::int FROM task_events e WHERE e.task_id=t.id) event_count FROM tasks t WHERE id=$1',[row.task_id])).rows[0];if(!task||!canSee(u,task)||task.version!==row.expected_version||task.event_count!==row.event_count)return null;
 return {id:row.id,task_id:row.task_id,label:row.label,created_at:row.created_at,expiresAt:new Date(Date.parse(row.created_at)+300000).toISOString()};
}
export async function undoLastAction(u:User,id:string){return transaction(async db=>{
 const lookup=(await db.query('SELECT task_id FROM undo_actions WHERE id=$1 AND actor_id=$2',[id,u.id])).rows[0];assert(lookup,404,'Действие не найдено.');
 const current=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[lookup.task_id])).rows[0] as Task;assert(current&&canSee(u,current),404,'Задача недоступна.');
 const row=(await db.query('SELECT * FROM undo_actions WHERE id=$1 FOR UPDATE',[id])).rows[0];
 const latest=(await db.query('SELECT id FROM undo_actions WHERE actor_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[u.id])).rows[0];
 assert(row.supported&&latest?.id===id&&!row.undone_at,409,'Можно отменить только последнее действие, один раз.');
 assert(Date.now()-Date.parse(row.created_at)<=300000,409,'Пять минут на отмену истекли.');
 assert(!process.env.TASK_PROVIDER||process.env.TASK_PROVIDER==='mock',409,'Отмена внешних изменений пока не поддерживается.');
 const before=row.before_state as ActionState,after=row.after_state as ActionState,live=await actionState(db,current.id);
 assert(canSee(u,before.task),403,'Прежнее состояние задачи больше недоступно по вашей роли.');
 await db.query('SELECT pg_advisory_xact_lock(431011)');
 if(before.task.parent_id){
  const parent=(await db.query('SELECT * FROM tasks WHERE id=$1',[before.task.parent_id])).rows[0];assert(parent&&canSee(u,parent),409,'Прежняя родительская задача недоступна.');
  const chain=(await db.query('WITH RECURSIVE tree AS (SELECT id,parent_id,ARRAY[id] path FROM tasks WHERE id=$1 UNION ALL SELECT t.id,t.parent_id,tree.path||t.id FROM tasks t JOIN tree ON t.id=tree.parent_id WHERE NOT(t.id=ANY(tree.path))) SELECT id FROM tree',[before.task.parent_id])).rows;
  assert(!chain.some(t=>t.id===current.id),409,'Отмена создаст цикл в иерархии задач. Требуется отдельное исправление.');
 }
 assert(sameState(live,after),409,'По задаче уже были другие действия или изменились правила. Автоматическая отмена недоступна.');
 assert(!(await db.query("SELECT 1 FROM task_sync_queue WHERE task_id=$1 AND task_version>$2 AND (state='sent' OR attempts>0)",[current.id,before.task.version])).rowCount,409,'Изменение уже передавалось внешнему обработчику. Требуется отдельное исправление.');
 const newCommentIds=after.comments.filter(c=>!before.comments.some(old=>old.id===c.id)).map(c=>c.id);
 assert(!(await db.query("SELECT 1 FROM bitrix_comment_outbox WHERE comment_id=ANY($1) AND (attempts>0 OR state IN ('sending','uncertain'))",[newCommentIds])).rowCount,409,'Комментарий уже передавался в Битрикс24. Используйте удаление комментария.');
 // Resolve newly opened records before restoring the original active route/control.
 const beforeApprovals=new Set(before.approvals.map(a=>a.id));
 for(const a of after.approvals)if(!beforeApprovals.has(a.id))await db.query("UPDATE approvals SET state='stale',canceled_at=now(),deferred_until=NULL WHERE id=$1",[a.id]);
 const mutableApproval=['state','current_step','deferred_until','clarification_question','clarification_answer','clarification_requested_at','clarification_answered_at','canceled_at'];
 for(const a of before.approvals){await db.query(`UPDATE approvals SET ${mutableApproval.map((k,i)=>`${k}=$${i+2}`).join(',')},action_revision=action_revision+1,task_version=$${mutableApproval.length+2} WHERE id=$1`,[a.id,...mutableApproval.map(k=>a[k]??null),a.state==='pending'&&a.task_version===before.task.version?current.version+1:a.task_version]);}
 const oldDecisions=new Set(before.decisions.map(d=>d.id));for(const d of after.decisions)if(!oldDecisions.has(d.id))await db.query('INSERT INTO decision_retractions(decision_id,undo_id) VALUES($1,$2)',[d.id,id]);
 // Keep the original submission and its outcome. A restored review is a new,
 // explicitly linked projection, not a rewritten acceptance/return record.
 for(const s of after.submissions){const old=before.submissions.find(x=>x.id===s.id);if(!old||!isDeepStrictEqual(old,s))await db.query('UPDATE task_submissions SET withdrawn_at=now() WHERE id=$1',[s.id]);}
 for(const s of before.submissions){const actual=after.submissions.find(x=>x.id===s.id);if(s.state==='review'&&(!actual||!isDeepStrictEqual(s,actual)))await db.query("INSERT INTO task_submissions(id,task_id,round,result,author_id,state,restored_from) SELECT $1,$2,coalesce(max(round),0)+1,$3,$4,'review',$5 FROM task_submissions WHERE task_id=$2",[randomUUID(),current.id,s.result,s.author_id,s.id]);}
 const oldControls=new Set(before.controls.map(c=>c.id));for(const c of after.controls)if(!oldControls.has(c.id))await db.query("UPDATE control_requests SET state='resolved' WHERE id=$1",[c.id]);
 for(const c of before.controls)await db.query('UPDATE control_requests SET state=$2,reason=$3,progress=$4,plan=$5,due_at=$6,reminders=$7 WHERE id=$1',[c.id,c.state,c.reason,c.progress,c.plan,c.due_at,c.reminders]);
 const oldComments=new Set(before.comments.map(c=>c.id));for(const c of after.comments)if(!oldComments.has(c.id))await db.query('UPDATE comments SET withdrawn_at=now() WHERE id=$1',[c.id]);
 const oldEvents=new Set(before.events.map(e=>e.id));for(const e of after.events)if(!oldEvents.has(e.id))await db.query('INSERT INTO event_retractions(event_id,undo_id) VALUES($1,$2)',[e.id,id]);
 const oldOutbox=new Set(before.outbox.map(n=>n.id)),withdrawn=after.outbox.filter(n=>!oldOutbox.has(n.id)).map(n=>n.id);
 const recipients=(await db.query('UPDATE outbox SET withdrawn_at=now() WHERE id=ANY($1::uuid[]) RETURNING recipient_id',[withdrawn])).rows;
 const fields=['title','description','assignee_id','branch_id','deadline','planned_start','planned_end','status','priority','code','important','customer_risk','transfer_count','completed_at','parent_id','price','custom_fields','company_id'];
 const restored=(await db.query(`UPDATE tasks SET ${fields.map((k,i)=>`${k}=$${i+2}`).join(',')},version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[current.id,...fields.map(k=>k==='custom_fields'?JSON.stringify(before.task.custom_fields??[]):before.task[k as keyof Task]??null)])).rows[0];
 await new MockTaskProvider().applyApprovedChange(db,restored,current.version);
 await db.query("UPDATE task_sync_queue SET state='canceled' WHERE task_id=$1 AND task_version>$2 AND state IN ('pending','failed')",[current.id,before.task.version]);
 await refreshTaskFindings(db,restored,u);
 await event(db,current.id,u.id,'action_undone',`Отменено действие: ${row.label}`,{undoId:id,before:current,after:restored,originalEvents:after.events.filter(e=>!oldEvents.has(e.id)).map(e=>e.id)});
 // Also notify the task participants even if no original notification was generated.
 for(const recipient of new Set([...recipients.map(r=>r.recipient_id),current.assignee_id,current.creator_id]))if(recipient!==u.id)await notify(db,current.id,recipient,`По задаче #${current.id} ${u.name} отменил действие «${row.label}». Проверьте актуальное состояние задачи.`,`undo:${id}:${recipient}`);
 await db.query("UPDATE bot_buttons SET revoked=true WHERE payload->>'id'=$1 AND receipt IS NULL",[current.id]);
 await db.query("DELETE FROM bot_sessions WHERE data->'payload'->>'id'=$1",[current.id]);
 await db.query('UPDATE undo_actions SET undone_at=clock_timestamp() WHERE id=$1',[id]);return {taskId:current.id};
});}
