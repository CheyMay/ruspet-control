CREATE TABLE IF NOT EXISTS companies (
 id uuid PRIMARY KEY,
 name text NOT NULL,
 tax_id text UNIQUE,
 status text NOT NULL CHECK(status IN ('prospect','active','former')),
 contact text NOT NULL,
 notes text NOT NULL,
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS company_status_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id uuid UNIQUE NOT NULL,
 company_id uuid NOT NULL REFERENCES companies,
 snapshot jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
