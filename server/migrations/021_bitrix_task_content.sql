ALTER TABLE comments ADD COLUMN bitrix_origin boolean NOT NULL DEFAULT false;
ALTER TABLE comments ADD COLUMN revision integer NOT NULL DEFAULT 1;
CREATE TABLE bitrix_comment_links (
 comment_id uuid PRIMARY KEY REFERENCES comments,
 task_id text NOT NULL REFERENCES tasks,
 transport text NOT NULL CHECK(transport IN ('chat','legacy')),
 external_id bigint NOT NULL,
 remote_body text NOT NULL,
 local_body text NOT NULL,
 prefix text NOT NULL DEFAULT '',
 remote_deleted boolean NOT NULL DEFAULT false,
 UNIQUE(task_id,transport,external_id)
);
CREATE TABLE bitrix_comment_outbox (
 comment_id uuid PRIMARY KEY REFERENCES comments,
 revision integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','uncertain','conflict')),
 attempted_body text,
 attempted_revision integer,
 attempts integer NOT NULL DEFAULT 0,
 retry_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION queue_bitrix_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('ruspet.bitrix_inbound',true)='true' THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND NEW.bitrix_origin THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.body IS NOT DISTINCT FROM OLD.body AND NEW.withdrawn_at IS NOT DISTINCT FROM OLD.withdrawn_at THEN RETURN NEW; END IF;
  NEW.revision=OLD.revision+1;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER bitrix_comment_revision BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION queue_bitrix_comment();
CREATE FUNCTION enqueue_bitrix_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('ruspet.bitrix_inbound',true)='true' OR (TG_OP='INSERT' AND NEW.bitrix_origin) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.revision=OLD.revision THEN RETURN NEW; END IF;
 INSERT INTO bitrix_comment_outbox(comment_id,revision) VALUES(NEW.id,NEW.revision)
 ON CONFLICT(comment_id) DO UPDATE SET revision=excluded.revision,
 state=CASE WHEN bitrix_comment_outbox.state IN ('sending','uncertain') THEN bitrix_comment_outbox.state ELSE 'pending' END,
 retry_at=NULL,last_error=NULL;
 RETURN NEW;
END; $$;
CREATE TRIGGER bitrix_comment_enqueue AFTER INSERT OR UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION enqueue_bitrix_comment();
CREATE TABLE bitrix_comment_events (
 task_external_id bigint NOT NULL,
 transport text NOT NULL CHECK(transport IN ('chat','legacy')),
 external_id bigint NOT NULL,
 event text NOT NULL,
 revision bigint NOT NULL DEFAULT 1,
 processed_at timestamptz,
 available_at timestamptz NOT NULL DEFAULT now()+interval '3 seconds',
 attempts integer NOT NULL DEFAULT 0,
 last_error text,
 PRIMARY KEY(task_external_id,transport,external_id)
);
CREATE INDEX bitrix_comments_pending ON bitrix_comment_events(available_at) WHERE processed_at IS NULL;
CREATE TABLE bitrix_content_state (
 task_id text PRIMARY KEY REFERENCES bitrix_task_links,
 checked_at timestamptz,
 retry_at timestamptz,
 last_error text,
 chat_cursor bigint,
 history_cursor bigint
);
CREATE TABLE bitrix_comment_revisions (
 id bigserial PRIMARY KEY,
 comment_id uuid NOT NULL REFERENCES comments,
 body text NOT NULL,
 deleted boolean NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bitrix_task_content (
 task_id text NOT NULL REFERENCES bitrix_task_links,
 kind text NOT NULL CHECK(kind IN ('fields','checklist','files','results','history')),
 snapshot jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,kind)
);
ALTER TABLE bitrix_task_snapshots ADD COLUMN raw_snapshot jsonb;
ALTER TABLE bitrix_content_state ADD COLUMN phase integer NOT NULL DEFAULT 0;
ALTER TABLE bitrix_comment_links ADD COLUMN checked_at timestamptz;
CREATE TRIGGER immutable_bitrix_comment_revisions BEFORE UPDATE OR DELETE ON bitrix_comment_revisions FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TABLE bitrix_metadata (id integer PRIMARY KEY CHECK(id=1),fields jsonb NOT NULL,fetched_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE bitrix_content_ops (
 id uuid PRIMARY KEY,
 task_id text NOT NULL REFERENCES bitrix_task_links,
 actor_id text NOT NULL REFERENCES users,
 kind text NOT NULL CHECK(kind IN ('fields','checklist.add','checklist.update','checklist.delete','file.upload','file.detach','result.pin')),
 payload jsonb NOT NULL,
 baseline jsonb NOT NULL,
 dedupe_key text UNIQUE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','failed','uncertain','conflict','sent')),
 attempts integer NOT NULL DEFAULT 0,
 external_id bigint,
 retry_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bitrix_uploads (operation_id uuid PRIMARY KEY REFERENCES bitrix_content_ops ON DELETE CASCADE,content bytea NOT NULL);
ALTER TABLE bitrix_comment_links ADD COLUMN attachments jsonb NOT NULL DEFAULT '{}';
CREATE TABLE bitrix_field_map (
 local_key text PRIMARY KEY CHECK(local_key IN ('price','important','customer_risk')),
 external_code text NOT NULL UNIQUE CHECK(external_code ~ '^UF_[A-Z0-9_]+$')
);
ALTER TABLE tasks ADD COLUMN accomplice_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN auditor_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE bitrix_comment_outbox ADD COLUMN attempted_local_body text;
ALTER TABLE bitrix_comment_outbox ADD COLUMN attempted_prefix text;
ALTER TABLE bitrix_content_state ADD COLUMN files_cursor integer NOT NULL DEFAULT 0;
ALTER TABLE bitrix_content_state ADD COLUMN requested_at timestamptz;
ALTER TABLE bitrix_content_state ADD COLUMN errors jsonb NOT NULL DEFAULT '{}';
CREATE TABLE bitrix_im_state (
 id integer PRIMARY KEY CHECK(id=1),
 next_offset bigint NOT NULL DEFAULT 0,
 checked_at timestamptz,
 subscribed_at timestamptz,
 last_error text
);
INSERT INTO bitrix_im_state(id) VALUES(1);
ALTER TABLE bitrix_content_state ADD COLUMN chat_latest bigint NOT NULL DEFAULT 0;
ALTER TABLE task_sync_queue ADD COLUMN last_error text;
CREATE TABLE bitrix_reconcile_state (
 id integer PRIMARY KEY CHECK(id=1),
 since timestamptz NOT NULL DEFAULT now()-interval '1 day',
 cursor text NOT NULL DEFAULT '0',
 started_at timestamptz,
 next_at timestamptz NOT NULL DEFAULT now(),
 last_error text,
 finished_at timestamptz
);
INSERT INTO bitrix_reconcile_state(id) VALUES(1);
ALTER TABLE tasks ADD COLUMN bitrix_deleted_at timestamptz;
