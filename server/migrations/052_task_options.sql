ALTER TABLE tasks ADD COLUMN result_required boolean NOT NULL DEFAULT true;
ALTER TABLE tasks ADD COLUMN critical boolean NOT NULL DEFAULT false;

UPDATE outbox SET withdrawn_at=now()
WHERE read_at IS NULL AND withdrawn_at IS NULL
  AND management_notice->>'kind' IN ('director-approvals','approval-batch-ready');

INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key)
SELECT gen_random_uuid(),a.task_id,u.id,'Требуется решение по задаче #'||a.task_id,
 'approval:'||a.id::text||':'||a.current_step
FROM approvals a JOIN tasks t ON t.id=a.task_id AND t.version=a.task_version
JOIN users u ON u.id=a.route->a.current_step->>'userId'
WHERE a.type='deadline' AND a.state='pending' AND a.canceled_at IS NULL AND t.status='active'
 AND (a.task_change->>'routeIssue') IS DISTINCT FROM 'true'
 AND (a.clarification_requested_at IS NULL OR a.clarification_answered_at IS NOT NULL)
 AND (a.deferred_until IS NULL OR a.deferred_until<=now())
 AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.recipient_id=u.id AND o.withdrawn_at IS NULL
  AND o.dedupe_key LIKE 'approval:'||a.id::text||':%')
ON CONFLICT(dedupe_key) DO NOTHING;
