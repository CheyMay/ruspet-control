WITH cutoff AS (
 SELECT applied_at FROM schema_migrations WHERE name='056_reset_existing_assignment_queue.sql'
), recent AS (
 SELECT t.* FROM tasks t JOIN users u ON u.id=t.assignee_id CROSS JOIN cutoff c
 WHERE t.status='active' AND t.assignee_id<>t.creator_id AND NOT u.root_access
 AND (u.position~*'менеджер[[:space:]]+по[[:space:]]+продажам|руководитель филиала|руководител[[:alpha:]]* отдела управления продажами|координатор отдела продаж'
  OR lower(trim(u.position))='тестовый менеджер')
 AND (t.created_at>=c.applied_at OR EXISTS (
  SELECT 1 FROM task_events e WHERE e.task_id=t.id AND e.created_at>=c.applied_at
  AND e.data->'after'->>'assignee_id'=t.assignee_id
  AND e.data->'before'->>'assignee_id' IS DISTINCT FROM t.assignee_id
  AND e.data->'after'->>'assignment_epoch'=t.assignment_epoch::text))
), restored AS (
 INSERT INTO personal_task_plans AS p(task_id,assignment_epoch,user_id,requires_acceptance)
 SELECT id,assignment_epoch,assignee_id,true FROM recent
 ON CONFLICT(task_id,assignment_epoch) DO UPDATE SET requires_acceptance=true,revision=p.revision+1
 WHERE NOT p.requires_acceptance AND p.accepted_at IS NULL
 RETURNING task_id,user_id,assignment_epoch
), withdrawn AS (
 UPDATE outbox o SET withdrawn_at=now() FROM restored r
 WHERE o.task_assignment AND o.task_id=r.task_id AND o.recipient_id=r.user_id AND o.withdrawn_at IS NULL
)
INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key,task_assignment)
SELECT gen_random_uuid(),r.task_id,r.user_id,
 'У вас новая задача #'||coalesce(l.external_id::text,t.id)||' · '||t.title||E'\nПримите задачу и укажите плановое время.',
 'task-assignment-restored:'||r.task_id||':'||r.assignment_epoch,true
FROM restored r JOIN tasks t ON t.id=r.task_id LEFT JOIN bitrix_task_links l ON l.task_id=r.task_id
ON CONFLICT(dedupe_key) DO NOTHING;
