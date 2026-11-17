ALTER TABLE telegram_settings ADD COLUMN workday_delivery boolean NOT NULL DEFAULT false;
UPDATE telegram_settings SET workday_delivery=delivery;
