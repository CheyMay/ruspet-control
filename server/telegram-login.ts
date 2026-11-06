import {createHash,randomBytes,randomInt,randomUUID} from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import {z} from 'zod';
import {pool,transaction,type Db} from './db.js';
import {assert} from './domain.js';
import type {User} from '../shared/types.js';
import type {BotScreen} from './bot.js';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const browserCookie='ruspet_qr_browser';
export const sessionCookieOptions=()=>({httpOnly:true,sameSite:'strict' as const,secure:!!process.env.PUBLIC_ORIGIN?.startsWith('https://'),maxAge:12*60*60*1000,path:'/'});
const browserOptions=()=>({...sessionCookieOptions(),path:'/api/auth',maxAge:10*60*1000});
export const readCookie=(req:express.Request,name:string)=>req.headers.cookie?.split(/;\s*/).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
export async function sessionUser(token:string){
 return (await pool.query(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token_hash=$1 AND s.expires_at>now() AND (s.auth_method<>'telegram' OR
   (EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)
   AND EXISTS(SELECT 1 FROM telegram_binding b WHERE b.id=s.telegram_binding_id AND b.user_id=u.id)
   AND EXISTS(SELECT 1 FROM telegram_settings WHERE id=1 AND enabled)))`,[digest(token)])).rows[0];
}
export async function clearBrowserLogin(req:express.Request,res:express.Response){
 const token=readCookie(req,browserCookie);
 if(token)await pool.query("UPDATE telegram_login_requests SET state='cancelled' WHERE browser_hash=$1 AND state IN ('pending','approved')",[digest(token)]);
 res.clearCookie(browserCookie,browserOptions());
}
async function availability(){
 const row=(await pool.query(`SELECT s.enabled,r.username,r.last_poll_at,r.error FROM telegram_settings s LEFT JOIN telegram_runtime r ON r.id=s.id WHERE s.id=1`)).rows[0];
 const available=!!(row?.enabled&&/^[a-zA-Z0-9_]{5,32}$/.test(row.username||'')&&row.last_poll_at&&Date.now()-Date.parse(row.last_poll_at)<180000&&!row.error);
 return {available,username:available?row.username:null};
}
const requestId=z.uuid();
const terminal=(row:any)=>Date.parse(row.expires_at)<=Date.now()?'expired':row.state;
async function browserRequest(db:Db,id:string,req:express.Request,lock=false){
 const token=readCookie(req,browserCookie);assert(token&&/^[a-f0-9]{64}$/.test(token),403,'Откройте QR-код в этом браузере заново.');
 const row=(await db.query('SELECT * FROM telegram_login_requests WHERE id=$1 AND browser_hash=$2'+(lock?' FOR UPDATE':''),[id,digest(token)])).rows[0];
 assert(row,404,'Запрос входа не найден. Обновите QR-код.');return row;
}
export function telegramLoginRouter(){
 const router=express.Router(),limits=new Map<string,{at:number;n:number}>();
 router.get('/config',async(_req,res)=>res.json({available:(await availability()).available}));
 router.post('/',async(req,res)=>{
  const now=Date.now();for(const [key,value]of limits)if(now-value.at>60000)limits.delete(key);
  const key=req.ip||'unknown',limit=limits.get(key)||{at:now,n:0};assert(limit.n<30&&limits.size<2000,429,'Слишком часто. Обновите QR через минуту.');limit.n++;limits.set(key,limit);
  const config=await availability();assert(config.available,503,'Вход через Telegram временно недоступен. Используйте логин и пароль.');
  const existing=readCookie(req,browserCookie),browser=existing&&/^[a-f0-9]{64}$/.test(existing)?existing:randomBytes(32).toString('hex');
  const id=randomUUID(),approval=randomBytes(24).toString('base64url'),code=String(randomInt(100000,1000000));
  const url=`https://t.me/${config.username}?start=login_${approval}`;
  const svg=await QRCode.toString(url,{type:'svg',errorCorrectionLevel:'M',margin:4,width:240});
  const expiresAt=await transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[digest(browser)]);
   await db.query("DELETE FROM telegram_login_requests WHERE expires_at<now()-interval '1 day'");
   await db.query("UPDATE telegram_login_requests SET state='cancelled' WHERE browser_hash=$1 AND state IN ('pending','approved')",[digest(browser)]);
   return (await db.query("INSERT INTO telegram_login_requests(id,browser_hash,approval_hash,verification_code,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 minutes') RETURNING expires_at",[id,digest(browser),digest(approval),code])).rows[0].expires_at;
  });
  res.cookie(browserCookie,browser,browserOptions());res.status(201).json({id,url,code,expiresAt,image:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')});
 });
 router.get('/:id',async(req,res)=>{
  const row=await browserRequest(pool,requestId.parse(req.params.id),req);
  res.json({state:terminal(row),expiresAt:row.expires_at});
 });
 router.delete('/:id',async(req,res)=>{
  const row=await browserRequest(pool,requestId.parse(req.params.id),req);
  await pool.query("UPDATE telegram_login_requests SET state='cancelled' WHERE id=$1 AND state IN ('pending','approved')",[row.id]);res.json({ok:true});
 });
 router.post('/:id/consume',async(req,res)=>{
  const session=randomBytes(32).toString('hex');
  const user=await transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(431008)');
   const row=await browserRequest(db,requestId.parse(req.params.id),req,true);
   assert(terminal(row)==='approved',409,'Вход ещё не подтверждён или QR-код уже использован.');
   const u=(await db.query(`SELECT u.* FROM users u JOIN telegram_binding b ON b.user_id=u.id
    WHERE b.id=$1 AND u.id=$2 AND EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)
    AND EXISTS(SELECT 1 FROM telegram_settings WHERE id=1 AND enabled)`,[row.binding_id,row.user_id])).rows[0];
   assert(u,403,'Доступ отключён или Telegram отвязан. Обратитесь к администратору.');
   const old=readCookie(req,'ruspet_session');if(old)await db.query('DELETE FROM sessions WHERE token_hash=$1',[digest(old)]);
   await db.query("INSERT INTO sessions(token_hash,user_id,expires_at,auth_method,telegram_binding_id) VALUES($1,$2,now()+interval '12 hours','telegram',$3)",[digest(session),u.id,row.binding_id]);
   await db.query("UPDATE telegram_login_requests SET state='consumed',consumed_at=now() WHERE id=$1",[row.id]);
   await db.query("INSERT INTO task_events(id,task_id,actor_id,kind,message,data) VALUES($1,NULL,$2,'telegram_qr_login','Вход через Telegram',$3)",[randomUUID(),u.id,JSON.stringify({requestId:row.id})]);return u;
  });
  res.cookie('ruspet_session',session,sessionCookieOptions());res.json({user});
 });
 return router;
}

