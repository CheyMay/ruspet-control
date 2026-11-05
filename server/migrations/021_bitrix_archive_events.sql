CREATE TABLE bitrix_method_budget (
 portal text NOT NULL,method text NOT NULL,operating double precision,reset_at timestamptz,
 next_at timestamptz NOT NULL DEFAULT 'epoch',last_error text,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(portal,method)
);
CREATE TABLE bitrix_archive_runs (
 id uuid PRIMARY KEY,portal text NOT NULL,state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','paused','captured','ready')),
 scope jsonb NOT NULL,capture_started_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX one_bitrix_initial_run ON bitrix_archive_runs(portal) WHERE state IN ('running','paused');
CREATE TABLE bitrix_archive_jobs (
 id bigserial PRIMARY KEY,run_id uuid NOT NULL REFERENCES bitrix_archive_runs,
 resource text NOT NULL,external_id text NOT NULL DEFAULT '0',cursor jsonb NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','blocked','failed')),
 attempts integer NOT NULL DEFAULT 0,retry_at timestamptz,error text,updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,resource,external_id)
);
CREATE INDEX bitrix_archive_jobs_pending ON bitrix_archive_jobs(run_id,id) WHERE state IN ('pending','failed');
CREATE TABLE bitrix_archive_objects (
 portal text NOT NULL,resource text NOT NULL,external_id text NOT NULL,parent_id text NOT NULL DEFAULT '0',
 raw jsonb NOT NULL,run_id uuid NOT NULL REFERENCES bitrix_archive_runs,deleted_at timestamptz,
 fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(portal,resource,external_id,parent_id)
);
CREATE TABLE bitrix_event_capture (
 id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,
 portal text,member_id text,mode text NOT NULL DEFAULT 'online' CHECK(mode IN ('online','offline')),
 verified_at timestamptz,started_at timestamptz,coverage jsonb NOT NULL DEFAULT '[]',project_companies boolean NOT NULL DEFAULT false
);
INSERT INTO bitrix_event_capture(id) VALUES(1);
CREATE TABLE bitrix_event_inbox (
 id bigserial PRIMARY KEY,portal text NOT NULL,dedupe_key text NOT NULL,event text NOT NULL,
 data jsonb NOT NULL,occurred_at timestamptz,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(portal,dedupe_key)
);
CREATE TABLE bitrix_refresh_queue (
 portal text NOT NULL,resource text NOT NULL,external_id text NOT NULL,
 generation bigint NOT NULL DEFAULT 1,done_generation bigint NOT NULL DEFAULT 0,delete_hint boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','blocked','failed','done')),
 retry_at timestamptz,error text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(portal,resource,external_id)
);
CREATE TABLE bitrix_offline_batches (
 process_id text PRIMARY KEY,portal text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','saved','acked')),
 message_ids text[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bitrix_pilot_selection (
 ordinal integer PRIMARY KEY CHECK(ordinal IN (1,2)),expected_name text NOT NULL
);
INSERT INTO bitrix_pilot_selection VALUES(1,'Виталий Шевченко'),(2,'Александр Чекальский');
CREATE TABLE bitrix_archive_blobs (
 portal text NOT NULL,external_id text NOT NULL,sha256 text NOT NULL,path text NOT NULL,bytes bigint NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(portal,external_id)
);
