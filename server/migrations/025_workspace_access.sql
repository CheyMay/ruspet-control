ALTER TABLE users ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE TABLE employee_profile_changes (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users,
 actor_id text NOT NULL REFERENCES users,
 before_snapshot jsonb NOT NULL,
 after_snapshot jsonb NOT NULL,
 reason text NOT NULL,
 related_changes jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_employee_profiles BEFORE UPDATE OR DELETE ON employee_profile_changes
 FOR EACH ROW EXECUTE FUNCTION immutable_record();

ALTER TABLE outbox ADD COLUMN read_at timestamptz;
CREATE INDEX outbox_personal_unread ON outbox(recipient_id,created_at DESC)
 WHERE read_at IS NULL AND withdrawn_at IS NULL;
ALTER TABLE telegram_delivery ADD COLUMN batch_slot bigint;
CREATE UNIQUE INDEX telegram_delivery_chat_slot ON telegram_delivery(chat_id,batch_slot)
 WHERE batch_slot IS NOT NULL;
CREATE TABLE notification_preferences (
 user_id text PRIMARY KEY REFERENCES users(id),
 telegram_digest boolean NOT NULL DEFAULT true
);
