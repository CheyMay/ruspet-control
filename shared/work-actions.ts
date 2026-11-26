import {activeTaskApproval,approvalTurn,canComplete,canForwardDeadlineToBranch,canReview} from './actions.js';
import {branchApprovalLead,branchCovers} from './branches.js';
import type {WorkTask} from './work-queue.js';
import type {Bootstrap} from './types.js';

export function quickWorkActions(data:Bootstrap,item:WorkTask){
 const task=item.task,user=data.user;
 const approval=data.approvals.find(a=>activeTaskApproval(task,a));
 const blocked=!!task.workspace_read_only;
 const own=task.assignee_id===user.id;
 const manage=['admin','director','sales_head'].includes(user.role)||user.role==='branch_manager'&&
  (!!user.company_branch_access||branchCovers(user.branch_id,task.branch_id));
 const request=own||task.creator_id===user.id||manage;
 const finish=!blocked&&task.status==='active'&&!item.needsAcceptance&&!(data.pendingAssignmentIds??[]).includes(task.id)&&
  approval?.type!=='completion'&&(own||canComplete(user,task,data.approvalScope))?
  canComplete(user,task,data.approvalScope)?'complete' as const:'submit' as const:null;
 const turn=approval&&approvalTurn(approval);
 const proposed=approval?.approved_deadline??approval?.proposed_deadline;
 const validDeadline=approval?.type!=='deadline'||!!proposed&&
  (Date.parse(proposed)>Date.parse(data.serverTime)||proposed===task.deadline);
 const decide=!blocked&&!!approval&&turn?.userId===user.id&&!turn.clarification&&
  !approval.task_change?.routeIssue&&validDeadline&&(approval.type==='completion'?canReview(user,task):approval.requester_id!==user.id);
 const forward=decide&&canForwardDeadlineToBranch(user.id,approval!,task);
 const branchLead=forward?branchApprovalLead(task.branch_id,data.users,data.branchApprovalLeads):null;
 return {finish,deadline:!blocked&&task.status==='active'&&request&&!approval,
  accept:!blocked&&task.status==='review'&&!approval&&canReview(user,task,data.approvalScope),
  approval:decide?approval:null,forward,branchLead:branchLead&&branchLead.id!==user.id&&branchLead.id!==approval?.requester_id?branchLead:null};
}
