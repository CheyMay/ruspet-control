import {pool,type Db} from './db.js';
import {visibleTasks} from './service.js';
import type {Notification,User} from '../shared/types.js';

export async function personalNotifications(user:User,unread=false,db:Db=pool){
 const tasks=(await visibleTasks(user,db)).map(task=>task.id);
 return (await db.query<Notification>(`SELECT id,task_id,recipient_id,body,state,created_at,read_at,task_notice,management_notice,dedupe_key LIKE 'staff-review:%' AS staff_review
  FROM outbox WHERE recipient_id=$1 AND withdrawn_at IS NULL AND NOT task_assignment
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

export async function notificationPreference(user:User){
 const result=await pool.query('SELECT telegram_digest FROM notification_preferences WHERE user_id=$1',[user.id]);
 return {telegramDigest:result.rows[0]?.telegram_digest??true};
}
export async function saveNotificationPreference(user:User,telegramDigest:boolean){
 await pool.query(`INSERT INTO notification_preferences(user_id,telegram_digest) VALUES($1,$2)
  ON CONFLICT(user_id) DO UPDATE SET telegram_digest=excluded.telegram_digest`,[user.id,telegramDigest]);
 return {telegramDigest};
}
