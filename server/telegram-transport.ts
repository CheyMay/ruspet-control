import {readFile} from 'node:fs/promises';

// No fallback or automatic retry: a failed send may already have reached Telegram.
export async function telegramRequest(url:string,body:object|FormData,timeout:number):Promise<Response>{
 const target=new URL(url);
 if(target.origin!=='https://api.telegram.org')throw new Error('Unsupported Telegram target');
 const endpoint=process.env.TELEGRAM_PROXY_URL;
 let headers:Record<string,string>={},payload:BodyInit;
 if(endpoint){
  const proxy=new URL(endpoint);if(proxy.protocol!=='https:'||proxy.username||proxy.password)throw new Error('Invalid proxy configuration');
  const secret=process.env.TELEGRAM_PROXY_SECRET||(process.env.TELEGRAM_PROXY_SECRET_FILE?await readFile(process.env.TELEGRAM_PROXY_SECRET_FILE,'utf8'): '');
  if(!secret.trim())throw new Error('Missing proxy configuration');
  headers['X-Proxy-Secret']=secret.trim();
  if(body instanceof FormData){body.set('url',url);body.set('method','POST');payload=body;}
  else{headers['Content-Type']='application/json';payload=JSON.stringify({...body,url,method:'POST'});}
 }else if(body instanceof FormData)payload=body;
 else{headers['Content-Type']='application/json';payload=JSON.stringify(body);}
 return fetch(endpoint||url,{method:'POST',headers,body:payload,redirect:'error',signal:AbortSignal.timeout(timeout)});
}
