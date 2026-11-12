CREATE TABLE bitrix_event_queue (
 external_id bigint PRIMARY KEY,
 event text NOT NULL CHECK(event IN ('ONTASKADD','ONTASKUPDATE','ONTASKDELETE')),
 revision bigint NOT NULL DEFAULT 1,
 received_at timestamptz NOT NULL DEFAULT now(),
 available_at timestamptz NOT NULL DEFAULT now()+interval '3 seconds',
 processed_at timestamptz,
 blocked boolean NOT NULL DEFAULT false,
 attempts integer NOT NULL DEFAULT 0,
 last_error text
);
CREATE INDEX bitrix_event_pending ON bitrix_event_queue(available_at) WHERE processed_at IS NULL AND NOT blocked;
