ALTER TABLE login_accounts ADD COLUMN password_login boolean NOT NULL DEFAULT true;
CREATE TABLE staff_directory (
 id uuid PRIMARY KEY, source_key text NOT NULL UNIQUE, name text NOT NULL, name_key text NOT NULL,
 organisation text NOT NULL, department text NOT NULL, emails text[] NOT NULL, phones text[] NOT NULL,
 bitrix_id text, user_id text REFERENCES users, enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_registrations (
 id uuid PRIMARY KEY, chat_id text NOT NULL, entered_name text NOT NULL DEFAULT '',
 state text NOT NULL CHECK(state IN ('name','contact','review','approved','rejected','cancelled')),
 staff_id uuid REFERENCES staff_directory, user_id text REFERENCES users,
 own_contact_verified boolean NOT NULL DEFAULT false, phone_tail text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
 reviewed_by text REFERENCES users, decided_at timestamptz
);
CREATE UNIQUE INDEX telegram_registration_open ON telegram_registrations(chat_id) WHERE state IN ('name','contact','review');
CREATE TABLE telegram_registration_blocks(chat_id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
