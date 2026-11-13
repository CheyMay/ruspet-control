ALTER TABLE users ADD COLUMN company_branch_access boolean NOT NULL DEFAULT false;

CREATE TABLE approval_hierarchy (
 id integer PRIMARY KEY CHECK(id=1),
 branch_manager_id text NOT NULL REFERENCES users(id),
 sales_head_id text NOT NULL REFERENCES users(id),
 CHECK(branch_manager_id<>sales_head_id)
);

CREATE TABLE task_approval_watch (
 task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_staff_review ON outbox(recipient_id,created_at)
 WHERE dedupe_key LIKE 'staff-review:%' AND read_at IS NULL AND withdrawn_at IS NULL;
