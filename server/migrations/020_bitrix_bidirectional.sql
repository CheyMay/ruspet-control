CREATE TABLE bitrix_user_links (
 user_id text PRIMARY KEY REFERENCES users,
 external_id bigint NOT NULL UNIQUE CHECK(external_id>0)
);
ALTER TABLE bitrix_task_links ADD COLUMN outbound_error text;
ALTER TABLE bitrix_task_links ADD COLUMN outbound_retry_at timestamptz;
ALTER TABLE bitrix_task_links ADD COLUMN outbound_attempts integer NOT NULL DEFAULT 0;
CREATE TABLE bitrix_task_creations (
 task_id text PRIMARY KEY REFERENCES tasks,
 operation_key uuid NOT NULL UNIQUE,
 snapshot jsonb NOT NULL,
 external_id bigint UNIQUE,
 state text NOT NULL CHECK(state IN ('uncertain','confirming','linked')),
 attempted_at timestamptz NOT NULL DEFAULT now(),
 retry_at timestamptz,
 last_error text
);
CREATE TABLE bitrix_runtime (
 id integer PRIMARY KEY CHECK(id=1),
 heartbeat_at timestamptz NOT NULL,
 write_enabled boolean NOT NULL,
 create_enabled boolean NOT NULL,
 import_enabled boolean NOT NULL
);
