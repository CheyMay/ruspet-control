import {readFile} from 'node:fs/promises';

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
