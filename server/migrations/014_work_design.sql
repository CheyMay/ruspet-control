ALTER TABLE tasks ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(custom_fields)='array');

CREATE TABLE task_schedules (
 id uuid PRIMARY KEY,
 actor_id text NOT NULL REFERENCES users,
 template jsonb NOT NULL,
 frequency text NOT NULL CHECK(frequency IN ('daily','weekly','monthly')),
 every int NOT NULL CHECK(every BETWEEN 1 AND 30),
 starts_at timestamptz NOT NULL,
 next_at timestamptz NOT NULL,
 deadline_hours int CHECK(deadline_hours BETWEEN 1 AND 8760),
 enabled boolean NOT NULL DEFAULT true,
 last_task_id text REFERENCES tasks,
 last_error text,
 retry_at timestamptz
);
CREATE INDEX task_schedules_due ON task_schedules(next_at) WHERE enabled;

CREATE TABLE business_processes (
 id uuid PRIMARY KEY,
 actor_id text NOT NULL REFERENCES users,
 name text NOT NULL,
 definition jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business_runs (
 process_id uuid NOT NULL REFERENCES business_processes,
 event_id uuid NOT NULL,
 branch text NOT NULL CHECK(branch IN ('yes','no')),
 task_id text REFERENCES tasks,
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(process_id,event_id)
);

ALTER TABLE business_processes ADD COLUMN event_cursor bigint NOT NULL DEFAULT 0;
