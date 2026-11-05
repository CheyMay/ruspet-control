import {createHmac} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';

export class BitrixTransportError extends Error {
 constructor(message:string,public disposition:'rejected'|'uncertain'='uncertain'){super(message);}
}
export type BalancerConfig={url:string;publicKey:string;privateKey:string};
export type BitrixReply={status:number;ok:boolean;body:any;layer:'bitrix'|'balancer'};
export function validateBalancerConfig(value:unknown):BalancerConfig {
 const cfg=value as BalancerConfig;
 if(!cfg||Array.isArray(cfg)||typeof cfg.url!=='string'||typeof cfg.publicKey!=='string'||!cfg.publicKey.trim()||typeof cfg.privateKey!=='string'||!cfg.privateKey.trim())throw new BitrixTransportError('В закрытом файле балансировщика нужны url, publicKey и privateKey.','rejected');
 let url:URL;try{url=new URL(cfg.url);}catch{throw new BitrixTransportError('Некорректный URL балансировщика.','rejected');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new BitrixTransportError('Балансировщику нужен HTTPS URL без логина, пароля и фрагмента.','rejected');
 return {url:url.toString(),publicKey:cfg.publicKey,privateKey:cfg.privateKey};
}
export async function createBitrixTransport(origin:string){
 const selected=process.env.BITRIX_TRANSPORT||(process.env.BITRIX_BALANCER_CONFIG_FILE?'balancer':'direct');
 if(!['direct','balancer'].includes(selected))throw new BitrixTransportError('BITRIX_TRANSPORT: допустимы direct и balancer.','rejected');
 let cfg:BalancerConfig|null=null;
 if(selected==='balancer'){
  try{
   const file=process.env.BITRIX_BALANCER_CONFIG_FILE;if(!file)throw Error('missing');
   const info=await stat(file);if(!info.isFile()||(info.mode&0o077)!==0)throw Error('permissions');
   cfg=validateBalancerConfig(JSON.parse(await readFile(file,'utf8')));
  }catch{throw new BitrixTransportError('Проверьте закрытый файл BITRIX_BALANCER_CONFIG_FILE (JSON, права 600).','rejected');}
 }
 const timeout=selected==='balancer'?Number(process.env.BITRIX_BALANCER_TIMEOUT_MS||60000):15000;
 if(!Number.isInteger(timeout)||timeout<1000||timeout>120000)throw new BitrixTransportError('Таймаут балансировщика должен быть от 1000 до 120000 мс.','rejected');
 return {mode:selected as 'direct'|'balancer',send:async(target:URL,params:object):Promise<BitrixReply>=>{
  if(target.origin!==origin||target.protocol!=='https:'||target.username||target.password||target.search||target.hash||!target.pathname.startsWith('/rest/'))throw new BitrixTransportError('Неподдерживаемый адрес REST Битрикс24.','rejected');
  let response:Response;
  try{
   const headers:Record<string,string>={'Content-Type':'application/json'};
   let url=target.toString(),body:object=params;
   if(cfg){
    const destination=new URL(target);if(!destination.pathname.startsWith('/rest/api/')&&!destination.pathname.endsWith('.json'))destination.pathname+='.json';
    const timestamp=Math.floor(Date.now()/1000).toString();
    headers['X-Timestamp']=timestamp;
    headers['X-Signature']=createHmac('sha256',cfg.privateKey).update(`${cfg.publicKey}:${timestamp}`,'utf8').digest('hex');
    url=cfg.url;body={url:destination.toString(),method:'POST',body:params};
   }
   // Do not retry or switch transports: a write may already have reached Bitrix24.
   response=await fetch(url,{method:'POST',redirect:'error',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  }catch{throw new BitrixTransportError(cfg?'Ответ балансировщика не получен. Проверьте результат операции перед повтором.':'Нет подтверждённого ответа REST Битрикс24.');}
  if(cfg&&!response.ok){
   if(response.status===401||response.status===403)throw new BitrixTransportError('Балансировщик отклонил авторизацию. Проверьте ключи и время сервера.','rejected');
   return {status:response.status,ok:false,body:null,layer:'balancer'};
  }
  let parsed:any;try{parsed=await response.json();}catch{throw new BitrixTransportError(cfg?'Балансировщик вернул неподтверждённый ответ.':'Битрикс24 вернул неподтверждённый ответ.');}
  if(cfg){
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.error||!parsed.body||typeof parsed.body!=='object'||Array.isArray(parsed.body)||!Object.hasOwn(parsed.body,'result')&&!Object.hasOwn(parsed.body,'error'))throw new BitrixTransportError('Ответ балансировщика не соответствует формату одиночного запроса.');
   parsed=parsed.body;
  }
  return {status:response.status,ok:response.ok,body:parsed,layer:'bitrix'};
 }};
}
