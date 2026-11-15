CREATE TABLE task_write_receipts (
 actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 fingerprint text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (actor_id, request_id)
);

CREATE INDEX task_write_receipts_created_at ON task_write_receipts (created_at);
