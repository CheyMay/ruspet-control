CREATE TABLE login_accounts (
 username text PRIMARY KEY CHECK (username ~ '^[a-z0-9._-]{3,32}$'),
 user_id text NOT NULL REFERENCES users(id),
 password_hash text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_accounts_user ON login_accounts(user_id);
ALTER TABLE approvals ADD COLUMN clarification_question text;
ALTER TABLE approvals ADD COLUMN clarification_answer text;
ALTER TABLE approvals ADD COLUMN clarification_requested_at timestamptz;
ALTER TABLE approvals ADD COLUMN clarification_answered_at timestamptz;
ALTER TABLE decisions DROP CONSTRAINT decisions_decision_check;
ALTER TABLE decisions ADD CONSTRAINT decisions_decision_check CHECK(decision IN ('approve','reject','later','clarify'));
