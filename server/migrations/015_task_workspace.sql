ALTER TABLE tasks ADD COLUMN company_id uuid;
CREATE INDEX tasks_company ON tasks(company_id,updated_at DESC) WHERE company_id IS NOT NULL;
CREATE INDEX task_events_by_task_date ON task_events(task_id,created_at DESC);
CREATE INDEX business_runs_task ON business_runs(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE task_templates (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL REFERENCES users,
 name text NOT NULL,
 content jsonb NOT NULL,
 shared boolean NOT NULL DEFAULT false,
 UNIQUE(owner_id,name)
);

ALTER TABLE business_processes ADD COLUMN enabled_since timestamptz;
CREATE TABLE task_acceptance_events (
 event_id uuid PRIMARY KEY REFERENCES task_events,
 task_id text NOT NULL REFERENCES tasks,
 occurred_at timestamptz NOT NULL,
 available_at timestamptz NOT NULL
);
CREATE INDEX task_acceptance_due ON task_acceptance_events(occurred_at,available_at);
CREATE TABLE business_quiet_runs (
 process_id uuid NOT NULL REFERENCES business_processes,
 company_id uuid NOT NULL,
 quiet_since timestamptz NOT NULL,
 PRIMARY KEY(process_id,company_id,quiet_since)
);

ALTER TABLE business_processes ADD COLUMN quiet_cursor uuid;
ALTER TABLE business_processes ADD COLUMN last_polled_at timestamptz;