/** Only genuine private-chat sender IDs are accepted; usernames never identify an account. */
export async function telegramLoginScreen(approval:string,telegramId:string,decision?:'approve'|'deny'):Promise<BotScreen>{
 assert(/^[A-Za-z0-9_-]{32}$/.test(approval),400,'Некорректный запрос входа.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  const row=(await db.query('SELECT * FROM telegram_login_requests WHERE approval_hash=$1 FOR UPDATE',[digest(approval)])).rows[0];
  assert(row&&Date.parse(row.expires_at)>Date.now(),410,'QR-код устарел. Обновите его на странице входа.');
  const binding=(await db.query(`SELECT b.*,u.name FROM telegram_binding b JOIN users u ON u.id=b.user_id
   WHERE b.chat_id=$1 AND EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=b.user_id AND a.enabled)
   AND EXISTS(SELECT 1 FROM telegram_settings WHERE id=1 AND enabled)`,[telegramId])).rows[0];
  assert(binding,403,'Для входа администратор должен привязать ваш Telegram к сотруднику с активным входом в панель.');
  assert(!row.binding_id||row.binding_id===binding.id,403,'Этот QR-код уже открыт другим сотрудником. Обновите код на сайте.');
  if(row.state!=='pending')return {text:row.state==='approved'||row.state==='consumed'?'Вход уже подтверждён. Вернитесь в браузер.':'Этот запрос входа отменён. Обновите QR-код на сайте.',buttons:[]};
  if(decision){
   // A confirmation must refer to the same binding that opened the screen.
   assert(row.binding_id===binding.id,409,'Сначала откройте QR-код заново.');
   await db.query('UPDATE telegram_login_requests SET state=$2,decided_at=now() WHERE id=$1',[row.id,decision==='approve'?'approved':'denied']);
   return {text:decision==='approve'?'Вход подтверждён. Вернитесь в браузер — там откроется ваша учётная запись.':'Вход отклонён.',buttons:[]};
  }
  await db.query('UPDATE telegram_login_requests SET binding_id=$2,user_id=$3 WHERE id=$1',[row.id,binding.id,binding.user_id]);
  const origin=process.env.PUBLIC_ORIGIN?new URL(process.env.PUBLIC_ORIGIN).origin:'РУСПЭТ';
  return {text:`Войти в РУСПЭТ?\n\nСотрудник: ${binding.name}\nСайт: ${origin}\nКод проверки: ${row.verification_code}\n\nСравните код с экраном браузера. Подтверждайте только вход, который начали сами. QR действует 2 минуты.`,buttons:[[{text:'Подтвердить вход',token:'ql_a_'+approval}],[{text:'Отклонить',token:'ql_d_'+approval}]]};
 });
}

