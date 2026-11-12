ALTER TABLE users ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE TABLE employee_profile_changes (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users,
 actor_id text NOT NULL REFERENCES users,
 before_snapshot jsonb NOT NULL,
 after_snapshot jsonb NOT NULL,
 reason text NOT NULL,
 related_changes jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_employee_profiles BEFORE UPDATE OR DELETE ON employee_profile_changes FOR EACH ROW EXECUTE FUNCTION immutable_record();
