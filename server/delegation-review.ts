import {randomUUID} from 'node:crypto';
import {transaction,type Db} from './db.js';
import {actionState,sameState} from './undo-record.js';
import {lockDelegationChain} from './delegation-lock.js';
import {assert} from './domain.js';
import {event,notify,refreshTaskFindings} from './service.js';
import {MockTaskProvider} from './providers.js';
import type {Task,User} from '../shared/types.js';

export async function delegatedTaskAccepted(db:Db,id:string){
 const child=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 if(!child?.delegated_from_id||child.status!=='completed')return;
 await db.query(`INSERT INTO delegation_review_checks(source_id,trigger_task_id) VALUES($1,$2)
  ON CONFLICT(source_id) DO UPDATE SET trigger_task_id=EXCLUDED.trigger_task_id,requested_at=now()`,[child.delegated_from_id,id]);
 await submitDelegatedSource(db,child.delegated_from_id);
}
async function submitDelegatedSource(db:Db,id:string){
 await lockDelegationChain(db,id);
 const source=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 if(!source||source.status!=='active'){await db.query('DELETE FROM delegation_review_checks WHERE source_id=$1',[id]);return false;}
 const children=(await db.query<Task>('SELECT * FROM tasks WHERE delegated_from_id=$1 ORDER BY id',[id])).rows;
 if(!children.length||children.some(c=>c.status!=='completed'))return false;
 if((await db.query("SELECT 1 FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rowCount)return false;
 const before=await actionState(db,id),submissionId=randomUUID();
 const results=(await db.query("SELECT DISTINCT ON (task_id) task_id,result FROM task_submissions WHERE task_id=ANY($1::text[]) AND state='accepted' AND withdrawn_at IS NULL ORDER BY task_id,round DESC",[children.map(c=>c.id)])).rows;
 const result='Автоматическая сдача после приёмки всех поручений.\n'+children.map(c=>'#'+c.id+' · '+c.title+(results.find(r=>r.task_id===c.id)?.result?'\n'+results.find(r=>r.task_id===c.id)!.result:'')).join('\n\n');
 const after=(await db.query<Task>("UPDATE tasks SET status='review',completed_at=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
 await new MockTaskProvider().applyApprovedChange(db,after,source.version);
 await db.query("INSERT INTO task_submissions(id,task_id,round,result,author_id,state,automatic,based_on_tasks) SELECT $1,$2,coalesce(max(round),0)+1,$3,$4,'review',true,$5 FROM task_submissions WHERE task_id=$2",[submissionId,id,result,source.assignee_id,children.map(c=>c.id)]);
 const eventId=await event(db,id,null,'review_submitted','Все поручения приняты. Основная задача автоматически передана на приёмку.',{before:source,after,automaticDelegation:true,children:children.map(c=>c.id),comment:'Результаты всех делегированных поручений приняты.'});
 const actor=(await db.query<User>('SELECT * FROM users WHERE id=$1',[source.creator_id])).rows[0];
 await refreshTaskFindings(db,after,actor);
 await notify(db,id,source.creator_id,'Все поручения по задаче #'+id+' приняты. Основная задача ожидает вашей приёмки.','delegation-review:'+id+':'+after.version);
 await db.query('INSERT INTO delegation_auto_reviews(id,source_id,event_id,submission_id,child_versions,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),id,eventId,submissionId,JSON.stringify(Object.fromEntries(children.map(c=>[c.id,c.version]))),JSON.stringify(before),JSON.stringify(await actionState(db,id))]);
 await db.query('DELETE FROM delegation_review_checks WHERE source_id=$1',[id]);
 return true;
}
export async function runDelegationReviews(){
 return transaction(async db=>{
  const pending=(await db.query('SELECT source_id FROM delegation_review_checks ORDER BY requested_at LIMIT 30')).rows;
  let count=0;for(const row of pending)if(await submitDelegatedSource(db,row.source_id))count++;
  return count;
 });
}

/** Undo a contributing acceptance together with the generated parent submission. */
export async function undoDelegatedSource(db:Db,child:Task,undoId:string,actor:User){
 if(!child.delegated_from_id)return;
 const row=(await db.query(`SELECT * FROM delegation_auto_reviews WHERE source_id=$1 AND reverted_at IS NULL
  AND child_versions->>$2=$3 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[child.delegated_from_id,child.id,String(child.version)])).rows[0];
 if(!row)return;
 const before=row.before_state,after=row.after_state,live=await actionState(db,row.source_id);
 assert(sameState(live,after),409,'Основная задача уже изменилась после автоматической сдачи. Требуется отдельное исправление.');
 assert(!(await db.query("SELECT 1 FROM bitrix_operations WHERE event_id=$1 AND (attempts>0 OR state IN ('processing','sent','uncertain'))",[row.event_id])).rowCount,409,'Автоматическая сдача основной задачи уже передавалась в Битрикс24.');
 assert(!(await db.query("SELECT 1 FROM task_sync_queue WHERE task_id=$1 AND task_version>$2 AND (attempts>0 OR state='sent')",[row.source_id,before.task.version])).rowCount,409,'Основная задача уже передавалась внешнему обработчику.');
 await db.query("UPDATE bitrix_operations SET state='canceled' WHERE event_id=$1 AND attempts=0",[row.event_id]);
 await db.query("UPDATE task_sync_queue SET state='canceled' WHERE task_id=$1 AND task_version>$2 AND state IN ('pending','failed')",[row.source_id,before.task.version]);
 await db.query('UPDATE task_submissions SET withdrawn_at=now() WHERE id=$1',[row.submission_id]);
 await db.query('INSERT INTO event_retractions(event_id,undo_id) VALUES($1,$2)',[row.event_id,undoId]);
 const oldOutbox=new Set(before.outbox.map((v:any)=>v.id));
 await db.query('UPDATE outbox SET withdrawn_at=now() WHERE id=ANY($1::uuid[])',[after.outbox.filter((v:any)=>!oldOutbox.has(v.id)).map((v:any)=>v.id)]);
 const restored=(await db.query<Task>('UPDATE tasks SET status=$2,completed_at=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[row.source_id,before.task.status,before.task.completed_at])).rows[0];
 await new MockTaskProvider().applyApprovedChange(db,restored,live.task.version);
 await refreshTaskFindings(db,restored,actor);
 await event(db,row.source_id,actor.id,'action_undone','Отменена автоматическая сдача: отменена приёмка поручения #'+child.id,{before:live.task,after:restored,undoId,automaticDelegation:true});
 await notify(db,row.source_id,restored.creator_id,'Приёмка поручения #'+child.id+' отменена. Основная задача #'+row.source_id+' возвращена в работу.','delegation-undo:'+undoId);
 await db.query('UPDATE delegation_auto_reviews SET reverted_at=now(),reverted_by=$2 WHERE id=$1',[row.id,undoId]);
}
