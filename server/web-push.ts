import {readFileSync} from 'node:fs';
import webpush from 'web-push';
import {z} from 'zod';
import {pool} from './db.js';
import {assert} from './domain.js';
import {publicOrigin} from './report-content.js';
import {generateWebTaskNotices} from './task-notices.js';
import type {ManagementNotice,User} from '../shared/types.js';

function pushHost(value:string){
 try{
  const url=new URL(value),host=url.hostname;
  return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&(
   ['fcm.googleapis.com','android.googleapis.com','updates.push.services.mozilla.com'].includes(host)||
   host.endsWith('.push.apple.com')||host.endsWith('.notify.windows.com'));
 }catch{return false;}
}
const endpoint=z.string().max(2048).refine(pushHost,'Этот сервис push-уведомлений пока не поддерживается.');
export const webPushSubscription=z.object({endpoint,keys:z.object({
 p256dh:z.string().regex(/^[A-Za-z0-9_-]+$/).length(87),
 auth:z.string().regex(/^[A-Za-z0-9_-]+$/).length(22)
})});
export const webPushEndpoint=z.object({endpoint});
type Subscription=z.infer<typeof webPushSubscription>;
type Keys={publicKey:string;privateKey:string;subject:string};
let keys:Keys|null|undefined;
function vapidKeys(){
 if(keys!==undefined)return keys;
 try{
  const subject=new URL('/',publicOrigin()).href;
  assert(subject.startsWith('https:'),500,'Для push нужен HTTPS.');
  const value=z.object({publicKey:z.string().length(87),privateKey:z.string().length(43)})
   .parse(JSON.parse(readFileSync(process.env.WEB_PUSH_KEYS_FILE||'.secrets/web-push.json','utf8')));
  keys={subject,...value};
 }catch{keys=null;}
 return keys;
}

export async function webPushStatus(user:User,sessionHash:string){
 const active=(await pool.query('SELECT 1 FROM web_push_subscriptions WHERE user_id=$1 AND session_hash=$2 LIMIT 1',[user.id,sessionHash])).rowCount;
 return {publicKey:vapidKeys()?.publicKey??null,active:!!active};
}
export async function saveWebPush(user:User,sessionHash:string,subscription:Subscription){
 assert(vapidKeys(),503,'Push-уведомления на сервере пока не настроены.');
 const {endpoint,keys}=subscription;
 const result=await pool.query(`INSERT INTO web_push_subscriptions(endpoint,session_hash,user_id,p256dh,auth)
  SELECT $1,token_hash,user_id,$4,$5 FROM sessions WHERE token_hash=$2 AND user_id=$3 AND expires_at>now()
  ON CONFLICT(endpoint) DO UPDATE SET session_hash=excluded.session_hash,user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth,
   created_at=CASE WHEN web_push_subscriptions.user_id<>excluded.user_id THEN now() ELSE web_push_subscriptions.created_at END`,
  [endpoint,sessionHash,user.id,keys.p256dh,keys.auth]);
 assert(result.rowCount,401,'Войдите в систему снова.');
 return {active:true};
}
export async function removeWebPush(user:User,endpoint:string){
 await pool.query('DELETE FROM web_push_subscriptions WHERE user_id=$1 AND endpoint=$2',[user.id,endpoint]);
 return {active:false};
}

export async function testDevicePush(user:User,sessionHash:string,endpoint:string){
 const config=vapidKeys();
 assert(config,503,'Push-уведомления на сервере пока не настроены.');
 const row=(await pool.query('SELECT p256dh,auth FROM web_push_subscriptions WHERE user_id=$1 AND session_hash=$2 AND endpoint=$3',
  [user.id,sessionHash,endpoint])).rows[0];
 assert(row,409,'Сначала включите уведомления на этом устройстве.');
 try{
  await webpush.sendNotification({endpoint,keys:row},JSON.stringify({body:'Уведомления на этом устройстве работают.',tag:'ruspet-push-test'}),
   {vapidDetails:config,TTL:60,urgency:'normal',timeout:6000});
 }catch(error){
  const status=(error as {statusCode?:number}).statusCode;
  if(status===404||status===410){
   await removeWebPush(user,endpoint);
   return {sent:false,expired:true};
  }
  assert(false,502,'Сервис уведомлений не подтвердил отправку. Попробуйте ещё раз.');
 }
 return {sent:true,expired:false};
}

