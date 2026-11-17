ALTER TABLE telegram_settings ADD COLUMN deadline_delivery boolean NOT NULL DEFAULT false;
UPDATE telegram_settings SET deadline_delivery=task_delivery;
