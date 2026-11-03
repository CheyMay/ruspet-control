CREATE TABLE management_observations (
 user_id text PRIMARY KEY REFERENCES users,
 started_at timestamptz,
 playful_nudge boolean NOT NULL DEFAULT false,
 last_nudge_at timestamptz
);
