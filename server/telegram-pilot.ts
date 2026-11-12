import {onboardingMessage,ensureLinkedAccount} from './telegram-onboarding.js';
import {ownerTimeReply,sendOwnerTimePrompt} from './owner-time.js';
import {TelegramRejected,type TelegramMethod} from './telegram-errors.js';
import {telegramLoginScreen} from './telegram-login.js';
import {telegramRequest} from './telegram-transport.js';
import {reportPdf} from './report-pdf.js';
import {getReport} from './service.js';
import {publicOrigin} from './report-content.js';
import {escapeHtml} from '../shared/report-links.js';
import {groupNotifications} from '../shared/notifications.js';
import {tickTaskReminders,pendingAlerts} from './reminders.js';
import {visibleTasks} from './service.js';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {pool,transaction} from './db.js';
import {assert,AppError} from './domain.js';
import {botClick,botText,botView,clearBotDraft,alertScreen,type BotScreen} from './bot.js';
import type {User} from '../shared/types.js';
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const token=async()=>process.env.TELEGRAM_BOT_TOKEN||(await readFile(process.env.TELEGRAM_BOT_TOKEN_FILE||'.local/telegram-token','utf8')).trim();
type Method=Exclude<TelegramMethod,'sendDocument'>;
async function call(method:Method,body:object={}):Promise<any>{
 let r:Response;try{r=await telegramRequest(`https://api.telegram.org/bot${await token()}/${method}`,body,method==='getUpdates'?35000:15000)}catch(e){const code=(e as {cause?:{code?:string}}).cause?.code;throw new AppError(502,code==='ECONNRESET'?'Соединение с Telegram обрывается. Нужен рабочий сетевой доступ к api.telegram.org.':'Telegram не отвечает. Проверьте сетевой доступ и настройку токена.')}
 let data:any;try{data=await r.json()}catch{throw new AppError(502,'Telegram вернул непонятный ответ.')}
 if(typeof data?.ok!=='boolean')throw new AppError(502,'Нет подтверждённого ответа Telegram. Проверьте доставку перед повтором.');
 if(!data.ok)throw new TelegramRejected(method,data,r.status);if(['sendMessage','editMessageText'].includes(method)&&!Number.isInteger(data.result?.message_id))throw new AppError(502,'Отправка не подтверждена Telegram.');return data.result;
}
let username:string|null=null,transportChecked=false;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function pilotStatus(user?:User){
 let configured=false;try{configured=!!await token()}catch{}
 const settings=(await pool.query('SELECT * FROM telegram_settings WHERE id=1')).rows[0],bound=(await pool.query('SELECT user_id,paired_at FROM telegram_binding ORDER BY id LIMIT 1')).rows[0]||null,runtime=(await pool.query('SELECT * FROM telegram_runtime WHERE id=1')).rows[0]||null;
 const delivery=(await pool.query("SELECT state,count(*)::int count FROM (SELECT d.state FROM telegram_delivery d JOIN telegram_binding b ON b.chat_id=d.chat_id WHERE ($1::text IS NULL OR b.user_id=$1) UNION ALL SELECT d.state FROM task_alert_deliveries d JOIN task_alerts a ON a.id=d.alert_id WHERE ($1::text IS NULL OR a.recipient_id=$1)) totals GROUP BY state",[user?.role==='admin'?null:user?.id||null])).rows;
 const ownBound=user?(await pool.query('SELECT user_id,paired_at FROM telegram_binding WHERE user_id=$1',[user.id])).rows[0]||null:bound;
 const runtimeName=runtime?.username||username;
 return {configured:configured||!!runtimeName,username:runtimeName,bound:ownBound,mode:settings.enabled?'personal-pilot':'disabled',settings,runtime,delivery};
}
export async function pairPilot(u:User,targetUserId=u.id){
 assert(targetUserId===u.id||u.role==='admin',403,'Другую учётную запись подключает администратор.');
 const target=(await pool.query('SELECT root_access FROM users WHERE id=$1',[targetUserId])).rows[0];
 assert(target,404,'Пользователь не найден.');
 assert(!target.root_access||targetUserId===u.id,403,'Владелец подключает свой Telegram сам.');
 const cfg=(await pool.query('SELECT * FROM telegram_settings WHERE id=1')).rows[0];assert(cfg.enabled,409,'Сначала включите личный пилот.');
 const cached=(await pool.query('SELECT username FROM telegram_runtime WHERE id=1')).rows[0]?.username;
 if(cached)username=cached;else{const me=await call('getMe');username=me.username;const info=await call('getWebhookInfo');assert(!info.url,409,'У бота уже настроен webhook. Он не изменён; polling не запущен.');}
 const code=randomBytes(20).toString('hex');await transaction(async db=>{await db.query('DELETE FROM telegram_pairings WHERE user_id=$1',[targetUserId]);await db.query("INSERT INTO telegram_pairings(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[digest(code),targetUserId])});
 return {url:`https://t.me/${username}?start=${code}`,expiresInMinutes:15};
}
export async function configurePilot(u:User,input:{enabled:boolean;delivery:boolean}){assert(u.role==='admin',403,'Подключение настраивает администратор.');await pool.query('UPDATE telegram_settings SET enabled=$1,delivery=$2,enabled_at=CASE WHEN $1 AND NOT enabled THEN now() ELSE enabled_at END WHERE id=1',[input.enabled,input.delivery]);}
let lastSend=0;const chatSend=new Map<string,number>();
async function send(chat:string,s:BotScreen,message?:number){const slot=Math.max(Date.now(),lastSend+80,(chatSend.get(chat)||0)+1050);lastSend=slot;chatSend.set(chat,slot);if(slot>Date.now())await sleep(slot-Date.now());if(s.document){const user=(await pool.query('SELECT u.* FROM telegram_binding b JOIN users u ON u.id=b.user_id WHERE b.chat_id=$1',[chat])).rows[0];assert(user,403,'Чат не привязан.');const report=await getReport(user,s.document.reportId),bytes=await reportPdf(report);const form=new FormData();form.set('chat_id',chat);form.set('caption',s.text.slice(0,1000));form.set('document',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),`ruspet-${report.day}.pdf`);let response:Response;try{response=await telegramRequest(`https://api.telegram.org/bot${await token()}/sendDocument`,form,35000)}catch{throw new AppError(502,'Не получено подтверждение отправки PDF. Проверьте чат перед повтором.');}const data=await response.json() as any;if(typeof data?.ok!=='boolean')throw new AppError(502,'Отправка PDF не подтверждена мостом.');if(!data.ok)throw new TelegramRejected('sendDocument',data,response.status);if(!Number.isInteger(data.result?.message_id))throw new AppError(502,'Нет подтверждения отправки PDF.');return data.result;}const body={chat_id:chat,text:s.text,...(s.format==='HTML'?{parse_mode:'HTML'}:{}),reply_markup:s.replyKeyboard==='contact'?{keyboard:[[{text:'Поделиться своим номером',request_contact:true}],[{text:'Не могу поделиться номером'}]],resize_keyboard:true,one_time_keyboard:true}:s.replyKeyboard==='remove'?{remove_keyboard:true}:{inline_keyboard:s.buttons.filter(r=>r.length).map(r=>r.map(b=>({text:b.text,callback_data:b.token}))).concat((s.links||[]).map(b=>[{text:b.text,url:b.url}] as any))},link_preview_options:{is_disabled:true}};if(message){try{return await call('editMessageText',{...body,message_id:message})}catch{}}return call('sendMessage',body)}
async function reply(chat:string,s:BotScreen,started:number,message?:number){
 const kind=s.document?'pdf':s.timingKind;
 let ok=false;
 try{await send(chat,s,message);ok=true;}finally{
  if(kind)try{await pool.query('INSERT INTO telegram_response_times(kind,ok,duration_ms) VALUES($1,$2,$3)',[kind,ok,Math.round(performance.now()-started)]);}catch{console.error('Telegram response timing unavailable');}
 }
}
export async function handlePilotUpdate(update:any){
 const started=performance.now();
 const c=update.callback_query,m=update.message||c?.message;if(!m||m.chat?.type!=='private')return;const chat=String(m.chat.id);
 const login=typeof m.text==='string'&&!c?m.text.match(/^\/start login_([A-Za-z0-9_-]{32})$/)?.[1]:null;
 const loginCallback=typeof c?.data==='string'?c.data.match(/^ql_([ad])_([A-Za-z0-9_-]{32})$/):null;
 if(login||loginCallback){
  const sender=c?.from||m.from;
  if(!sender||sender.is_bot||String(sender.id)!==chat||!(/^[1-9][0-9]{0,15}$/.test(chat)))return;
  const acknowledged=c?call('answerCallbackQuery',{callback_query_id:c.id}).catch(()=>{}):Promise.resolve();
  try{await reply(chat,await telegramLoginScreen(login||loginCallback![2],chat,loginCallback?(loginCallback[1]==='a'?'approve':'deny'):undefined),started,c?m.message_id:undefined);}
  catch(e){await send(chat,{text:e instanceof AppError?e.message:'Не удалось обработать вход. Обновите QR-код на сайте.',buttons:[]},c?m.message_id:undefined);}
  finally{await acknowledged;}return;
 }
 const code=typeof m.text==='string'&&!c?m.text.match(/^\/start ([a-f0-9]{40})$/)?.[1]:null;
 if(code&&m.from&&(m.from.is_bot||String(m.from.id)!==chat))return;
 if(code){
  const error=await transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(431008)');
   const p=(await db.query(`SELECT p.*,u.root_access FROM telegram_pairings p JOIN users u ON u.id=p.user_id
    WHERE p.token_hash=$1 AND p.expires_at>now() FOR UPDATE OF p`,[digest(code)])).rows[0];
   if(!p)return;
   if(p.root_access&&!m.from)return 'Откройте ссылку владельца в личном чате с ботом.';
   const old=(await db.query('SELECT chat_id,user_id FROM telegram_binding WHERE chat_id=$1 OR user_id=$2',[chat,p.user_id])).rows[0];
   if(old&&(old.chat_id!==chat||old.user_id!==p.user_id)){
    if(p.root_access)return 'Этот Telegram или аккаунт владельца уже привязан. Сначала отключите прежнюю привязку в «Доступах сотрудников» и запросите новую ссылку в планере.';
    return;
   }
   if(!old)await db.query('INSERT INTO telegram_binding(chat_id,user_id) VALUES($1,$2)',[chat,p.user_id]);
   await db.query('DELETE FROM telegram_registration_blocks WHERE chat_id=$1',[chat]);
   await db.query("UPDATE telegram_registrations SET state='cancelled' WHERE chat_id=$1 AND state IN ('name','contact','review')",[chat]);
   await db.query('DELETE FROM telegram_pairings WHERE token_hash=$1',[digest(code)]);
  });
  if(error){await reply(chat,{text:error,buttons:[]},started);return;}
 }
 const u=(await pool.query(`SELECT u.*,NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id)
  OR EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled) AS account_active
  FROM telegram_binding b JOIN users u ON u.id=b.user_id WHERE b.chat_id=$1`,[chat])).rows[0] as (User&{account_active:boolean})|undefined;
 if(u&&!u.account_active){if(c)await call('answerCallbackQuery',{callback_query_id:c.id,text:'Вход приостановлен администратором.'});return;}
 if(!u){if(!c){try{const response=await onboardingMessage(m);if(response)await reply(chat,response,started)}catch(e){await send(chat,{text:e instanceof AppError?e.message:'Не удалось подключить сотрудника. Попробуйте /start позже.',buttons:[]})}}return;}
 const ch='telegram:'+chat;
 if(c){const acknowledged=call('answerCallbackQuery',{callback_query_id:c.id}).catch(()=>{});try{await reply(chat,await botClick(u,ch,String(c.data)),started,m.message_id)}catch(e){await send(chat,{text:e instanceof AppError?e.message:'Не удалось завершить действие. Откройте задачу заново и проверьте историю.',buttons:(await botView(u,ch)).buttons})}finally{await acknowledged;}return}
 try{
  const timeReply=await ownerTimeReply(u,m);
  if(timeReply){await reply(chat,{text:timeReply,buttons:[]},started);return;}
  const text=String(m.text||'').trim();let response:BotScreen;
  if(code||/^\/(start|menu|status|cancel|task|today|tasks|inbox|reports|search)(\s|$)/.test(text))await clearBotDraft(u,ch);
  if(code||text==='/start')await ensureLinkedAccount(u);
  if(code||['/start','/menu','/status'].includes(text))response=await botView(u,ch);
  else if(text==='/cancel'){await pool.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);await pool.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op'='confirm'",[u.id,ch]);response=await botView(u,ch)}
  else if(/^\/task\s+\S+$/.test(text))response=await botView(u,ch,{op:'task',id:text.split(/\s/)[1]});
  else if(/^\/search\s+\S/.test(text))response=await botView(u,ch,{op:'search',query:text.slice(8).trim()});
  else if(['/today','/tasks','/inbox','/reports'].includes(text))response=await botView(u,ch,{op:({'/today':'day','/tasks':'tasks','/inbox':'inbox','/reports':'reports'} as Record<string,string>)[text]});
  else if(!text)response={text:'Пока принимаются текст и ссылки на материалы. Опишите результат и добавьте ссылку; загрузка файлов будет отдельным этапом.',buttons:[]};
  else response=await botText(u,ch,text,String(update.update_id));
  await reply(chat,response,started);
 }catch(e){await send(chat,{text:e instanceof AppError?e.message:'Не удалось обработать сообщение. Попробуйте ещё раз или откройте /menu.',buttons:[]})}
}
export async function pendingOutbox(user:User,enabledAt:string|null,pairedAt:string,limit:number|null=null,now=new Date()){
 const included=(await visibleTasks(user)).map(t=>t.id);
 return (await pool.query<{id:string;task_id:string|null;created_at:string;body:string}>(`SELECT o.* FROM outbox o
  WHERE o.withdrawn_at IS NULL AND o.read_at IS NULL AND o.recipient_id=$1 AND (o.task_id IS NULL OR o.task_id=ANY($4::text[]))
   AND o.created_at BETWEEN greatest($2::timestamptz,$3::timestamptz,$6::timestamptz-interval '2 days') AND $6
   AND NOT EXISTS(SELECT 1 FROM telegram_delivery d WHERE d.outbox_ids ? o.id::text)
  ORDER BY o.created_at LIMIT $5`,[user.id,enabledAt,pairedAt,included,limit,now.toISOString()])).rows;
}
export async function deliver(now=new Date()){
 const cfg=(await pool.query('SELECT * FROM telegram_settings WHERE id=1')).rows[0];if(!cfg.enabled||!cfg.delivery)return;
 await tickTaskReminders(now);
 const bindings=(await pool.query(`SELECT b.*,u.name,u.role,u.branch_id,u.position,COALESCE(p.telegram_digest,true) AS telegram_digest
  FROM telegram_binding b JOIN users u ON u.id=b.user_id LEFT JOIN notification_preferences p ON p.user_id=u.id
  WHERE NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id)
   OR EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)
  ORDER BY b.id`)).rows;
 for(const binding of bindings){
 const user={...binding,id:binding.user_id} as User;
 for(const alert of await pendingAlerts(user,now)){
  const slot=Math.floor((now.getTime()-Date.parse(alert.due_at))/1800000);
  const claimed=await pool.query("INSERT INTO task_alert_deliveries(alert_id,slot,state,created_at) VALUES($1,$2,'sending',$3) ON CONFLICT DO NOTHING",[alert.id,slot,now.toISOString()]);if(!claimed.rowCount)continue;
  try{const result=await send(binding.chat_id,await alertScreen(user,'telegram:'+binding.chat_id,alert));await pool.query("UPDATE task_alert_deliveries SET state='sent',message_id=$3 WHERE alert_id=$1 AND slot=$2",[alert.id,slot,result.message_id]);}
  catch(e){await pool.query('UPDATE task_alert_deliveries SET state=$3 WHERE alert_id=$1 AND slot=$2',[alert.id,slot,e instanceof TelegramRejected?'failed':'uncertain']);}
 }

 const hour=new Date(now.getTime()+10800000).getUTCHours();
 if(!binding.telegram_digest||hour<9||hour>=19)continue;
 const rows=await pendingOutbox(user,cfg.enabled_at,binding.paired_at,60,now);if(!rows.length)continue;
 const id=randomUUID(),slot=Math.floor(now.getTime()/1800000);
 const claim=await pool.query(`INSERT INTO telegram_delivery(id,chat_id,outbox_ids,state,batch_slot,created_at)
  SELECT $1,$2,$3,'sending',$4,$5 WHERE NOT EXISTS(
   SELECT 1 FROM telegram_delivery WHERE chat_id=$2 AND batch_slot IS NOT NULL
    AND created_at>$5::timestamptz-interval '30 minutes')
  ON CONFLICT DO NOTHING`,[id,binding.chat_id,JSON.stringify(rows.map(r=>r.id)),slot,now.toISOString()]);
 if(!claim.rowCount)continue;
 const groups=groupNotifications(rows);
 const lines=groups.slice(0,5).map(group=>escapeHtml(group[0].body.slice(0,160))+(group.length>1?' · ещё '+(group.length-1):''));
 if(groups.length>5)lines.push('Другие события доступны в «Уведомлениях».');
 try{
  const links=[{text:'Уведомления на сайте',url:new URL('/?view=notifications',publicOrigin()).href}];
  const next=await botView(user,'telegram:'+binding.chat_id,{op:'notice_menu'});
  const sent=await send(binding.chat_id,{text:'<b>РУСПЭТ · новые события</b>\n\n'+lines.join('\n\n'),format:'HTML',buttons:next.buttons,links});
  await pool.query("UPDATE telegram_delivery SET state='sent',message_id=$2,sent_at=now() WHERE id=$1",[id,sent.message_id]);
 }
 catch{await pool.query("UPDATE telegram_delivery SET state='uncertain',error='Нет подтверждения Telegram. Автоповтор остановлен, чтобы не дублировать возможную доставку.' WHERE id=$1",[id])}
 }
}
export function startPilot(){if(process.env.TELEGRAM_WORKER_DISABLED==='true')return ()=>{};let stopped=false,lastCleanup=0;const run=async()=>{while(!stopped){let lock;try{
  if(Date.now()-lastCleanup>3600000){await pool.query('DELETE FROM bot_buttons WHERE expires_at<now()');await pool.query('DELETE FROM bot_sessions WHERE expires_at<now()');await pool.query("DELETE FROM bot_inputs WHERE created_at<now()-interval '7 days'");await pool.query("DELETE FROM telegram_response_times WHERE created_at<now()-interval '7 days'");lastCleanup=Date.now()}
  const cfg=(await pool.query('SELECT enabled FROM telegram_settings WHERE id=1')).rows[0];if(!cfg.enabled){await sleep(3000);continue}
  lock=await pool.connect();if(!(await lock.query('SELECT pg_try_advisory_lock(431009) ok')).rows[0].ok){lock.release();lock=undefined;await sleep(3000);continue}
  if(!transportChecked){const me=await call('getMe'),info=await call('getWebhookInfo');assert(!info.url,409,'Есть webhook: polling не запущен.');username=me.username;await pool.query('INSERT INTO telegram_runtime(id,heartbeat_at,username) VALUES(1,now(),$1) ON CONFLICT(id) DO UPDATE SET username=excluded.username',[username]);transportChecked=true}
  await pool.query("UPDATE task_alert_deliveries SET state='uncertain' WHERE state='sending'");
  await pool.query("UPDATE telegram_delivery SET state='uncertain',error='Процесс прерван во время отправки. Требуется проверка доставки.' WHERE state='sending'");
  await pool.query('INSERT INTO telegram_runtime(id,heartbeat_at,error) VALUES(1,now(),NULL) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),error=NULL');
  await sendOwnerTimePrompt(new Date(),async(chat,text)=>{
   const message=await call('sendMessage',{chat_id:chat,text,reply_markup:{force_reply:true,input_field_placeholder:'7:30'}});
   return message.message_id;
  });
  const delivery=deliver().then(()=>({ok:true as const}),error=>({ok:false as const,error}));
  try{
  const offset=Number((await pool.query('SELECT next_update FROM telegram_cursor WHERE id=1')).rows[0].next_update);
  const updates=await call('getUpdates',{offset,timeout:20,limit:10,allowed_updates:['message','callback_query']});
  assert(Array.isArray(updates),502,'Telegram вернул неожиданный ответ при опросе.');
  await pool.query('UPDATE telegram_runtime SET last_poll_at=now(),heartbeat_at=now() WHERE id=1');
  for(const update of updates){if(stopped)break;const enabled=(await pool.query('SELECT enabled FROM telegram_settings WHERE id=1')).rows[0].enabled;if(!enabled)break;await handlePilotUpdate(update);await pool.query('UPDATE telegram_cursor SET next_update=$1 WHERE id=1',[update.update_id+1])}
  }finally{const result=await delivery;if(!result.ok)throw result.error;}
 }catch(e){transportChecked=false;if(!stopped){if(e instanceof TelegramRejected)console.error(e.message);try{await pool.query("INSERT INTO telegram_runtime(id,heartbeat_at,error) VALUES(1,now(),$1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),error=excluded.error",[e instanceof AppError?e.message:'Telegram недоступен. Повтор через 10 секунд.'])}catch{}await sleep(10000)}}finally{if(lock){try{await lock.query('SELECT pg_advisory_unlock(431009)')}finally{lock.release()}}}}};void run();return()=>{stopped=true};}
