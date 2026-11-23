import {isDeepStrictEqual} from 'node:util';
import {approvalHierarchy,configuredApprovalRoute} from './approval-hierarchy.js';
import type {Db} from './db.js';
import {event,notify} from './service.js';
import {taskPrice} from '../shared/pricing.js';
import {completionApprovalRoute,isSelfTask} from '../shared/actions.js';
import type {Approval,ApprovalTaskChange,Task} from '../shared/types.js';

const editableFields=['title','description','assignee_id','branch_id','planned_start','planned_end',
 'important','customer_risk','parent_id','price','custom_fields','company_id','priority','critical','result_required'] as const;

function fieldValue(task:Task,field:string){
 const raw=field==='price'?taskPrice(task):task[field as keyof Task];
 return raw instanceof Date?raw.toISOString():raw??null;
}

export function editedApprovalFields(before:Task,after:Task){
 return editableFields.filter(field=>!isDeepStrictEqual(fieldValue(before,field),fieldValue(after,field)));
}

export async function carryApprovalBatch(db:Db,approvalId:string,step:number,oldRevision:number,newRevision:number){
 await db.query(`INSERT INTO director_approval_batch_items(batch_id,approval_id,step,revision)
  SELECT batch_id,approval_id,step,$4 FROM director_approval_batch_items
  WHERE approval_id=$1 AND step=$2 AND revision=$3 ON CONFLICT DO NOTHING`,[approvalId,step,oldRevision,newRevision]);
}

// Call with the task locked and in the transaction that applies the new version.
export async function keepTaskApprovals(db:Db,before:Task,after:Task,fields:readonly string[],source:ApprovalTaskChange['source'],actorId:string|null){
 const {rows}=await db.query<Approval>(`SELECT * FROM approvals WHERE task_id=$1
  AND state='pending' AND canceled_at IS NULL AND task_version=$2 FOR UPDATE`,[after.id,before.version]);
 if(!rows.length)return;
 const hierarchy=await approvalHierarchy(db);
 const changes=fields.map(field=>{
  const value=(t:Task)=>{const v=fieldValue(t,field);return typeof v==='string'||typeof v==='number'||typeof v==='boolean'?v:null;};
  return {field,before:value(before),after:value(after)};
 });
 for(const approval of rows){
  if(after.status==='completed'||approval.type==='completion'&&(isSelfTask(after)||before.status==='review'&&after.status==='active')){
   const reason=after.status==='completed'?'Задача уже завершена':isSelfTask(after)?'Постановщик может завершить свою задачу':'Результат уже возвращён в работу';
   await db.query("UPDATE approvals SET state='stale',canceled_at=now(),deferred_until=NULL,action_revision=action_revision+1 WHERE id=$1",[approval.id]);
   await db.query("UPDATE outbox SET withdrawn_at=now() WHERE dedupe_key LIKE $1 AND withdrawn_at IS NULL",['approval:'+approval.id+':%']);
   await event(db,after.id,actorId,'approval_canceled',reason,{approvalId:approval.id,source,fields});
   continue;
  }
  if(!changes.length){
   await db.query('UPDATE approvals SET task_version=$2 WHERE id=$1',[approval.id,after.version]);
   continue;
  }
  const recheck=fields.some(field=>['price','assignee_id','creator_id','branch_id'].includes(field));
  const calculated=approval.type==='completion'?completionApprovalRoute(after):
   hierarchy&&recheck?configuredApprovalRoute(hierarchy,after,approval.requester_id):null;
  const route=calculated?.length?calculated:approval.route;
  const routeIssue=approval.type==='completion'?false:recheck?
   calculated?.length===0||route.some(step=>step.userId===approval.requester_id):!!approval.task_change?.routeIssue;
  const routeChanged=route.length!==approval.route.length||route.some((step,i)=>step.userId!==approval.route[i].userId);
  const change:ApprovalTaskChange={source,at:new Date().toISOString(),fields:changes,routeChanged,routeIssue};
  const revision=approval.action_revision+1;
  await db.query(`UPDATE approvals SET task_change=$2,task_version=$3,action_revision=$4,route=$5,
   current_step=CASE WHEN $6 THEN 0 ELSE current_step END,
   deferred_until=CASE WHEN $6 OR $7 THEN NULL ELSE deferred_until END,
   approved_deadline=CASE WHEN $6 THEN NULL ELSE approved_deadline END,
   clarification_question=CASE WHEN $6 THEN NULL ELSE clarification_question END,
   clarification_answer=CASE WHEN $6 THEN NULL ELSE clarification_answer END,
   clarification_requested_at=CASE WHEN $6 THEN NULL ELSE clarification_requested_at END,
   clarification_answered_at=CASE WHEN $6 THEN NULL ELSE clarification_answered_at END WHERE id=$1`,
   [approval.id,JSON.stringify(change),after.version,revision,JSON.stringify(route),routeChanged,routeIssue]);
  if(routeChanged||routeIssue){
   await db.query("UPDATE outbox SET withdrawn_at=now() WHERE dedupe_key LIKE $1 AND withdrawn_at IS NULL",['approval:'+approval.id+':%']);
  }
  if(!routeChanged&&!routeIssue)await carryApprovalBatch(db,approval.id,approval.current_step,approval.action_revision,revision);
  if(routeChanged&&!routeIssue&&route[0].userId!==actorId)
   await notify(db,after.id,route[0].userId,'Маршрут согласования изменился. Проверьте задачу #'+after.id,
    `approval:${approval.id}:route:${revision}`);
  await event(db,after.id,actorId,'approval_task_changed',source==='bitrix'?'Задача обновлена в Битрикс24 во время согласования':'Задача изменена в РУСПЭТ во время согласования',
   {approvalId:approval.id,change,previousRoute:approval.route,route});
 }
}
