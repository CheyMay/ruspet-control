ALTER TABLE users ADD COLUMN account_manage_access boolean NOT NULL DEFAULT false;

ALTER TABLE sessions ADD COLUMN authenticated_at timestamptz;
ALTER TABLE sessions ALTER COLUMN authenticated_at SET DEFAULT now();

-- Match the verified Nadya Rudneva profile even if the directory lists the surname first.
WITH candidate AS (
 SELECT min(id) AS id FROM users
 WHERE NOT root_access AND staff_undo_access
   AND regexp_split_to_array(translate(btrim(name), 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'), '\s+')
       @> ARRAY['надежда','руднева']
 HAVING count(*)=1
), granted AS (
 UPDATE users SET account_manage_access=true WHERE id=(SELECT id FROM candidate) RETURNING id
)
DELETE FROM telegram_pairings WHERE user_id IN (SELECT id FROM granted);
