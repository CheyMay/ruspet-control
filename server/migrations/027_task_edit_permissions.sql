CREATE TABLE task_edit_permissions (
 id uuid PRIMARY KEY,
 task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 requester_id text NOT NULL REFERENCES users(id),
 task_version integer NOT NULL CHECK (task_version > 0),
 reason text NOT NULL,
 state text NOT NULL CHECK (state IN ('pending','approved','rejected','used')),
 created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz,
 decided_by text REFERENCES users(id),
 decision_comment text NOT NULL DEFAULT '',
 used_at timestamptz
);

CREATE UNIQUE INDEX task_edit_permissions_current
 ON task_edit_permissions(task_id,task_version,requester_id)
 WHERE state IN ('pending','approved');
CREATE INDEX task_edit_permissions_lookup
 ON task_edit_permissions(task_id,task_version,requester_id,created_at DESC);

CREATE TABLE task_copy_receipts (
 actor_id text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 source_id text NOT NULL,
 task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 fingerprint text NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
