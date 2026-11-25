CREATE TABLE analytics_layouts (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 widths jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE workspace_labels (
 key text PRIMARY KEY,
 label text NOT NULL
);
