WITH routes AS (
 SELECT a.id,a.route AS previous_route,t.creator_id,t.creator_id<>t.assignee_id AS needs_review,
  jsonb_build_array(jsonb_build_object('userId',t.creator_id,'label','Постановщик')) AS creator_route
 FROM approvals a JOIN tasks t ON t.id=a.task_id
 WHERE a.type='completion' AND a.state='pending' AND a.canceled_at IS NULL
  AND a.task_version=t.version AND t.status<>'completed'
), changed AS (
 UPDATE approvals a
 SET route=CASE WHEN r.needs_review THEN r.creator_route ELSE a.route END,
  current_step=CASE WHEN r.needs_review THEN 0 ELSE a.current_step END,
  state=CASE WHEN r.needs_review THEN 'pending' ELSE 'stale' END,
  canceled_at=CASE WHEN r.needs_review THEN NULL ELSE now() END,
  deferred_until=NULL,action_revision=a.action_revision+1,
  task_change=CASE WHEN jsonb_typeof(a.task_change)='object' THEN a.task_change-'routeIssue' ELSE a.task_change END
 FROM routes r WHERE a.id=r.id
  AND (NOT r.needs_review OR a.current_step<>0 OR a.route<>r.creator_route OR a.task_change->>'routeIssue'='true')
 RETURNING a.id,a.task_id,a.route,a.action_revision,r.previous_route,r.creator_id,r.needs_review
), archived_notices AS (
 UPDATE outbox o SET withdrawn_at=now() FROM changed c
 WHERE o.task_id=c.task_id AND o.read_at IS NULL AND o.withdrawn_at IS NULL
  AND (o.dedupe_key LIKE 'approval:'||c.id::text||':%'
   OR o.dedupe_key LIKE 'defer:'||c.id::text||':%'
   OR o.dedupe_key LIKE 'clarification-answer:'||c.id::text||':%')
), history AS (
 INSERT INTO task_events(id,task_id,kind,message,data)
 SELECT gen_random_uuid(),task_id,'approval_route_changed',
  CASE WHEN needs_review THEN 'Приёмка передана постановщику' ELSE 'Постановщик может завершить свою задачу' END,
  jsonb_build_object('approvalId',id,'previousRoute',previous_route,'route',CASE WHEN needs_review THEN route ELSE '[]'::jsonb END)
 FROM changed
)
INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key)
SELECT gen_random_uuid(),task_id,creator_id,
 CASE WHEN needs_review THEN 'Проверьте результат по задаче #'||task_id ELSE 'Свою задачу #'||task_id||' можно завершить из карточки' END,
 'approval:'||id::text||':route:'||action_revision::text
FROM changed ON CONFLICT(dedupe_key) DO NOTHING;

UPDATE outbox o SET withdrawn_at=now()
FROM director_approval_batches b
WHERE o.management_notice->>'batchId'=b.id::text AND o.management_notice->>'kind'='director-approvals'
 AND o.read_at IS NULL AND o.withdrawn_at IS NULL
 AND EXISTS(SELECT 1 FROM director_approval_batch_items i WHERE i.batch_id=b.id)
 AND NOT EXISTS(SELECT 1 FROM director_approval_batch_items i JOIN approvals a ON a.id=i.approval_id
  WHERE i.batch_id=b.id AND a.type='deadline');
