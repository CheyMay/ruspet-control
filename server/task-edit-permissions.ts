import {randomUUID} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {assert,canSee} from './domain.js';
import {event,notify} from './service.js';
import {lockDelegationChain} from './delegation-lock.js';
import {editsTaskDirectly,type TaskEditAccess,type TaskEditPermission} from '../shared/task-edit.js';
import type {Task,User} from '../shared/types.js';

export async function taskEditAccess(user:User,task:Task,db:Db=pool):Promise<TaskEditAccess>{
 const direct=editsTaskDirectly(user,task),assigned=user.id===task.assignee_id;
 if(task.status!=='active'||!canSee(user,task)||!direct&&!assigned)
  return {canEdit:false,canRequest:false,canDecide:false,request:null};
 const request=(await db.query<TaskEditPermission>(`SELECT id,requester_id AS "requesterId",state,reason,decision_comment AS "decisionComment"
  FROM task_edit_permissions WHERE task_id=$1 AND task_version=$2 AND requester_id=$3
  ORDER BY (state IN ('pending','approved')) DESC,created_at DESC,id DESC LIMIT 1`,[task.id,task.version,task.assignee_id])).rows[0]??null;
 return {
  canEdit:direct||request?.state==='approved',
  canRequest:assigned&&!direct&&request?.state!=='pending'&&request?.state!=='approved',
  canDecide:direct&&request?.state==='pending',
  request
 };
}

async function lockedTask(db:Db,actor:User,id:string){
 await lockDelegationChain(db,id);
 const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
 assert(task&&canSee(actor,task),404,'Задача недоступна.');
 return task;
}

export async function requestTaskEdit(actor:User,id:string,version:number,reason:string){
 return transaction(async db=>{
  const task=await lockedTask(db,actor,id);
  assert(task.status==='active'&&task.version===version,409,'Задача изменилась. Обновите карточку.');
  assert(actor.id===task.assignee_id&&!editsTaskDirectly(actor,task),403,'Запрос может отправить исполнитель задачи.');
  assert(reason.trim().length>=5&&reason.length<=4000,400,'Укажите, что нужно изменить.');
  const access=await taskEditAccess(actor,task,db);
  assert(access.canRequest,409,'Запрос на редактирование уже открыт.');
  const requestId=randomUUID();
  await db.query("INSERT INTO task_edit_permissions(id,task_id,requester_id,task_version,reason,state) VALUES($1,$2,$3,$4,$5,'pending')",[requestId,id,actor.id,version,reason.trim()]);
  await event(db,id,actor.id,'task_edit_requested','Запрошено разрешение на редактирование',{editPermissionId:requestId,reason:reason.trim()});
  await notify(db,id,task.creator_id,actor.name+' просит разрешить редактирование задачи #'+id+'.','task-edit-request:'+requestId);
  return {id:requestId};
 });
}

export async function decideTaskEdit(actor:User,id:string,requestId:string,decision:'approve'|'reject',comment:string){
 return transaction(async db=>{
  const task=await lockedTask(db,actor,id);
  assert(editsTaskDirectly(actor,task),403,'Решение принимает постановщик, администратор или владелец.');
  const access=await taskEditAccess(actor,task,db);
  assert(access.canDecide&&access.request?.id===requestId,409,'Запрос уже обработан или задача изменилась.');
  const approved=decision==='approve',state=approved?'approved':'rejected';
  await db.query('UPDATE task_edit_permissions SET state=$2,decided_by=$3,decided_at=now(),decision_comment=$4 WHERE id=$1',[requestId,state,actor.id,comment.trim()]);
  const label=approved?'Разрешено одно редактирование':'Редактирование отклонено';
  await event(db,id,actor.id,approved?'task_edit_approved':'task_edit_rejected',label,{editPermissionId:requestId,comment:comment.trim()});
  await notify(db,id,access.request.requesterId,label+' · #'+id+(comment.trim()?' · '+comment.trim():''),'task-edit-decision:'+requestId);
  return {state};
 });
}

export async function useTaskEditPermission(db:Db,actor:User,task:Task){
 if(editsTaskDirectly(actor,task))return null;
 assert(actor.id===task.assignee_id,403,'Редактировать могут постановщик, администратор, владелец или исполнитель с разрешением.');
 const used=(await db.query<{id:string}>(`UPDATE task_edit_permissions SET state='used',used_at=now()
  WHERE task_id=$1 AND task_version=$2 AND requester_id=$3 AND state='approved' RETURNING id`,[task.id,task.version,actor.id])).rows[0];
 assert(used,403,'Сначала запросите разрешение на редактирование.');
 return used.id;
}
