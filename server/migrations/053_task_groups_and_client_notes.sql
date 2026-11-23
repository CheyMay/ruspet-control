CREATE TABLE task_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id text NOT NULL REFERENCES users ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 name_key text NOT NULL,
 UNIQUE(user_id,name_key),
 UNIQUE(id,user_id)
);

CREATE TABLE task_group_items (
 user_id text NOT NULL REFERENCES users ON DELETE CASCADE,
 task_id text NOT NULL REFERENCES tasks ON DELETE CASCADE,
 group_id uuid NOT NULL,
 PRIMARY KEY(user_id,task_id),
 FOREIGN KEY(group_id,user_id) REFERENCES task_groups(id,user_id) ON DELETE CASCADE
);
CREATE INDEX task_group_items_task ON task_group_items(task_id);

CREATE TABLE client_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL,
 author_id text NOT NULL REFERENCES users,
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 20000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_notes_recent ON client_notes(company_id,created_at DESC,id DESC);
