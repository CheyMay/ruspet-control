import {readFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {pool,transaction} from './db.js';
import {assert} from './domain.js';
import {visibleTasks} from './service.js';
import {taskQueue} from '../shared/queues.js';
import type {User} from '../shared/types.js';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
async function token(){return process.env.TELEGRAM_BOT_TOKEN||(await readFile('.local/telegram-token','utf8')).trim();}
export async function telegramCall(method:'getMe'|'getWebhookInfo'|'getUpdates'|'sendMessage',body:object={}):Promise<any>{
 let response;try {response=await fetch(`https://api.telegram.org/bot${await token()}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(method==='getUpdates'?35000:12000)});}catch{throw new Error('Telegram недоступен или токен не настроен.');}
 const data=await response.json() as any;if(!data.ok)throw new Error(`Telegram: запрос отклонён (${data.error_code||response.status}).`);return data.result;
}
let identity:{username:string}|null=null;
export async function telegramStatus(){
 let configured=false;try{configured=!!await token();}catch{}
 const bound=(await pool.query('SELECT user_id,paired_at FROM telegram_binding WHERE id=1')).rows[0]||null;
 return {configured,username:identity?.username||null,bound,mode:'personal-pilot',automaticDelivery:false};
}
export async function createPairing(actor:User){
 assert(actor.role==='admin',403,'Привязку создаёт администратор.');
 identity=await telegramCall('getMe');
 const code=randomBytes(20).toString('hex');
 await transaction(async db=>{await db.query('DELETE FROM telegram_pairings');await db.query("INSERT INTO telegram_pairings(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[digest(code),actor.id]);});
 return {url:`https://t.me/${identity!.username}?start=${code}`,expiresInMinutes:15};
}
async function handle(update:any){
 const m=update.message;if(!m||m.chat?.type!=='private'||typeof m.text!=='string')return;
 const chatId=String(m.chat.id),code=m.text.match(/^\/start ([a-f0-9]{40})$/)?.[1];
 if(code){
  const paired=await transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(431008)');
   const valid=(await db.query('SELECT * FROM telegram_pairings WHERE token_hash=$1 AND expires_at>now() FOR UPDATE',[digest(code)])).rows[0];if(!valid)return false;
   const previous=(await db.query('SELECT chat_id FROM telegram_binding WHERE id=1')).rows[0];if(previous&&previous.chat_id!==chatId)return false;
   await db.query('INSERT INTO telegram_binding(id,chat_id,user_id) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,paired_at=now()',[chatId,valid.user_id]);
   await db.query('DELETE FROM telegram_pairings WHERE token_hash=$1',[digest(code)]);return true;
  });
  if(paired)await telegramCall('sendMessage',{chat_id:chatId,text:'РУСПЭТ подключён для личного пилота. /status — сводка, /today — задачи на сегодня, /overdue — прошлые просрочки. Рассылка сотрудникам отключена.'});return;
 }
 const binding=(await pool.query('SELECT u.* FROM telegram_binding b JOIN users u ON u.id=b.user_id WHERE b.id=1 AND b.chat_id=$1',[chatId])).rows[0] as User|undefined;
 if(!binding)return; // Never disclose data or send replies to an unpaired account.
 const command=m.text.split(/\s/)[0];if(!['/start','/status','/today','/overdue'].includes(command))return;
 const tasks=await visibleTasks(binding),now=new Date(),counts={today:0,overdue:0,review:0};
 for(const t of tasks){const q=taskQueue(t,now);if(q in counts)counts[q as keyof typeof counts]++;}
 const result=command==='/today'||command==='/overdue'?tasks.filter(t=>taskQueue(t,now)===command.slice(1)):[];
 const text=command==='/today'||command==='/overdue'?`${command==='/today'?'Сегодня':'Просрочены ранее'}: ${result.length}\n`+result.slice(0,12).map(t=>`#${t.id} ${t.title.slice(0,140)}`).join('\n')+(result.length>12?'\nПоказаны первые 12. Полный список — в панели.':''):`РУСПЭТ · состояние по импортированной выгрузке\nСегодня: ${counts.today}\nПросрочены ранее: ${counts.overdue}\nНа приёмке: ${counts.review}\nБитрикс24 не подключён.\n/today /overdue`;
 await telegramCall('sendMessage',{chat_id:chatId,text});
}
export async function startTelegram(){
 let available=false;try{available=!!await token();}catch{}if(!available)return ()=>{};
 const lock=await pool.connect();if(!(await lock.query('SELECT pg_try_advisory_lock(431009) ok')).rows[0].ok){lock.release();return ()=>{};}
 try{identity=await telegramCall('getMe');const info=await telegramCall('getWebhookInfo');if(info.url)throw new Error('У бота уже настроен webhook. Он не изменён; polling не запущен.');}catch(e){console.log((e as Error).message);await lock.query('SELECT pg_advisory_unlock(431009)');lock.release();return ()=>{};}
 let stopped=false;const loop=async()=>{while(!stopped){try{const cursor=(await pool.query('SELECT next_update FROM telegram_cursor WHERE id=1')).rows[0].next_update;const updates=await telegramCall('getUpdates',{offset:Number(cursor),timeout:25,limit:20,allowed_updates:['message']});for(const update of updates){if(stopped)break;await handle(update);await pool.query('UPDATE telegram_cursor SET next_update=$1 WHERE id=1',[update.update_id+1]);}}catch{if(!stopped)await new Promise(r=>setTimeout(r,5000));}}await lock.query('SELECT pg_advisory_unlock(431009)');lock.release();};void loop();console.log('Telegram personal pilot: waiting for explicit pairing.');return ()=>{stopped=true;};
}
