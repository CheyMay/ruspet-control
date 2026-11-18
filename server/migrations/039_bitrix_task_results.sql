CREATE TABLE bitrix_task_results (
 task_id text NOT NULL REFERENCES bitrix_task_links(task_id) ON DELETE CASCADE,
 external_id bigint NOT NULL,
 comment_id bigint,
 occurred_at timestamptz,
 author text NOT NULL,
 body text NOT NULL,
 files jsonb NOT NULL,
 PRIMARY KEY(task_id,external_id)
);
