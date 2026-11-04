ALTER TABLE telegram_runtime ADD COLUMN last_poll_at timestamptz;
CREATE TABLE telegram_response_times (
  kind text NOT NULL CHECK(kind IN ('menu','task','pdf')),
  ok boolean NOT NULL,
  duration_ms integer NOT NULL CHECK(duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX telegram_response_times_created ON telegram_response_times(created_at);
CREATE INDEX telegram_delivery_outbox ON telegram_delivery USING gin(outbox_ids);
