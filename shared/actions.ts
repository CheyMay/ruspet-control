import type {Bootstrap,Task,User} from './types.js';
export type ActionItem={key:string;kind:'answer'|'decision'|'review'|'rework'|'clarification'|'edit_permission';taskId:string;title:string;label:string;ownerId:string;since:string|null;due:string|null;mine:boolean;targetId:string};
export function canReview(u:User,t:Task){return u.id!==t.assignee_id&&(u.id===t.creator_id||['admin','director','sales_head'].includes(u.role)||u.role==='branch_manager'&&(u.company_branch_access||u.branch_id===t.branch_id))}
export function actionItems(data:Bootstrap):ActionItem[]{
 const result:ActionItem[]=[],tasks=new Map(data.tasks.map(t=>[t.id,t]));
 const pending=new Set(data.approvals.filter(approval=>approval.state==='pending').map(approval=>approval.task_id));
 const latest=new Map<string,Bootstrap['submissions'][number]>(),review=new Map<string,Bootstrap['submissions'][number]>();
 for(const submission of data.submissions??[]){
  if(submission.round>(latest.get(submission.task_id)?.round??0))latest.set(submission.task_id,submission);
  if(submission.state==='review')review.set(submission.task_id,submission);
 }
 for(const p of data.editRequests??[]){
  const task=tasks.get(p.task_id);
  if(task)result.push({key:'edit-permission:'+p.id,kind:'edit_permission',taskId:task.id,title:task.title,label:'Решить запрос на редактирование',ownerId:p.creator_id,since:p.created_at,due:null,mine:p.creator_id===data.user.id,targetId:p.id});
 }
 for(const c of data.controls){const t=tasks.get(c.task_id);if(!t||!['waiting','escalated'].includes(c.state))continue;result.push({key:'answer:'+c.id,kind:'answer',taskId:t.id,title:t.title,label:'Ответить на запрос',ownerId:c.assignee_id,since:c.created_at,due:c.due_at,mine:c.assignee_id===data.user.id||data.user.role==='admin',targetId:c.id})}
 for(const a of data.approvals){const t=tasks.get(a.task_id);if(!t||a.state!=='pending')continue;const clarification=!!a.clarification_requested_at&&!a.clarification_answered_at;const ownerId=clarification?a.requester_id:a.route[a.current_step]?.userId;if(!ownerId)continue;result.push({key:'decision:'+a.id,kind:clarification?'clarification':'decision',taskId:t.id,title:t.title,label:clarification?'Ответить на уточнение':a.type==='deadline'?'Решить перенос срока':'Проверить закрытие',ownerId,since:clarification?a.clarification_requested_at:a.clarification_answered_at||a.created_at,due:a.deferred_until,mine:ownerId===data.user.id,targetId:a.id})}
 for(const t of data.tasks){if(t.status==='review'&&!pending.has(t.id)){const sub=review.get(t.id);result.push({key:'review:'+t.id,kind:'review',taskId:t.id,title:t.title,label:'Принять результат',ownerId:t.creator_id!==t.assignee_id?t.creator_id:'',since:sub?.submitted_at||null,due:null,mine:canReview(data.user,t),targetId:t.id})}
 if(t.status==='active'){const last=latest.get(t.id);if(last?.state==='returned')result.push({key:'rework:'+t.id,kind:'rework',taskId:t.id,title:t.title,label:'Исправить замечания',ownerId:t.assignee_id,since:last.decided_at,due:t.deadline,mine:t.assignee_id===data.user.id,targetId:t.id})}}
 return result.sort((a,b)=>Number(b.mine)-Number(a.mine)||(a.since||'9999').localeCompare(b.since||'9999'));
}
