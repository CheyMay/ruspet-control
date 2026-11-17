ALTER TABLE bitrix_refresh_queue DROP CONSTRAINT bitrix_refresh_queue_state_check;
ALTER TABLE bitrix_refresh_queue ADD CONSTRAINT bitrix_refresh_queue_state_check
 CHECK(state IN ('pending','processing','blocked','failed','done','ignored'));
