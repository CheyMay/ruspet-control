ALTER TABLE users ADD COLUMN staff_undo_access boolean NOT NULL DEFAULT false;
ALTER TABLE undo_actions ADD COLUMN undone_by text REFERENCES users(id);
ALTER TABLE undo_actions ADD COLUMN undo_reason text;
CREATE INDEX undo_task_history ON undo_actions(task_id,created_at DESC,id DESC);
