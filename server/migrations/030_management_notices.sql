ALTER TABLE outbox ADD COLUMN management_notice jsonb;
CREATE INDEX outbox_management_notices ON outbox(recipient_id,created_at)
 WHERE management_notice IS NOT NULL AND withdrawn_at IS NULL;

CREATE TABLE director_approval_batches (
 id uuid PRIMARY KEY,
 recipient_id text NOT NULL REFERENCES users,
 created_by text NOT NULL REFERENCES users,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE director_approval_batch_items (
 batch_id uuid NOT NULL REFERENCES director_approval_batches,
 approval_id uuid NOT NULL REFERENCES approvals,
 step integer NOT NULL,
 revision integer NOT NULL,
 PRIMARY KEY(approval_id,step,revision)
);
CREATE INDEX director_batch_items_by_batch ON director_approval_batch_items(batch_id);

CREATE TABLE inactivity_reviews (
 day date PRIMARY KEY,
 details jsonb NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now()
);
