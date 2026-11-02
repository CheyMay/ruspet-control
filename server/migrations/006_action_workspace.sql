CREATE TABLE task_submissions(id uuid PRIMARY KEY,task_id text NOT NULL REFERENCES tasks,round integer NOT NULL,result text NOT NULL,author_id text NOT NULL REFERENCES users,state text NOT NULL CHECK(state IN ('review','returned','accepted')),reviewer_id text REFERENCES users,remark text,submitted_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,UNIQUE(task_id,round));
CREATE FUNCTION protect_submission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'submission history is append-only'; END IF;
 IF OLD.state<>'review' OR OLD.task_id<>NEW.task_id OR OLD.round<>NEW.round OR OLD.result<>NEW.result OR OLD.author_id<>NEW.author_id OR OLD.submitted_at<>NEW.submitted_at THEN RAISE EXCEPTION 'submission content is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER submission_history BEFORE UPDATE OR DELETE ON task_submissions FOR EACH ROW EXECUTE FUNCTION protect_submission();
CREATE UNIQUE INDEX one_open_submission ON task_submissions(task_id) WHERE state='review';
CREATE TABLE bot_sessions(actor_id text NOT NULL REFERENCES users,channel text NOT NULL,data jsonb NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(actor_id,channel));
CREATE TABLE bot_buttons(token text PRIMARY KEY,actor_id text NOT NULL REFERENCES users,channel text NOT NULL,payload jsonb NOT NULL,receipt jsonb,revoked boolean NOT NULL DEFAULT false,expires_at timestamptz NOT NULL);
CREATE TABLE bot_inputs(actor_id text NOT NULL REFERENCES users,channel text NOT NULL,input_id text NOT NULL,screen jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,channel,input_id));
CREATE INDEX bot_button_expiry ON bot_buttons(expires_at);
CREATE TABLE telegram_settings(id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,delivery boolean NOT NULL DEFAULT false,enabled_at timestamptz);
INSERT INTO telegram_settings(id) VALUES(1);
CREATE TABLE telegram_delivery(id uuid PRIMARY KEY,chat_id text NOT NULL,outbox_ids jsonb NOT NULL,state text NOT NULL CHECK(state IN ('sending','sent','failed','uncertain')),message_id bigint,error text,created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz);
CREATE TABLE telegram_runtime(id integer PRIMARY KEY CHECK(id=1),heartbeat_at timestamptz,error text);
