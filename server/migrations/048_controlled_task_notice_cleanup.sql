WITH scope AS (SELECT staff_work_ids() ids),
 excluded AS (
  SELECT t.id FROM tasks t CROSS JOIN scope s
  WHERE t.creator_id=t.assignee_id OR (s.ids IS NOT NULL AND NOT(t.assignee_id=ANY(s.ids)))
 ),
 closed AS (
  UPDATE control_requests c SET state='resolved'
  FROM excluded t WHERE c.task_id=t.id AND c.state IN ('waiting','escalated') RETURNING c.id
 )
UPDATE outbox o SET withdrawn_at=now()
FROM closed c WHERE o.withdrawn_at IS NULL
 AND (o.dedupe_key='control:'||c.id OR o.dedupe_key LIKE 'remind:'||c.id||':%');

UPDATE findings f SET status='resolved'
FROM tasks t CROSS JOIN (SELECT staff_work_ids() ids) s
WHERE f.task_id=t.id AND f.status='open' AND
 (t.creator_id=t.assignee_id OR (s.ids IS NOT NULL AND NOT(t.assignee_id=ANY(s.ids))));

UPDATE outbox o SET withdrawn_at=now()
FROM (SELECT staff_work_ids() ids) s
WHERE o.withdrawn_at IS NULL AND o.read_at IS NULL AND o.created_at>now()-interval '1 day'
 AND (
  (o.task_notice->>'hasDeadlines'='true' AND o.task_notice->>'hasAssignments' IS DISTINCT FROM 'true'
   AND ((s.ids IS NOT NULL AND NOT(o.recipient_id=ANY(s.ids))) OR
    EXISTS(SELECT 1 FROM tasks t WHERE o.task_notice->'taskIds' ? t.id AND t.creator_id=t.assignee_id) OR
    NOT EXISTS(SELECT 1 FROM tasks t WHERE t.assignee_id=o.recipient_id AND t.creator_id<>t.assignee_id AND t.status='active')))
  OR ((o.management_notice->>'kind'='workday' OR o.dedupe_key LIKE 'management-nudge:%')
   AND s.ids IS NOT NULL AND NOT(o.recipient_id=ANY(s.ids)))
 );

UPDATE task_alerts a SET canceled_at=now()
FROM (SELECT staff_work_ids() ids) s
WHERE a.kind IN ('morning','noon') AND a.acknowledged_at IS NULL AND a.canceled_at IS NULL AND a.expires_at>now()
 AND ((s.ids IS NOT NULL AND NOT(a.recipient_id=ANY(s.ids)))
  OR EXISTS(SELECT 1 FROM reports r CROSS JOIN LATERAL jsonb_array_elements(r.rows) task
   WHERE r.id=a.report_id AND task->>'creator_id'=task->>'assignee_id'));
