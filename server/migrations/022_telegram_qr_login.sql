ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'password'
 CHECK(auth_method IN ('password','telegram'));
ALTER TABLE sessions ADD COLUMN telegram_binding_id integer REFERENCES telegram_binding(id) ON DELETE SET NULL;
CREATE TABLE telegram_login_requests (
 id uuid PRIMARY KEY,
 browser_hash text NOT NULL,
 approval_hash text NOT NULL UNIQUE,
 verification_code text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','consumed','cancelled')),
 user_id text REFERENCES users(id),
 binding_id integer REFERENCES telegram_binding(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 decided_at timestamptz,
 consumed_at timestamptz
);
CREATE INDEX telegram_login_browser ON telegram_login_requests(browser_hash) WHERE state IN ('pending','approved');
CREATE INDEX telegram_login_expiry ON telegram_login_requests(expires_at);
