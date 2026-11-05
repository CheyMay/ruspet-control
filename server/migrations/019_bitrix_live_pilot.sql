CREATE TABLE bitrix_field_catalog (code text PRIMARY KEY,description jsonb NOT NULL,fetched_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE bitrix_task_snapshots ADD COLUMN raw jsonb;
CREATE TABLE bitrix_user_links (user_id text PRIMARY KEY REFERENCES users,external_id bigint NOT NULL UNIQUE,verified_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE bitrix_live_config (
 id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,
 group_id bigint,price_field text,updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bitrix_live_config(id) VALUES(1);
ALTER TABLE bitrix_task_links ADD COLUMN live_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE bitrix_task_links ADD COLUMN live_baseline jsonb;
ALTER TABLE bitrix_task_links ADD COLUMN live_polled_at timestamptz;
CREATE TABLE bitrix_operations (
 sequence bigserial UNIQUE,event_id uuid PRIMARY KEY REFERENCES task_events,
 task_id text NOT NULL REFERENCES bitrix_task_links(task_id),payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','sent','failed','uncertain','blocked','canceled')),
 phase text,attempts integer NOT NULL DEFAULT 0,retry_at timestamptz,error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz
);
CREATE INDEX bitrix_operations_pending ON bitrix_operations(task_id,sequence) WHERE state NOT IN ('sent','canceled');
CREATE TABLE bitrix_pilot_members (
 user_id text PRIMARY KEY REFERENCES users,pilot_role text NOT NULL CHECK(pilot_role IN ('manager','leader'))
);
