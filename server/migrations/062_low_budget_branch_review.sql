CREATE TABLE approval_branch_leads (
 branch_id text PRIMARY KEY,
 user_id text REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO approval_branch_leads(branch_id) VALUES ('Крым'),('Краснодар');

-- Match only the confirmed sales head named Vladimir. Keep an unresolved mapping
-- visible instead of choosing an unrelated person when the directory is incomplete.
UPDATE approval_branch_leads SET user_id=(
 SELECT u.id FROM approval_hierarchy h JOIN users u ON u.id=h.sales_head_id
 WHERE h.id=1 AND NOT u.root_access AND u.role IN ('sales_head','director')
 AND u.name ~* '(^|[[:space:]])Владимир([[:space:]]|$)'
) WHERE branch_id='Крым';
UPDATE approval_branch_leads SET user_id=(
 SELECT CASE WHEN count(*)=1 THEN min(id) END FROM users u
 WHERE NOT u.root_access AND u.role IN ('branch_manager','admin','sales_head','director')
 AND u.name ~* '(^|[[:space:]])Макаренко([[:space:]]|$)'
 AND (u.role<>'branch_manager' OR u.branch_id='Краснодар' OR u.company_branch_access)
) WHERE branch_id='Краснодар';

ALTER TABLE approvals ADD COLUMN branch_review_user_id text REFERENCES users(id);

-- Open low-budget requests follow the same policy as new requests. Preserve all
-- previous decisions and record the route change, without applying deadlines in SQL.
CREATE TEMP TABLE low_budget_routes_062 ON COMMIT DROP AS
 WITH budgets AS (
  SELECT a.id,a.task_id,a.route,a.current_step,a.action_revision,a.requester_id,t.creator_id,
   coalesce(t.price,CASE WHEN raw.value ~ '^[0-9]+([.][0-9]{1,2})?$' THEN raw.value::numeric END) AS budget
  FROM approvals a JOIN tasks t ON t.id=a.task_id
  CROSS JOIN LATERAL (SELECT replace(regexp_replace(coalesce(t.source_fields->>'Цена задачи',''),
   '[[:space:]  ]|(₽|руб[.]?|rub)$','','gi'),',','.') AS value) raw
  WHERE a.type='deadline' AND a.state='pending' AND a.canceled_at IS NULL
   AND a.task_version=t.version AND t.status<>'completed'
 ) SELECT *,jsonb_build_array(jsonb_build_object('userId',creator_id,'label','Постановщик')) AS next_route
 FROM budgets WHERE budget>=0 AND budget<5000 AND
  (requester_id=creator_id OR current_step<>0 OR route<>jsonb_build_array(jsonb_build_object('userId',creator_id,'label','Постановщик')));

UPDATE approvals a SET route=c.next_route,current_step=0,action_revision=a.action_revision+1,
 state=CASE WHEN c.creator_id=c.requester_id THEN 'stale' ELSE 'pending' END,
 canceled_at=CASE WHEN c.creator_id=c.requester_id THEN now() END,deferred_until=NULL,
 clarification_question=NULL,clarification_answer=NULL,clarification_requested_at=NULL,clarification_answered_at=NULL,
 task_change=CASE WHEN a.task_change IS NOT NULL THEN jsonb_set(a.task_change,'{routeIssue}','false') END
FROM low_budget_routes_062 c WHERE a.id=c.id;
UPDATE outbox o SET withdrawn_at=now() FROM low_budget_routes_062 c
 WHERE o.withdrawn_at IS NULL AND o.dedupe_key LIKE 'approval:'||c.id::text||':%';
INSERT INTO task_events(id,task_id,kind,message,data)
 SELECT gen_random_uuid(),task_id,'approval_route_changed','Низкобюджетный перенос передан постановщику',
 jsonb_build_object('approvalId',id,'previousRoute',route,'route',next_route,'policy','low-budget-creator')
 FROM low_budget_routes_062;
INSERT INTO outbox(id,recipient_id,task_id,body,dedupe_key)
 SELECT gen_random_uuid(),creator_id,task_id,
 CASE WHEN creator_id=requester_id THEN 'Повторите перенос по задаче #'||task_id||': постановщик применяет его без дополнительного этапа.'
 ELSE 'Требуется ваше решение по переносу срока задачи #'||task_id||'. Для низкобюджетной задачи достаточно решения постановщика.' END,
 'approval:'||id::text||':low-budget-policy:'||(action_revision+1)::text
 FROM low_budget_routes_062;
