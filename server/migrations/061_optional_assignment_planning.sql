-- Acknowledging an assignment unlocks work independently of a private calendar plan.
ALTER TABLE personal_task_plans DROP CONSTRAINT IF EXISTS personal_task_plans_check;
