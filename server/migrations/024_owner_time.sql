ALTER TABLE users ADD COLUMN root_access boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT users_root_role CHECK (NOT root_access OR role='admin');
CREATE UNIQUE INDEX users_single_root ON users (root_access) WHERE root_access;

CREATE TABLE owner_time_days (
 user_id text NOT NULL REFERENCES users(id),
 work_date date NOT NULL,
 worked_minutes integer CHECK (worked_minutes BETWEEN 0 AND 1440),
 note text NOT NULL DEFAULT '' CHECK (char_length(note)<=2000),
 logged_at timestamptz,
 plan jsonb,
 PRIMARY KEY (user_id,work_date)
);
CREATE TABLE owner_time_preferences (
 user_id text PRIMARY KEY REFERENCES users(id),
 reminders boolean NOT NULL DEFAULT true
);
CREATE TABLE owner_time_prompts (
 user_id text NOT NULL REFERENCES users(id),
 work_date date NOT NULL,
 binding_id integer REFERENCES telegram_binding(id) ON DELETE SET NULL,
 state text NOT NULL CHECK (state IN ('sending','sent','unconfirmed')),
 message_id bigint,
 PRIMARY KEY (user_id,work_date),
 UNIQUE (binding_id,message_id)
);
CREATE TABLE owner_time_replies (
 binding_id integer NOT NULL REFERENCES telegram_binding(id) ON DELETE CASCADE,
 message_id bigint NOT NULL,
 PRIMARY KEY (binding_id,message_id)
);
