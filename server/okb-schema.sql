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
ALTER TABLE companies ADD COLUMN IF NOT EXISTS xlsx_source jsonb;
CREATE TABLE IF NOT EXISTS company_contacts (
 id uuid PRIMARY KEY,
 company_id uuid NOT NULL REFERENCES companies,
 author_id text NOT NULL,
 note text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS company_contacts_recent ON company_contacts(company_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS company_quiet_since ON companies ((coalesce(last_contact_at,created_at))) WHERE status='active';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS manager_id text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS manager_source text CHECK(manager_source IN ('manual','bitrix'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bitrix_portal text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bitrix_id bigint;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bitrix_manager_id bigint;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bitrix_snapshot jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bitrix_synced_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bitrix_deleted_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS company_bitrix_identity ON companies(bitrix_portal,bitrix_id) WHERE bitrix_id IS NOT NULL;
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_status_check;
ALTER TABLE companies ADD CONSTRAINT companies_status_check CHECK(status IN ('prospect','active','former','unclassified'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS kpp text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ogrn text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS legal_address text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS registry_status text;

CREATE TABLE IF NOT EXISTS company_people (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 name text NOT NULL,
 position text NOT NULL DEFAULT '',
 phone text NOT NULL DEFAULT '',
 email text NOT NULL DEFAULT '',
 notes text NOT NULL DEFAULT '',
 archived_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_people_by_company ON company_people(company_id,name) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS product_catalog (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sku text NOT NULL UNIQUE,
 name text NOT NULL,
 category text NOT NULL CHECK(category IN ('preform','cap','other')),
 specs text NOT NULL DEFAULT '',
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_responsibility_events (
 id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES companies,actor_id text,
 source text NOT NULL CHECK(source IN ('manual','bitrix')),before_value jsonb,after_value jsonb,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
