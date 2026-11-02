ALTER TABLE tasks ADD COLUMN planned_start timestamptz;
ALTER TABLE tasks ADD COLUMN parent_id text;
UPDATE tasks SET planned_start=(source_fields->>'Планируемая дата начала')::timestamp AT TIME ZONE 'Europe/Moscow' WHERE source_fields->>'Планируемая дата начала' IS NOT NULL;
UPDATE tasks SET parent_id=source_fields->>'ID базовой задачи' WHERE source_fields->>'ID базовой задачи' IS NOT NULL;
UPDATE mock_provider_tasks p SET snapshot=to_jsonb(t) FROM tasks t WHERE t.id=p.id;
