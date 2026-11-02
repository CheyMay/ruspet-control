import {visibleTasks} from './service.js';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {pool,transaction} from './db.js';
import {assert,AppError} from './domain.js';
import {botClick,botText,botView,clearBotDraft,type BotScreen} from './bot.js';
import type {User} from '../shared/types.js';
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const token=async()=>process.env.TELEGRAM_BOT_TOKEN||(await readFile('.local/telegram-token','utf8')).trim();
type Method='getMe'|'getWebhookInfo'|'getUpdates'|'sendMessage'|'editMessageText'|'answerCallbackQuery';
async function call(method:Method,body:object={}):Promise<any>{
 let r:Response;try{r=await fetch(`https://api.telegram.org/bot${await token()}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(method==='getUpdates'?30000:12000)})}catch(e){const code=(e as {cause?:{code?:string}}).cause?.code;throw new AppError(502,code==='ECONNRESET'?'Соединение с Telegram обрывается. Нужен рабочий сетевой доступ к api.telegram.org.':'Telegram не отвечает. Проверьте сетевой доступ и настройку токена.')}
 let data:any;try{data=await r.json()}catch{throw new AppError(502,'Telegram вернул непонятный ответ.')}
 if(!data.ok)throw new AppError(502,data.error_code===401?'Telegram отклонил токен. Нужен действующий токен бота.':data.error_code===409?'Бота уже обслуживает другой процесс или webhook. Остановите конфликтующее подключение.':data.error_code===429?'Telegram ограничил частоту запросов. Повторите позже.':'Telegram отклонил запрос. Код: '+String(data.error_code||r.status));return data.result;
}
let username:string|null=null,transportChecked=false;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function pilotStatus(){
 let configured=false;try{configured=!!await token()}catch{}
 const settings=(await pool.query('SELECT * FROM telegram_settings WHERE id=1')).rows[0],bound=(await pool.query('SELECT user_id,paired_at FROM telegram_binding WHERE id=1')).rows[0]||null,runtime=(await pool.query('SELECT * FROM telegram_runtime WHERE id=1')).rows[0]||null;
 const delivery=(await pool.query('SELECT state,count(*)::int count FROM telegram_delivery GROUP BY state')).rows;
 return {configured,username,bound,mode:settings.enabled?'personal-pilot':'disabled',settings,runtime,delivery};
}
export async function pairPilot(u:User){
 assert(u.role==='admin',403,'Подключение настраивает администратор.');const cfg=(await pool.query('SELECT * FROM telegram_settings WHERE id=1')).rows[0];assert(cfg.enabled,409,'Сначала включите личный пилот.');
 const me=await call('getMe');username=me.username;const info=await call('getWebhookInfo');assert(!info.url,409,'У бота уже настроен webhook. Он не изменён; личный polling не запущен.');
 const code=randomBytes(20).toString('hex');await transaction(async db=>{await db.query('DELETE FROM telegram_pairings');await db.query("INSERT INTO telegram_pairings(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[digest(code),u.id])});
 return {url:`https://t.me/${username}?start=${code}`,expiresInMinutes:15};
}
export async function configurePilot(u:User,input:{enabled:boolean;delivery:boolean}){assert(u.role==='admin',403,'Подключение настраивает администратор.');await pool.query('UPDATE telegram_settings SET enabled=$1,delivery=$2,enabled_at=CASE WHEN $1 AND NOT enabled THEN now() ELSE enabled_at END WHERE id=1',[input.enabled,input.delivery]);}
async function send(chat:string,s:BotScreen,message?:number){const body={chat_id:chat,text:s.text,reply_markup:{inline_keyboard:s.buttons.filter(r=>r.length).map(r=>r.map(b=>({text:b.text,callback_data:b.token})))},link_preview_options:{is_disabled:true}};if(message){try{return await call('editMessageText',{...body,message_id:message})}catch{}}return call('sendMessage',body)}
export async function handlePilotUpdate(update:any){
 const c=update.callback_query,m=update.message||c?.message;if(!m||m.chat?.type!=='private')return;const chat=String(m.chat.id);
 const code=typeof m.text==='string'&&!c?m.text.match(/^\/start ([a-f0-9]{40})$/)?.[1]:null;
 if(code){await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(431008)');const p=(await db.query('SELECT * FROM telegram_pairings WHERE token_hash=$1 AND expires_at>now() FOR UPDATE',[digest(code)])).rows[0];if(!p)return;const old=(await db.query('SELECT chat_id FROM telegram_binding WHERE id=1')).rows[0];if(old&&old.chat_id!==chat)return;await db.query('INSERT INTO telegram_binding(id,chat_id,user_id) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,paired_at=now()',[chat,p.user_id]);await db.query('DELETE FROM telegram_pairings WHERE token_hash=$1',[digest(code)])})}
 const u=(await pool.query('SELECT u.* FROM telegram_binding b JOIN users u ON u.id=b.user_id WHERE b.id=1 AND b.chat_id=$1',[chat])).rows[0] as User|undefined;if(!u)return;
 const ch='telegram:'+chat;
 if(c){try{await call('answerCallbackQuery',{callback_query_id:c.id})}catch{};try{await send(chat,await botClick(u,ch,String(c.data)),m.message_id)}catch(e){await send(chat,{text:e instanceof AppError?e.message:'Не удалось завершить действие. Откройте задачу заново и проверьте историю.',buttons:(await botView(u,ch)).buttons})}return}
 try{
  const text=String(m.text||'').trim();let response:BotScreen;
  if(code||/^\/(start|menu|status|cancel|task|today|tasks|inbox|reports)(\s|$)/.test(text))await clearBotDraft(u,ch);
  if(code||['/start','/menu','/status'].includes(text))response=await botView(u,ch);
  else if(text==='/cancel'){await pool.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);await pool.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op'='confirm'",[u.id,ch]);response=await botView(u,ch)}
  else if(/^\/task\s+\S+$/.test(text))response=await botView(u,ch,{op:'task',id:text.split(/\s/)[1]});
  else if(['/today','/tasks','/inbox','/reports'].includes(text))response=await botView(u,ch,{op:({'/today':'day','/tasks':'tasks','/inbox':'inbox','/reports':'reports'} as Record<string,string>)[text]});
  else if(!text)response={text:'Пока принимаются текст и ссылки на материалы. Опишите результат и добавьте ссылку; загрузка файлов будет отдельным этапом.',buttons:[]};
  else response=await botText(u,ch,text,String(update.update_id));
  await send(chat,response);
 }catch(e){await send(chat,{text:e instanceof AppError?e.message:'Не удалось обработать сообщение. Попробуйте ещё раз или откройте /menu.',buttons:[]})}
}
async function deliver(){
 const cfg=(await pool.query('SELECT * FROM telegram_settings WHERE id=1')).rows[0];if(!cfg.enabled||!cfg.delivery)return;
 const binding=(await pool.query('SELECT b.*,u.name,u.role,u.branch_id,u.position FROM telegram_binding b JOIN users u ON u.id=b.user_id WHERE b.id=1')).rows[0];if(!binding)return;
 const included=(await visibleTasks({...binding,id:binding.user_id} as User)).map(t=>t.id);
 const rows=(await pool.query("SELECT o.* FROM outbox o WHERE o.recipient_id=$1 AND (o.task_id IS NULL OR o.task_id=ANY($4::text[])) AND o.created_at>=greatest($2::timestamptz,$3::timestamptz) AND NOT EXISTS(SELECT 1 FROM telegram_delivery d WHERE d.outbox_ids ? o.id::text) ORDER BY o.created_at LIMIT 12",[binding.user_id,cfg.enabled_at,binding.paired_at,included])).rows;if(!rows.length)return;
 const id=randomUUID();await pool.query("INSERT INTO telegram_delivery(id,chat_id,outbox_ids,state) VALUES($1,$2,$3,'sending')",[id,binding.chat_id,JSON.stringify(rows.map(r=>r.id))]);
 const u={...binding,id:binding.user_id} as User;
 try{const home=await botView(u,'telegram:'+binding.chat_id);const sent=await send(binding.chat_id,{text:`РУСПЭТ · новые события (${rows.length})\n\n${rows.map(r=>r.body.slice(0,220)).join('\n\n')}\n\nАктуальные действия — в меню ниже.`,buttons:home.buttons});await pool.query("UPDATE telegram_delivery SET state='sent',message_id=$2,sent_at=now() WHERE id=$1",[id,sent.message_id])}
 catch{await pool.query("UPDATE telegram_delivery SET state='uncertain',error='Нет подтверждения Telegram. Автоповтор остановлен, чтобы не дублировать возможную доставку.' WHERE id=$1",[id])}
}
export function startPilot(){if(process.env.TELEGRAM_WORKER_DISABLED==='true')return ()=>{};let stopped=false,lastCleanup=0;const run=async()=>{while(!stopped){let lock;try{
  if(Date.now()-lastCleanup>3600000){await pool.query('DELETE FROM bot_buttons WHERE expires_at<now()');await pool.query('DELETE FROM bot_sessions WHERE expires_at<now()');await pool.query("DELETE FROM bot_inputs WHERE created_at<now()-interval '7 days'");lastCleanup=Date.now()}
  const cfg=(await pool.query('SELECT enabled FROM telegram_settings WHERE id=1')).rows[0];if(!cfg.enabled){await sleep(3000);continue}
  lock=await pool.connect();if(!(await lock.query('SELECT pg_try_advisory_lock(431009) ok')).rows[0].ok){lock.release();lock=undefined;await sleep(3000);continue}
  if(!transportChecked){const me=await call('getMe'),info=await call('getWebhookInfo');assert(!info.url,409,'Есть webhook: polling не запущен.');username=me.username;transportChecked=true}
  await pool.query("UPDATE telegram_delivery SET state='uncertain',error='Процесс прерван во время отправки. Требуется проверка доставки.' WHERE state='sending'");
  await pool.query('INSERT INTO telegram_runtime(id,heartbeat_at,error) VALUES(1,now(),NULL) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),error=NULL');
  await deliver();const offset=Number((await pool.query('SELECT next_update FROM telegram_cursor WHERE id=1')).rows[0].next_update);
  const updates=await call('getUpdates',{offset,timeout:20,limit:10,allowed_updates:['message','callback_query']});
  for(const update of updates){if(stopped)break;const enabled=(await pool.query('SELECT enabled FROM telegram_settings WHERE id=1')).rows[0].enabled;if(!enabled)break;await handlePilotUpdate(update);await pool.query('UPDATE telegram_cursor SET next_update=$1 WHERE id=1',[update.update_id+1])}
 }catch(e){transportChecked=false;if(!stopped){try{await pool.query("INSERT INTO telegram_runtime(id,heartbeat_at,error) VALUES(1,now(),$1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),error=excluded.error",[e instanceof AppError?e.message:'Telegram недоступен. Повтор через 10 секунд.'])}catch{}await sleep(10000)}}finally{if(lock){try{await lock.query('SELECT pg_advisory_unlock(431009)')}finally{lock.release()}}}}};void run();return()=>{stopped=true};}
