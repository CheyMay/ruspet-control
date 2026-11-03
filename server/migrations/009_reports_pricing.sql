ALTER TABLE tasks ADD COLUMN price numeric(14,2) CHECK(price>=0);
ALTER TABLE reports ADD COLUMN parameters jsonb NOT NULL DEFAULT '{}';
ALTER TABLE reports ADD COLUMN summary jsonb;
ALTER TABLE reports ADD COLUMN comparison_key text;
CREATE INDEX report_comparisons ON reports(scope,kind,comparison_key,created_at DESC);
CREATE INDEX report_event_period ON task_events(created_at,task_id);
CREATE TABLE work_fronts (
 user_id text NOT NULL REFERENCES users,day date NOT NULL,captured_at timestamptz NOT NULL,
 rows jsonb NOT NULL,PRIMARY KEY(user_id,day)
);
CREATE TRIGGER work_fronts_immutable BEFORE UPDATE OR DELETE ON work_fronts FOR EACH ROW EXECUTE FUNCTION immutable_record();
ALTER TABLE task_alerts DROP CONSTRAINT task_alerts_kind_check;
ALTER TABLE task_alerts ADD CONSTRAINT task_alerts_kind_check CHECK(kind IN ('task','morning','noon','evening'));
ALTER TABLE task_alerts ADD COLUMN report_id uuid REFERENCES reports;
ALTER TABLE task_alerts ADD COLUMN links jsonb NOT NULL DEFAULT '[]';
UPDATE automation_config SET enabled=true,morning='09:00',evening='19:01' WHERE id=1;
