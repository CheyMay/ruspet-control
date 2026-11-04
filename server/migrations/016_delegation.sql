ALTER TABLE tasks ADD COLUMN delegated_from_id text REFERENCES tasks;
CREATE INDEX tasks_delegated_from ON tasks(delegated_from_id) WHERE delegated_from_id IS NOT NULL;

ALTER TABLE business_processes ADD COLUMN revision integer NOT NULL DEFAULT 1;
