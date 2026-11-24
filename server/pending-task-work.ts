import type {Db} from './db.js';

// All callers use the current task as t. A request remains active through clarifications.
export const hasPendingTaskApproval=`EXISTS(
 SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.state='pending'
 AND a.canceled_at IS NULL AND a.task_version=t.version
)`;

export const hasPendingTaskAcceptance=`(t.status='active' AND EXISTS(
 SELECT 1 FROM personal_task_plans p WHERE p.task_id=t.id AND p.assignment_epoch=t.assignment_epoch
 AND p.user_id=t.assignee_id AND p.requires_acceptance AND p.accepted_at IS NULL
))`;

export const latestTaskAssignment=`NOT EXISTS(SELECT 1 FROM outbox newer
 WHERE newer.task_assignment AND newer.task_id=o.task_id AND newer.recipient_id=o.recipient_id
 AND newer.withdrawn_at IS NULL AND (newer.created_at,newer.id)>(o.created_at,o.id))`;

export const visibleAssignmentNotice=`(NOT o.task_assignment OR EXISTS(
 SELECT 1 FROM tasks t WHERE t.id=o.task_id AND t.assignee_id=o.recipient_id AND ${hasPendingTaskAcceptance} AND ${latestTaskAssignment}
)) AND o.task_notice->>'acceptanceOnly' IS DISTINCT FROM 'true'`;

export const visibleControlNotice=`(o.read_at IS NOT NULL OR (o.dedupe_key NOT LIKE 'control:%' AND o.dedupe_key NOT LIKE 'remind:%') OR
 NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=o.task_id AND t.status<>'completed' AND ${hasPendingTaskApproval}))`;

export const visibleDeadlineNotice=`(o.read_at IS NOT NULL OR o.task_notice->>'hasDeadlines' IS DISTINCT FROM 'true' OR NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements_text(COALESCE(o.task_notice->'deadlineTaskIds',o.task_notice->'taskIds','[]')) n(task_id)
 JOIN tasks t ON t.id=n.task_id WHERE t.status<>'completed' AND ${hasPendingTaskApproval}
))`;

export async function pendingTaskWorkIds(db:Db,ids:readonly string[]){
 if(!ids.length)return new Set<string>();
 const {rows}=await db.query<{id:string}>(`SELECT t.id FROM tasks t
  WHERE t.id=ANY($1::text[]) AND t.status<>'completed' AND ${hasPendingTaskApproval}`,[ids]);
 return new Set(rows.map(row=>row.id));
}
