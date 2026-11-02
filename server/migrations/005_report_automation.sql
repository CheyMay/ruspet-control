ALTER TABLE reports ADD COLUMN analysis jsonb;
CREATE INDEX report_archive ON reports(scope,kind,created_at DESC);
ALTER TABLE job_runs ADD COLUMN started_at timestamptz;
ALTER TABLE job_runs ADD COLUMN finished_at timestamptz;
ALTER TABLE job_runs ADD COLUMN retry_at timestamptz;
ALTER TABLE job_runs ADD COLUMN report_ids jsonb NOT NULL DEFAULT '[]';
CREATE TABLE automation_runtime(id integer PRIMARY KEY CHECK(id=1),heartbeat_at timestamptz NOT NULL);
