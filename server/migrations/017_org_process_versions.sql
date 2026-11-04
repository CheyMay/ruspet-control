CREATE TABLE org_reporting (
 employee_id text PRIMARY KEY REFERENCES users,
 manager_id text NOT NULL REFERENCES users,
 CHECK(employee_id<>manager_id)
);
CREATE INDEX org_reports_by_manager ON org_reporting(manager_id);
CREATE TABLE org_substitutions (
 id uuid PRIMARY KEY,
 manager_id text NOT NULL REFERENCES users,
 deputy_id text NOT NULL REFERENCES users,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(manager_id<>deputy_id AND starts_at<ends_at)
);
CREATE INDEX org_substitutions_deputy ON org_substitutions(deputy_id,starts_at,ends_at) WHERE revoked_at IS NULL;

CREATE TABLE business_versions (
 process_id uuid NOT NULL REFERENCES business_processes,
 revision integer NOT NULL,
 definition jsonb NOT NULL,
 published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 published_by text NOT NULL REFERENCES users,
 PRIMARY KEY(process_id,revision)
);
ALTER TABLE business_processes ADD COLUMN published_revision integer;
INSERT INTO business_versions(process_id,revision,definition,published_at,published_by)
 SELECT id,revision,definition,coalesce(enabled_since,created_at),actor_id FROM business_processes WHERE enabled;
UPDATE business_processes SET published_revision=revision WHERE enabled;

ALTER TABLE business_runs ADD COLUMN process_revision integer;
ALTER TABLE business_runs ADD COLUMN trace jsonb;
CREATE TABLE business_run_tasks (
 process_id uuid NOT NULL,
 event_id uuid NOT NULL,
 task_id text NOT NULL REFERENCES tasks,
 PRIMARY KEY(process_id,event_id,task_id),
 FOREIGN KEY(process_id,event_id) REFERENCES business_runs(process_id,event_id)
);
CREATE INDEX business_run_tasks_origin ON business_run_tasks(task_id);
