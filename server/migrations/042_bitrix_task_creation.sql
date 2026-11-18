ALTER TABLE bitrix_operations DROP CONSTRAINT bitrix_operations_task_id_fkey;
ALTER TABLE bitrix_operations ADD FOREIGN KEY(task_id) REFERENCES tasks(id);
ALTER TABLE bitrix_operations ADD COLUMN created_external_id bigint;
CREATE UNIQUE INDEX bitrix_one_creation_per_task ON bitrix_operations(task_id) WHERE payload->>'kind'='created';
