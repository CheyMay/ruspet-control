ALTER TABLE approval_hierarchy ADD COLUMN creator_first boolean NOT NULL DEFAULT false;
UPDATE approval_hierarchy SET creator_first=true WHERE id=1;
