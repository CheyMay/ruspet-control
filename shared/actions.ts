import type {Approval,ApprovalScope,Bootstrap,Step,Task,User} from './types.js';
import {priceBand} from './pricing.js';
export type ActionItem={key:string;kind:'answer'|'decision'|'review'|'rework'|'clarification'|'edit_permission';taskId:string;title:string;label:string;ownerId:string;since:string|null;due:string|null;mine:boolean;targetId:string};
export const isSelfTask=(task:Task)=>task.assignee_id===task.creator_id;
export const usesCreatorApproval=(task:Task,scope?:ApprovalScope|null)=>
 scope?.creatorApproverId===task.creator_id&&!(scope.onlySelfDirect&&isSelfTask(task));
export const completionApprovalRoute=(task:Task):Step[]=>isSelfTask(task)?[]:[{userId:task.creator_id,label:'Постановщик'}];
export const canReview=(u:User,t:Task,_scope?:ApprovalScope|null)=>u.id===t.creator_id&&!isSelfTask(t);
export function canComplete(u:User,t:Task,scope?:ApprovalScope|null){
 return t.status!=='completed'&&u.id===t.creator_id&&(isSelfTask(t)||
  !scope?.onlySelfDirect&&!usesCreatorApproval(t,scope)&&!scope?.assigneeIds.includes(t.assignee_id));
}
export function activeTaskApproval(task:Task,approval:Approval){
 return task.status!=='completed'&&approval.task_id===task.id&&approval.state==='pending'&&!approval.canceled_at&&approval.task_version===task.version;
}
export function approvalTurn(approval:Approval){
 const clarification=!!approval.clarification_requested_at&&!approval.clarification_answered_at;
 return {clarification,userId:clarification?approval.requester_id:approval.route[approval.current_step]?.userId};
}
export function canSetApprovedDeadline(userId:string,a:Approval,task:Task|undefined,policy:{
 deadlineApproverId?:string|null;creatorApproverId?:string|null;
}){
 if(a.type!=='deadline'||a.current_step!==a.route.length-1||a.route[a.current_step]?.userId!==userId)return false;
 if(userId===policy.deadlineApproverId)return true;
 return !!task&&a.route.length===1&&userId===policy.creatorApproverId&&task.creator_id===userId&&priceBand(task)==='low';
}
export function taskNextAction(task:Task,approval?:Approval,_scope?:ApprovalScope|null){
 if(approval&&activeTaskApproval(task,approval)){
  const {clarification,userId}=approvalTurn(approval);
  return {userId,label:clarification?'Ответить на уточнение':approval.type==='deadline'?'Решить вопрос о переносе':'Принять результат'};
 }
 if(task.status==='review')return {userId:task.creator_id,label:'Принять результат'};
 if(task.status==='active')return {userId:task.assignee_id,label:'Выполнить задачу'};
 return null;
}
export function actionItems(data:Bootstrap):ActionItem[]{
 const result:ActionItem[]=[],tasks=new Map(data.tasks.map(t=>[t.id,t]));
 const activeApprovals=data.approvals.filter(approval=>{
  const task=tasks.get(approval.task_id);
  return task&&activeTaskApproval(task,approval);
 });
 const pending=new Set(activeApprovals.map(approval=>approval.task_id));
 const latest=new Map<string,Bootstrap['submissions'][number]>(),review=new Map<string,Bootstrap['submissions'][number]>();
 for(const submission of data.submissions??[]){
  if(submission.round>(latest.get(submission.task_id)?.round??0))latest.set(submission.task_id,submission);
  if(submission.state==='review')review.set(submission.task_id,submission);
 }
 for(const p of data.editRequests??[]){
  const task=tasks.get(p.task_id);
  if(task)result.push({key:'edit-permission:'+p.id,kind:'edit_permission',taskId:task.id,title:task.title,label:'Решить запрос на редактирование',ownerId:p.creator_id,since:p.created_at,due:null,mine:p.creator_id===data.user.id,targetId:p.id});
 }
 for(const c of data.controls){const t=tasks.get(c.task_id);if(!t||pending.has(t.id)||t.status!=='active'||t.assignee_id!==c.assignee_id||!['waiting','escalated'].includes(c.state))continue;result.push({key:'answer:'+c.id,kind:'answer',taskId:t.id,title:t.title,label:'Дать объяснение',ownerId:c.assignee_id,since:c.created_at,due:c.due_at,mine:c.assignee_id===data.user.id,targetId:c.id})}
 for(const a of activeApprovals){const t=tasks.get(a.task_id)!;const clarification=!!a.clarification_requested_at&&!a.clarification_answered_at;const ownerId=clarification?a.requester_id:a.route[a.current_step]?.userId;if(!ownerId)continue;result.push({key:'decision:'+a.id,kind:clarification?'clarification':'decision',taskId:t.id,title:t.title,label:clarification?'Ответить на уточнение':a.type==='deadline'?'Решить перенос срока':'Проверить закрытие',ownerId,since:clarification?a.clarification_requested_at:a.clarification_answered_at||a.created_at,due:a.deferred_until,mine:ownerId===data.user.id,targetId:a.id})}
 for(const t of data.tasks){if(t.status==='review'&&!pending.has(t.id)){
  const sub=review.get(t.id),ownerId=t.creator_id;
  result.push({key:'review:'+t.id,kind:'review',taskId:t.id,title:t.title,label:'Принять результат',ownerId,since:sub?.submitted_at||null,due:null,mine:data.user.id===ownerId,targetId:t.id});}
 if(t.status==='active'){const last=latest.get(t.id);if(last?.state==='returned')result.push({key:'rework:'+t.id,kind:'rework',taskId:t.id,title:t.title,label:'Исправить замечания',ownerId:t.assignee_id,since:last.decided_at,due:t.deadline,mine:t.assignee_id===data.user.id,targetId:t.id})}}
 return result.sort((a,b)=>Number(b.mine)-Number(a.mine)||(a.since||'9999').localeCompare(b.since||'9999'));
}
