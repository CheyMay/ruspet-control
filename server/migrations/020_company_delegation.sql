ALTER TABLE task_submissions ADD COLUMN automatic boolean NOT NULL DEFAULT false;
ALTER TABLE task_submissions ADD COLUMN based_on_tasks text[] NOT NULL DEFAULT '{}';
CREATE TABLE delegation_review_checks (
 source_id text PRIMARY KEY REFERENCES tasks,trigger_task_id text NOT NULL REFERENCES tasks,
 requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE delegation_auto_reviews (
 id uuid PRIMARY KEY,source_id text NOT NULL REFERENCES tasks,
 event_id uuid NOT NULL REFERENCES task_events,submission_id uuid NOT NULL REFERENCES task_submissions,
 child_versions jsonb NOT NULL,before_state jsonb NOT NULL,after_state jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reverted_at timestamptz,reverted_by uuid REFERENCES undo_actions
);
CREATE INDEX delegation_auto_reviews_active ON delegation_auto_reviews(source_id) WHERE reverted_at IS NULL;
