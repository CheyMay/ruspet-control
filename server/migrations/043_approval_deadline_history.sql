ALTER TABLE approvals ADD COLUMN approved_deadline timestamptz;

CREATE TABLE bitrix_deadline_history (
 task_id text NOT NULL REFERENCES bitrix_task_links(task_id) ON DELETE CASCADE,
 external_id bigint NOT NULL,
 occurred_at timestamptz NOT NULL,
 from_deadline timestamptz,
 to_deadline timestamptz,
 author text NOT NULL,
 PRIMARY KEY(task_id,external_id)
);

CREATE INDEX bitrix_archive_task_deadlines ON bitrix_archive_objects(portal,parent_id)
 WHERE resource='task_history' AND raw->>'field'='DEADLINE' AND deleted_at IS NULL;