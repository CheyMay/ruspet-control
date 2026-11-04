CREATE TABLE bitrix_rest_gate (
 id integer PRIMARY KEY CHECK(id=1),
 portal text,
 next_at timestamptz NOT NULL DEFAULT 'epoch',
 last_success_at timestamptz
);
INSERT INTO bitrix_rest_gate(id) VALUES (1);
CREATE TABLE bitrix_task_snapshots (
 external_id bigint PRIMARY KEY,
 snapshot jsonb NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bitrix_task_links (
 task_id text PRIMARY KEY REFERENCES tasks,
 external_id bigint NOT NULL UNIQUE REFERENCES bitrix_task_snapshots,
 baseline jsonb NOT NULL,
 linked_version integer NOT NULL,
 conflict text,
 checked_at timestamptz
);
CREATE TABLE bitrix_task_activity (
 task_id text NOT NULL REFERENCES bitrix_task_links,
 kind text NOT NULL CHECK(kind IN ('comment','history')),
 external_id bigint NOT NULL,
 occurred_at timestamptz NOT NULL,
 author text NOT NULL,
 body text NOT NULL,
 PRIMARY KEY(task_id,kind,external_id)
);
