CREATE TABLE company_task_epics (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 created_by text NOT NULL REFERENCES users,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 name_key text NOT NULL UNIQUE
);
CREATE TABLE company_task_epic_items (
 task_id text PRIMARY KEY REFERENCES tasks ON DELETE CASCADE,
 epic_id uuid NOT NULL REFERENCES company_task_epics ON DELETE CASCADE
);
CREATE INDEX company_task_epic_items_epic ON company_task_epic_items(epic_id);
