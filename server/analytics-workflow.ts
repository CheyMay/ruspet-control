import {approvalTurn} from '../shared/actions.js';
import type {WaitingStage} from '../shared/team-analytics.js';
import type {Approval,Task} from '../shared/types.js';
import type {Db} from './db.js';

export type TaskWait={taskId:string;stage:WaitingStage;userId:string;since:string|null};

export async function analyticsWaits(db:Db,tasks:Task[],now:Date){
 const ids=tasks.filter(task=>task.status!=='completed').map(task=>task.id);
 if(!ids.length)return new Map<string,TaskWait>();
 const approvals=(await db.query<Approval&{previous_step_at:string|null}>(`SELECT DISTINCT ON (a.task_id) a.*,
  (SELECT max(d.created_at) FROM decisions d WHERE d.approval_id=a.id AND d.step_index=a.current_step-1
   AND d.decision='approve') AS previous_step_at
  FROM approvals a JOIN tasks t ON t.id=a.task_id AND t.version=a.task_version
  WHERE a.task_id=ANY($1) AND a.state='pending' AND a.canceled_at IS NULL
  ORDER BY a.task_id,a.created_at DESC`,[ids])).rows;
 const submissions=(await db.query<{task_id:string;submitted_at:string}>(`SELECT task_id,submitted_at FROM task_submissions
  WHERE task_id=ANY($1) AND state='review' AND withdrawn_at IS NULL`,[ids])).rows;
 const plans=(await db.query<{task_id:string;since:string|null}>(`SELECT t.id task_id,
  COALESCE((SELECT max(o.created_at) FROM outbox o WHERE o.task_id=t.id AND o.recipient_id=t.assignee_id
   AND o.task_assignment AND o.withdrawn_at IS NULL),CASE WHEN t.assignment_epoch=1 THEN t.created_at END) AS since
  FROM tasks t JOIN personal_task_plans p ON p.task_id=t.id AND p.assignment_epoch=t.assignment_epoch
  AND p.user_id=t.assignee_id WHERE t.id=ANY($1) AND t.status='active' AND p.requires_acceptance AND p.accepted_at IS NULL`,[ids])).rows;
 const byApproval=new Map(approvals.map(row=>[row.task_id,row]));
 const byReview=new Map(submissions.map(row=>[row.task_id,row.submitted_at]));
 const byPlan=new Map(plans.map(row=>[row.task_id,row.since]));
 const rows=new Map<string,TaskWait>();
 for(const task of tasks){
  const approval=byApproval.get(task.id);
  if(approval){
   const turn=approvalTurn(approval);
   if(turn.userId&&(turn.clarification||!approval.deferred_until||Date.parse(approval.deferred_until)<=+now)){
    const since=turn.clarification?approval.clarification_requested_at:
     [approval.created_at,approval.clarification_answered_at,approval.previous_step_at,approval.deferred_until,
      approval.task_change?.routeChanged?approval.task_change.at:null]
      .filter((value):value is string=>!!value).sort().at(-1)??null;
    rows.set(task.id,{taskId:task.id,stage:turn.clarification?'clarification':approval.type==='completion'?'review':'approval',userId:turn.userId,since});
   }
  }else if(task.status==='review')rows.set(task.id,{taskId:task.id,stage:'review',userId:task.creator_id,since:byReview.get(task.id)??null});
  else if(byPlan.has(task.id))rows.set(task.id,{taskId:task.id,stage:'assignment',userId:task.assignee_id,since:byPlan.get(task.id)??null});
 }
 return rows;
}

export async function morningActivity(db:Db,from:Date,now:Date){
 const recorded=[
  'assignment_accepted','personal_plan_changed','personal_plan_set','comment','task_edited','approval_requested',
  'approval_rejected','approval_clarification_answered','step_approved','deadline_changed','deadline_confirmed',
  'review_submitted','review_returned','task_completed','explanation'
 ];
 const {rows}=await db.query<{task_id:string;before:Partial<Task>|null;worked:boolean}>(`WITH since AS (
  SELECT e.task_id,e.created_at,e.id,e.data->'before' AS before,
   e.kind=ANY($3) OR e.kind='bitrix_change' AND (e.data#>'{before,status}' IS DISTINCT FROM e.data#>'{after,status}'
    OR e.data#>'{before,deadline}' IS DISTINCT FROM e.data#>'{after,deadline}') AS worked
  FROM task_events e WHERE e.created_at>$1 AND e.created_at<=$2 AND e.task_id IS NOT NULL AND
   NOT EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id AND r.created_at<=$2)
 ), versions AS (
  SELECT DISTINCT ON (task_id) task_id,before FROM since WHERE before ? 'status'
  ORDER BY task_id,created_at,coalesce((before->>'version')::integer,0),id
 )
 SELECT s.task_id,v.before,bool_or(s.worked) AS worked FROM since s LEFT JOIN versions v USING(task_id)
 GROUP BY s.task_id,v.before`,[from.toISOString(),now.toISOString(),recorded]);
 return new Map(rows.map(row=>[row.task_id,row]));
}
