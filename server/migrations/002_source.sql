ALTER TABLE tasks ADD COLUMN source_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN source_status text;
CREATE TABLE import_batches (id uuid PRIMARY KEY, file_name text NOT NULL, sheet_name text NOT NULL, source_hash text NOT NULL UNIQUE, row_count integer NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(), assumptions jsonb NOT NULL);
