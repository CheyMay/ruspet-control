CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','director','branch_manager','sales_head','employee')), branch_id text NOT NULL, position text NOT NULL);
CREATE TABLE tasks (
 id text PRIMARY KEY, title text NOT NULL, description text NOT NULL, branch_id text NOT NULL,
 assignee_id text NOT NULL REFERENCES users, creator_id text NOT NULL REFERENCES users,
 deadline timestamptz, original_deadline timestamptz, planned_end timestamptz,
 status text NOT NULL CHECK(status IN ('active','review','completed')), priority text NOT NULL CHECK(priority IN ('normal','high')),
 code text NOT NULL, important boolean, customer_risk boolean,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), transfer_count integer NOT NULL DEFAULT 0 CHECK(transfer_count>=0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE task_events (id uuid PRIMARY KEY, task_id text REFERENCES tasks, actor_id text REFERENCES users, kind text NOT NULL, message text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE comments (id uuid PRIMARY KEY, task_id text NOT NULL REFERENCES tasks, author_id text NOT NULL REFERENCES users, body text NOT NULL, kind text NOT NULL DEFAULT 'comment', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE rule_versions (version serial PRIMARY KEY, config jsonb NOT NULL, author_id text REFERENCES users, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE findings (id uuid PRIMARY KEY, task_id text NOT NULL REFERENCES tasks, rule text NOT NULL, severity text NOT NULL, message text NOT NULL, status text NOT NULL CHECK(status IN ('open','resolved')), first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,rule));
CREATE TABLE control_requests (id uuid PRIMARY KEY, task_id text NOT NULL REFERENCES tasks, assignee_id text NOT NULL REFERENCES users, state text NOT NULL CHECK(state IN ('waiting','answered','escalated','resolved')), reason text, progress text, plan text, due_at timestamptz NOT NULL, reminders integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_active_control ON control_requests(task_id) WHERE state IN ('waiting','escalated','answered');
CREATE TABLE approvals (id uuid PRIMARY KEY, task_id text NOT NULL REFERENCES tasks, requester_id text NOT NULL REFERENCES users, type text NOT NULL CHECK(type IN ('deadline','completion')), reason text NOT NULL, plan text NOT NULL, proposed_deadline timestamptz, task_version integer NOT NULL, state text NOT NULL CHECK(state IN ('pending','approved','rejected','stale')), current_step integer NOT NULL DEFAULT 0, route jsonb NOT NULL, route_version integer NOT NULL REFERENCES rule_versions(version), deferred_until timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_pending_approval ON approvals(task_id) WHERE state='pending';
CREATE TABLE decisions (id uuid PRIMARY KEY, approval_id uuid NOT NULL REFERENCES approvals, actor_id text NOT NULL REFERENCES users, step_index integer NOT NULL, decision text NOT NULL CHECK(decision IN ('approve','reject','later')), comment text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_final_decision ON decisions(approval_id, step_index) WHERE decision IN ('approve','reject');
CREATE TABLE outbox (id uuid PRIMARY KEY, task_id text REFERENCES tasks, recipient_id text NOT NULL REFERENCES users, body text NOT NULL, dedupe_key text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','simulated')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE reports (id uuid PRIMARY KEY, day date NOT NULL, scope text NOT NULL, metrics jsonb NOT NULL, rows jsonb NOT NULL, rules_version integer NOT NULL REFERENCES rule_versions(version), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(day,scope));
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users, expires_at timestamptz NOT NULL);
CREATE TABLE mock_provider_tasks (id text PRIMARY KEY REFERENCES tasks, snapshot jsonb NOT NULL, revision integer NOT NULL DEFAULT 1);
CREATE INDEX task_scope ON tasks(branch_id,assignee_id);
CREATE INDEX event_task_time ON task_events(task_id,created_at DESC);
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Historical records are append-only'; END; $$;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON task_events FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_decisions BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_reports BEFORE UPDATE OR DELETE ON reports FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_rules BEFORE UPDATE OR DELETE ON rule_versions FOR EACH ROW EXECUTE FUNCTION immutable_record();
