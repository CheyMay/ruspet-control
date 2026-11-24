WITH cleared AS (
 UPDATE personal_task_plans p SET requires_acceptance=false,revision=p.revision+1
 FROM tasks t WHERE p.task_id=t.id AND p.assignment_epoch=t.assignment_epoch AND p.user_id=t.assignee_id
  AND p.requires_acceptance AND p.accepted_at IS NULL
 RETURNING p.task_id,p.user_id
)
UPDATE outbox o SET withdrawn_at=now()
FROM cleared c WHERE o.task_id=c.task_id AND o.recipient_id=c.user_id
 AND o.task_assignment AND o.withdrawn_at IS NULL;