export async function setTelegramBinding(actor:User,userId:string,telegramId:string|null){
 assert(actor.role==='admin',403,'Telegram сотрудника настраивает администратор.');
 if(telegramId!==null)assert(/^[1-9][0-9]{0,15}$/.test(telegramId)&&BigInt(telegramId)<=4503599627370495n,400,'Нужен числовой Telegram ID личного аккаунта, без @.');
 await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');
  assert((await db.query('SELECT 1 FROM users WHERE id=$1',[userId])).rowCount,404,'Сотрудник не найден.');
  const old=(await db.query('SELECT * FROM telegram_binding WHERE user_id=$1',[userId])).rows[0];
  if(telegramId!==null){
   assert(!old||old.chat_id===telegramId,409,'Сначала отключите прежнюю привязку сотрудника.');
   const occupied=(await db.query('SELECT user_id FROM telegram_binding WHERE chat_id=$1',[telegramId])).rows[0];
   assert(!occupied||occupied.user_id===userId,409,'Этот Telegram уже привязан к другому сотруднику.');
   if(!old)await db.query('INSERT INTO telegram_binding(chat_id,user_id) VALUES($1,$2)',[telegramId,userId]);
  }else if(old){
   await db.query("DELETE FROM sessions WHERE auth_method='telegram' AND telegram_binding_id=$1",[old.id]);
   await db.query('DELETE FROM telegram_binding WHERE id=$1',[old.id]);
   await db.query("UPDATE telegram_login_requests SET state='cancelled' WHERE user_id=$1 AND state IN ('pending','approved')",[userId]);
   await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[userId,'telegram:'+old.chat_id]);
   await db.query('UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2',[userId,'telegram:'+old.chat_id]);
  }
  await db.query('DELETE FROM telegram_pairings WHERE user_id=$1',[userId]);
  await db.query("INSERT INTO task_events(id,task_id,actor_id,kind,message,data) VALUES($1,NULL,$2,$3,'Изменена привязка Telegram',$4)",[randomUUID(),actor.id,telegramId?'telegram_linked':'telegram_unlinked',JSON.stringify({userId,telegramId})]);
 });
 return {ok:true};
}
