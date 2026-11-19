ALTER TABLE tasks ADD COLUMN assignment_epoch integer NOT NULL DEFAULT 1;
CREATE FUNCTION bump_task_assignment_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
  NEW.assignment_epoch := OLD.assignment_epoch+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_assignment_epoch BEFORE UPDATE OF assignee_id ON tasks
 FOR EACH ROW EXECUTE FUNCTION bump_task_assignment_epoch();

CREATE TABLE personal_task_plans (
 task_id text NOT NULL REFERENCES tasks(id),
 assignment_epoch integer NOT NULL,
 user_id text NOT NULL REFERENCES users(id),
 requires_acceptance boolean NOT NULL DEFAULT false,
 accepted_at timestamptz,
 planned_at timestamptz,
 revision integer NOT NULL DEFAULT 0,
 PRIMARY KEY(task_id,assignment_epoch),
 CHECK (accepted_at IS NULL OR planned_at IS NOT NULL)
);
CREATE INDEX personal_plans_date ON personal_task_plans(user_id,planned_at) WHERE planned_at IS NOT NULL;
CREATE INDEX personal_plans_waiting ON personal_task_plans(user_id) WHERE requires_acceptance AND accepted_at IS NULL;

ALTER TABLE task_alerts ADD COLUMN personal_plan_epoch integer;
ALTER TABLE outbox ADD COLUMN personal_plan_alert_id uuid REFERENCES task_alerts(id);
CREATE INDEX personal_alerts_due ON task_alerts(due_at) WHERE personal_plan_epoch IS NOT NULL
 AND canceled_at IS NULL AND acknowledged_at IS NULL;

CREATE TABLE staff_work_days (
 user_id text NOT NULL REFERENCES users(id),
 work_date date NOT NULL,
 worked_minutes integer CHECK (worked_minutes BETWEEN 0 AND 1440),
 note text NOT NULL DEFAULT '' CHECK (char_length(note)<=2000),
 revision integer NOT NULL DEFAULT 1,
 PRIMARY KEY(user_id,work_date)
);
