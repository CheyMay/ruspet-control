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

ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE companies c SET created_at=COALESCE((SELECT min(e.occurred_at) FROM company_status_events e WHERE e.company_id=c.id),c.updated_at)
 WHERE c.created_at IS NULL;
ALTER TABLE companies ALTER COLUMN created_at SET DEFAULT clock_timestamp(),ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_contact_at timestamptz;
CREATE TABLE IF NOT EXISTS company_contacts (
 id uuid PRIMARY KEY,
 company_id uuid NOT NULL REFERENCES companies,
 author_id text NOT NULL,
 note text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS company_contacts_recent ON company_contacts(company_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS company_quiet_since ON companies ((coalesce(last_contact_at,created_at))) WHERE status='active';
