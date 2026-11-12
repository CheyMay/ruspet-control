ALTER TABLE outbox ADD COLUMN task_assignment boolean NOT NULL DEFAULT false;
ALTER TABLE outbox ADD COLUMN task_notice jsonb;
CREATE INDEX outbox_pending_task_assignments ON outbox(recipient_id,created_at,id)
 WHERE task_assignment AND withdrawn_at IS NULL AND read_at IS NULL;
CREATE INDEX outbox_web_task_notice ON outbox(recipient_id,created_at DESC) WHERE task_notice IS NOT NULL;
CREATE INDEX outbox_web_task_notice_assignments ON outbox USING gin ((task_notice->'assignmentIds')) WHERE task_notice IS NOT NULL;

ALTER TABLE telegram_settings ADD COLUMN task_delivery boolean NOT NULL DEFAULT false;
ALTER TABLE telegram_settings ADD COLUMN task_delivery_enabled_at timestamptz;

ALTER TABLE telegram_delivery ADD COLUMN task_notice jsonb;
CREATE INDEX telegram_delivery_task_notices ON telegram_delivery(chat_id,created_at DESC)
 WHERE task_notice IS NOT NULL;

CREATE TABLE web_push_subscriptions (
 endpoint text PRIMARY KEY,
 session_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 p256dh text NOT NULL,
 auth text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_push_user ON web_push_subscriptions(user_id);

CREATE TABLE web_push_deliveries (
 notification_id uuid NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
 endpoint text NOT NULL REFERENCES web_push_subscriptions(endpoint) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN ('sending','sent','failed','uncertain')),
 PRIMARY KEY(notification_id,endpoint)
);
