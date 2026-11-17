ALTER TABLE approval_hierarchy ADD COLUMN direct_assignee_ids text[]
 CHECK (direct_assignee_ids IS NULL OR cardinality(direct_assignee_ids) > 0);
