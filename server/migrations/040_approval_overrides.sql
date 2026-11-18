ALTER TABLE approval_hierarchy
 ADD COLUMN creator_approver_id text REFERENCES users(id),
 ADD COLUMN extra_deadline_assignee_ids text[] NOT NULL DEFAULT '{}',
 ADD COLUMN only_self_direct boolean NOT NULL DEFAULT false;
