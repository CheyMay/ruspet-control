ALTER TABLE users ADD COLUMN work_control_override boolean;

CREATE TABLE staff_rollout (
 id integer PRIMARY KEY CHECK(id=1),
 enabled boolean NOT NULL DEFAULT false
);
INSERT INTO staff_rollout(id) VALUES(1);

CREATE FUNCTION staff_normalized_label(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT lower(trim(translate(value,'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя')))
$$;

CREATE VIEW staff_work_groups AS
WITH directory AS (
 SELECT user_id,
  bool_or(staff_normalized_label(department) IN ('преформа','aquas','продажи')) AS sales,
  bool_or(staff_normalized_label(department) IN ('аналитики','бизнес-аналитика','аналитика')) AS analytics,
  bool_or(staff_normalized_label(department)='! рук филиала') AS leadership
 FROM staff_directory WHERE enabled AND user_id IS NOT NULL GROUP BY user_id
)
SELECT u.id AS user_id,u.work_control_override,
 array_remove(ARRAY[
  CASE WHEN d.sales OR p.title ~ '(^|[^а-яё])продаж[а-яё]*($|[^а-яё])' OR u.branch_id='Головной офис / Продажи' THEN 'sales' END,
  CASE WHEN d.analytics OR p.title ~ '(^|[^а-яё])аналитик[а-яё]*($|[^а-яё])' THEN 'analytics' END,
  CASE WHEN d.leadership OR u.role IN ('director','sales_head','branch_manager') OR
   p.title ~ '(^|, )((и[.] о[.] )?руководител[ья]|начальник|директор|главный бухгалтер|заместитель руководителя)($| )' OR
   EXISTS(SELECT 1 FROM org_reporting r WHERE r.manager_id=u.id) THEN 'leadership' END
 ], NULL) AS groups
FROM users u LEFT JOIN directory d ON d.user_id=u.id
CROSS JOIN LATERAL (SELECT staff_normalized_label(u.position) AS title) p
WHERE NOT u.root_access
 AND u.branch_id<>'Учебный доступ' AND p.title !~ '(^|[^а-яё])тестов[а-яё]*($|[^а-яё])';

CREATE FUNCTION staff_work_ids() RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN (SELECT enabled FROM staff_rollout WHERE id=1)
 THEN ARRAY(SELECT user_id FROM staff_work_groups WHERE coalesce(work_control_override,cardinality(groups)>0) ORDER BY user_id)
 ELSE (SELECT direct_assignee_ids FROM approval_hierarchy WHERE id=1) END
$$;