type PushRow={id:string;endpoint:string;p256dh:string;auth:string;staff_review:boolean;management_notice:ManagementNotice|null;task_notice:{hasDeadlines:boolean;hasAssignments:boolean}|null};
export async function deliverWebPush(now=new Date()){
 const config=vapidKeys();
 if(!config)return;
 const rows=(await pool.query<PushRow>(`SELECT o.id,s.endpoint,s.p256dh,s.auth,o.task_notice,o.management_notice,o.dedupe_key LIKE 'staff-review:%' AS staff_review
  FROM outbox o JOIN web_push_subscriptions s ON s.user_id=o.recipient_id AND o.created_at>=s.created_at
  WHERE (o.task_notice IS NOT NULL OR o.management_notice IS NOT NULL OR o.dedupe_key LIKE 'staff-review:%') AND o.withdrawn_at IS NULL AND o.read_at IS NULL
   AND o.created_at BETWEEN $1::timestamptz-interval '10 minutes' AND $1
   AND (o.dedupe_key NOT LIKE 'staff-review:%' OR EXISTS(SELECT 1 FROM telegram_registrations r
    WHERE r.id::text=split_part(o.dedupe_key,':',2) AND r.state='review' AND r.expires_at>$1))
   AND NOT EXISTS(SELECT 1 FROM web_push_deliveries d WHERE d.notification_id=o.id AND d.endpoint=s.endpoint)
   AND (NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=s.user_id)
    OR EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=s.user_id AND a.enabled))
  ORDER BY o.created_at LIMIT 20`,[now.toISOString()])).rows;
 for(const row of rows){
  if(!pushHost(row.endpoint))continue;
  const claim=await pool.query(`INSERT INTO web_push_deliveries(notification_id,endpoint,state)
   SELECT $1,endpoint,'sending' FROM web_push_subscriptions WHERE endpoint=$2 AND p256dh=$3 AND auth=$4
    AND user_id=(SELECT recipient_id FROM outbox WHERE id=$1 AND read_at IS NULL AND withdrawn_at IS NULL)
   ON CONFLICT DO NOTHING`,[row.id,row.endpoint,row.p256dh,row.auth]);
  if(!claim.rowCount)continue;
  try{
   const hasAssignments=row.task_notice?.hasAssignments,hasDeadlines=row.task_notice?.hasDeadlines;
   const body=row.management_notice?'Поступило рабочее уведомление.':row.staff_review?'Поступила заявка на подключение.':hasAssignments&&hasDeadlines?'Проверьте сроки и новые задачи.':hasAssignments?'Вам поставили новые задачи.':'Проверьте крайние сроки задач.';
   await webpush.sendNotification({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}},
    JSON.stringify({body,tag:row.management_notice?'ruspet-management':row.staff_review?'ruspet-staff-review':hasAssignments?'ruspet-assignments':'ruspet-deadlines'}),
    {vapidDetails:config,TTL:600,urgency:'normal',timeout:6000});
   await pool.query("UPDATE web_push_deliveries SET state='sent' WHERE notification_id=$1 AND endpoint=$2",[row.id,row.endpoint]);
  }catch(error){
   const code=(error as {statusCode?:number}).statusCode;
   if(code===404||code===410)await pool.query('DELETE FROM web_push_subscriptions WHERE endpoint=$1 AND p256dh=$2 AND auth=$3',[row.endpoint,row.p256dh,row.auth]);
   else await pool.query('UPDATE web_push_deliveries SET state=$3 WHERE notification_id=$1 AND endpoint=$2',[row.id,row.endpoint,code?'failed':'uncertain']);
  }
 }
}

export function startWebTaskNotices(){
 let running=false;
 const run=async()=>{
  if(running)return;
  running=true;
  try{const now=new Date();await generateWebTaskNotices(now);await deliverWebPush(now);}
  catch{console.error('Web task notifications tick failed');}
  finally{running=false;}
 };
 const timer=setInterval(run,30000);timer.unref();void run();
 return ()=>clearInterval(timer);
}
