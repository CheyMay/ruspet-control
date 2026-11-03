import 'dotenv/config';
import {readFile} from 'node:fs/promises';
import {telegramRequest} from '../server/telegram-transport.js';
try{
 const token=process.env.TELEGRAM_BOT_TOKEN||(await readFile(process.env.TELEGRAM_BOT_TOKEN_FILE||'.local/telegram-token','utf8')).trim();
 const me=await (await telegramRequest(`https://api.telegram.org/bot${token}/getMe`,{},15000)).json();
 if(!me.ok)throw new Error('transport');
 const info=await (await telegramRequest(`https://api.telegram.org/bot${token}/getWebhookInfo`,{},15000)).json();
 if(!info.ok||info.result.url)throw new Error('webhook');
 console.log(JSON.stringify({telegram:true,transport:process.env.TELEGRAM_PROXY_URL?'proxy':'direct',webhook:false}));
}catch{console.error('Telegram preflight failed. Check private configuration and existing webhook. No messages sent.');process.exitCode=1;}
