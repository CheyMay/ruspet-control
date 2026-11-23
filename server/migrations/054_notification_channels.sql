ALTER TABLE notification_preferences ADD COLUMN push_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN telegram_topics jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE notification_preferences ADD COLUMN push_topics jsonb NOT NULL DEFAULT '{}'::jsonb;
