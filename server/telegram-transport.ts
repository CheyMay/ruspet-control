import {readFile} from 'node:fs/promises';
import {TelegramRejected} from './telegram-errors.js';
import {AppError} from './domain.js';

type TextCall=(method:'sendMessage'|'editMessageText',body:object)=>Promise<{message_id:number}>;

export class TelegramTextUnconfirmed extends AppError {
 constructor(readonly operation:'send'|'edit'){
  super(502,'Telegram не подтвердил доставку сообщения.');
 }
}

export async function sendTelegramText(call:TextCall,body:object,messageId?:number){
 if(messageId!==undefined){
  try{return await call('editMessageText',{...body,message_id:messageId});}
  catch(error){
   if(!(error instanceof TelegramRejected))throw new TelegramTextUnconfirmed('edit');
   if(error.editState==='unchanged')return {message_id:messageId};
   if(error.editState!=='unavailable')throw error;
  }
 }
 try{return await call('sendMessage',body);}
 catch(error){if(error instanceof TelegramRejected)throw error;throw new TelegramTextUnconfirmed('send');}
}

// No fallback or automatic retry: a failed send may already have reached Telegram.
export async function telegramRequest(url:string,body:object|FormData|null,timeout:number):Promise<Response>{
 const target=new URL(url);
 if(target.origin!=='https://api.telegram.org')throw new Error('Unsupported Telegram target');
 const endpoint=process.env.TELEGRAM_PROXY_URL;
 const method=body===null?'GET':'POST';
 let headers:Record<string,string>={},payload:BodyInit|undefined;
 if(endpoint){
  const proxy=new URL(endpoint);if(proxy.protocol!=='https:'||proxy.username||proxy.password)throw new Error('Invalid proxy configuration');
  const secret=process.env.TELEGRAM_PROXY_SECRET||(process.env.TELEGRAM_PROXY_SECRET_FILE?await readFile(process.env.TELEGRAM_PROXY_SECRET_FILE,'utf8'): '');
  if(!secret.trim())throw new Error('Missing proxy configuration');
  headers['X-Proxy-Secret']=secret.trim();
  if(body instanceof FormData){body.set('url',url);body.set('method','POST');payload=body;}
  // The deployed bridge reads Telegram parameters from body. Keep the flat fields
  // for existing bridges; both representations contain the same API parameters.
  else{headers['Content-Type']='application/json';payload=JSON.stringify(body===null?{url,method}:{...body,url,method,body});}
 }else if(body instanceof FormData)payload=body;
 else if(body!==null){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
 return fetch(endpoint||url,{method:endpoint?'POST':method,headers,body:payload,redirect:'error',signal:AbortSignal.timeout(timeout)});
}
