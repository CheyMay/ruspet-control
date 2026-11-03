import {test} from 'node:test';
import assert from 'node:assert/strict';
import {telegramRequest} from '../server/telegram-transport.js';
test('proxy wraps JSON and multipart without leaking secret to target or retrying uncertain sends',async()=>{
 const savedFetch=globalThis.fetch,env={...process.env};const calls:{url:string;init:RequestInit}[]=[];
 process.env.TELEGRAM_PROXY_URL='https://bridge.example/forward';process.env.TELEGRAM_PROXY_SECRET='test-secret';
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init:init!});return new Response('{"ok":true,"result":{}}')};
 try{
  await telegramRequest('https://api.telegram.org/botTEST/getMe',{},1000);
  assert.equal(calls[0].url,'https://bridge.example/forward');assert.equal((calls[0].init.headers as any)['X-Proxy-Secret'],'test-secret');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)),{url:'https://api.telegram.org/botTEST/getMe',method:'POST'});
  const form=new FormData();form.set('document',new Blob(['PDF']),'report.pdf');form.set('chat_id','1');
  await telegramRequest('https://api.telegram.org/botTEST/sendDocument',form,1000);
  assert.equal((calls[1].init.body as FormData).get('method'),'POST');assert.equal((calls[1].init.headers as any)['Content-Type'],undefined);
  globalThis.fetch=async()=>{throw new Error('unknown delivery')};await assert.rejects(()=>telegramRequest('https://api.telegram.org/botTEST/sendMessage',{},1000));
  await assert.rejects(()=>telegramRequest('https://evil.example',{},1000));
 }finally{globalThis.fetch=savedFetch;for(const key of ['TELEGRAM_PROXY_URL','TELEGRAM_PROXY_SECRET']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
});
