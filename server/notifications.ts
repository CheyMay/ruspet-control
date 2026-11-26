import {z} from 'zod';
import {businessDay} from '../shared/queues.js';
import {notificationTopics,type NotificationPreferences} from '../shared/notification-settings.js';
import {pool,type Db} from './db.js';
import {visibleTasks} from './service.js';
import {visiblePlanNotice} from './personal-calendar.js';
import {visibleAssignmentNotice,visibleControlNotice,visibleDeadlineNotice} from './pending-task-work.js';
import type {Notification,User} from '../shared/types.js';

export const pushInvitationPrefix='enable-push:';
export const needsPush=(userId:string)=>`NOT EXISTS(
 SELECT 1 FROM web_push_subscriptions s JOIN sessions a ON a.token_hash=s.session_hash AND a.expires_at>now()
 LEFT JOIN notification_preferences n ON n.user_id=s.user_id
 WHERE s.user_id=${userId} AND COALESCE(n.push_enabled,true))`;

export async function generatePushInvitations(now:Date){
 const day=businessDay(now);
 await pool.query(`UPDATE outbox o SET withdrawn_at=$1 WHERE o.withdrawn_at IS NULL
  AND o.dedupe_key LIKE 'enable-push:%' AND (o.dedupe_key NOT LIKE $2 OR NOT (${needsPush('o.recipient_id')}))`,
 [now.toISOString(),pushInvitationPrefix+day+':%']);
 const hour=new Date(+now+3*3600000).getUTCHours();
 if(hour<10||hour>=19)return;
 await pool.query(`INSERT INTO outbox(id,recipient_id,body,dedupe_key,created_at)
  SELECT gen_random_uuid(),u.id,$2,'enable-push:'||$1||':'||u.id,$3 FROM users u
  WHERE (EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)
   OR EXISTS(SELECT 1 FROM telegram_binding b WHERE b.user_id=u.id) AND NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id))
   AND ${needsPush('u.id')}
  ON CONFLICT(dedupe_key) DO NOTHING`,[day,'Разрешите push-уведомления РУСПЭТ, чтобы получать напоминания о задачах и сроках.',now.toISOString()]);
}

export async function personalNotifications(user:User,unread=false,db:Db=pool){
 const tasks=(await visibleTasks(user,db)).map(task=>task.id);
 return (await db.query<Notification>(`SELECT o.id,o.task_id,o.recipient_id,CASE WHEN o.task_assignment AND o.body LIKE 'У вас новая задача #%'
   THEN replace(o.body,'#'||o.task_id||' ·','#'||coalesce((SELECT l.external_id::text FROM bitrix_task_links l WHERE l.task_id=o.task_id),o.task_id)||' ·')
   ELSE o.body END AS body,o.state,o.created_at,o.read_at,o.task_notice,o.management_notice,o.task_assignment,o.dedupe_key LIKE 'staff-review:%' AS staff_review,
   o.dedupe_key LIKE 'enable-push:%' AS push_invitation,
   COALESCE((SELECT l.external_id::text FROM bitrix_task_links l WHERE l.task_id=o.task_id),o.task_id) AS task_number
  FROM outbox o WHERE recipient_id=$1 AND withdrawn_at IS NULL AND ${visibleAssignmentNotice} AND ${visiblePlanNotice}
   AND ${visibleControlNotice} AND ${visibleDeadlineNotice}
   AND (task_id IS NULL OR task_id=ANY($2)) AND (NOT $3 OR read_at IS NULL)
  ORDER BY created_at DESC,id DESC LIMIT 150`,[user.id,tasks,unread])).rows;
}

export async function readNotifications(user:User,ids:string[]){
 const tasks=(await visibleTasks(user)).map(task=>task.id);
 const result=await pool.query(`UPDATE outbox SET read_at=now()
  WHERE recipient_id=$1 AND id=ANY($2) AND read_at IS NULL AND withdrawn_at IS NULL
   AND (task_id IS NULL OR task_id=ANY($3))`,[user.id,ids,tasks]);
 return {count:result.rowCount??0};
}

const topics=z.partialRecord(z.enum(Object.keys(notificationTopics) as [keyof typeof notificationTopics,...(keyof typeof notificationTopics)[]]),z.boolean());
export const notificationPreferenceInput=z.object({
 telegramDigest:z.boolean(),pushEnabled:z.boolean().optional(),telegramTopics:topics.optional(),pushTopics:topics.optional()
});
export const approvalNoticeKind="split_part(o.dedupe_key,':',1) IN ('approval','clarify','clarification','clarification-answer','approved','approved-assignee','rejected','defer','review','review-return','review-accepted','approval-route','approval-route-closed')";
export const topicOn=(channel:'telegram'|'push',topic:keyof typeof notificationTopics)=>`COALESCE((p.${channel}_topics->>'${topic}')::boolean,true)`;

export async function notificationPreference(user:User):Promise<NotificationPreferences>{
 const result=await pool.query('SELECT telegram_digest,push_enabled,telegram_topics,push_topics FROM notification_preferences WHERE user_id=$1',[user.id]);
 const row=result.rows[0];
 return {telegramDigest:row?.telegram_digest??true,pushEnabled:row?.push_enabled??true,telegramTopics:row?.telegram_topics??{},pushTopics:row?.push_topics??{}};
}
export async function saveNotificationPreference(user:User,pref:z.infer<typeof notificationPreferenceInput>){
 await pool.query(`INSERT INTO notification_preferences AS p(user_id,telegram_digest,push_enabled,telegram_topics,push_topics)
  VALUES($1,$2,COALESCE($3,true),COALESCE($4,'{}'::jsonb),COALESCE($5,'{}'::jsonb))
  ON CONFLICT(user_id) DO UPDATE SET telegram_digest=$2,push_enabled=COALESCE($3,p.push_enabled),
  telegram_topics=COALESCE($4,p.telegram_topics),push_topics=COALESCE($5,p.push_topics)`,
  [user.id,pref.telegramDigest,pref.pushEnabled??null,pref.telegramTopics?JSON.stringify(pref.telegramTopics):null,pref.pushTopics?JSON.stringify(pref.pushTopics):null]);
 return notificationPreference(user);
}
