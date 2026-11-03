CREATE TABLE undo_actions (
 id uuid PRIMARY KEY,task_id text NOT NULL REFERENCES tasks,actor_id text NOT NULL REFERENCES users,
 label text NOT NULL,before_state jsonb NOT NULL,after_state jsonb NOT NULL,supported boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),undone_at timestamptz
);
CREATE INDEX undo_actor_time ON undo_actions(actor_id,created_at DESC);
CREATE TABLE event_retractions(event_id uuid PRIMARY KEY REFERENCES task_events,undo_id uuid NOT NULL REFERENCES undo_actions,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE decision_retractions(decision_id uuid PRIMARY KEY REFERENCES decisions,undo_id uuid NOT NULL REFERENCES undo_actions,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER immutable_event_retractions BEFORE UPDATE OR DELETE ON event_retractions FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_decision_retractions BEFORE UPDATE OR DELETE ON decision_retractions FOR EACH ROW EXECUTE FUNCTION immutable_record();
-- Approvals are serialized by their row lock and checked state/step. The original
-- decision remains immutable when a compensating action reopens the stage.
DROP INDEX one_final_decision;
ALTER TABLE approvals ADD COLUMN canceled_at timestamptz;
ALTER TABLE approvals ADD COLUMN action_revision integer NOT NULL DEFAULT 1;
ALTER TABLE comments ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE comments ADD COLUMN approval_id uuid REFERENCES approvals;
ALTER TABLE outbox ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE task_submissions ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE task_submissions ADD COLUMN restored_from uuid REFERENCES task_submissions;
DROP INDEX one_open_submission;
CREATE UNIQUE INDEX one_open_submission ON task_submissions(task_id) WHERE state='review' AND withdrawn_at IS NULL;
CREATE OR REPLACE FUNCTION protect_submission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'submission history is append-only'; END IF;
 IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL AND (to_jsonb(OLD)-'withdrawn_at')=(to_jsonb(NEW)-'withdrawn_at') THEN RETURN NEW; END IF;
 IF OLD.withdrawn_at IS NOT NULL OR OLD.state<>'review' OR OLD.task_id<>NEW.task_id OR OLD.round<>NEW.round OR OLD.result<>NEW.result OR OLD.author_id<>NEW.author_id OR OLD.submitted_at<>NEW.submitted_at OR OLD.restored_from IS DISTINCT FROM NEW.restored_from THEN RAISE EXCEPTION 'submission content is immutable'; END IF;
 RETURN NEW; END $$;
ALTER TABLE task_sync_queue DROP CONSTRAINT task_sync_queue_state_check;
ALTER TABLE task_sync_queue ADD CONSTRAINT task_sync_queue_state_check CHECK(state IN ('pending','sent','failed','canceled'));
