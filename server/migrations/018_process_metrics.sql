ALTER TABLE business_processes ADD COLUMN monitor_next_at timestamptz;
CREATE TABLE business_monitor_states (
 process_id uuid NOT NULL REFERENCES business_processes,
 subject_id text NOT NULL REFERENCES users,
 active_nodes text[] NOT NULL,
 PRIMARY KEY(process_id,subject_id)
);
