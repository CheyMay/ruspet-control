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
  assert.deepEqual(JSON.parse(String(calls[0].init.body)),{url:'https://api.telegram.org/botTEST/getMe',method:'POST',body:{}});
  const form=new FormData();form.set('document',new Blob(['PDF']),'report.pdf');form.set('chat_id','1');
  await telegramRequest('https://api.telegram.org/botTEST/sendDocument',form,1000);
  assert.equal((calls[1].init.body as FormData).get('method'),'POST');assert.equal((calls[1].init.headers as any)['Content-Type'],undefined);
  globalThis.fetch=async()=>{throw new Error('unknown delivery')};await assert.rejects(()=>telegramRequest('https://api.telegram.org/botTEST/sendMessage',{},1000));
  await assert.rejects(()=>telegramRequest('https://evil.example',{},1000));
 }finally{globalThis.fetch=savedFetch;for(const key of ['TELEGRAM_PROXY_URL','TELEGRAM_PROXY_SECRET']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
});

test('a bridge consuming body forwards message text, keyboards and polling offset; flat bridges stay compatible',async()=>{
 const savedFetch=globalThis.fetch,env={...process.env};
 process.env.TELEGRAM_PROXY_URL='https://bridge.example/forward';process.env.TELEGRAM_PROXY_SECRET='fixture-bridge-secret';
 const message={chat_id:'81001',text:'РУСПЭТ · проверка',parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'Подтвердить',callback_data:'fixture-confirm'}],[{text:'Сайт',url:'https://site.example/'}]]},link_preview_options:{is_disabled:true}};
 try{
  for(const format of ['nested','flat']){
   const forwarded:{method:string;params:any}[]=[];
   globalThis.fetch=async(endpoint,init)=>{
    assert.equal(String(endpoint),'https://bridge.example/forward');
    assert.equal((init!.headers as Record<string,string>)['X-Proxy-Secret'],'fixture-bridge-secret');
    const envelope=JSON.parse(String(init!.body)),{url,method,body,...flat}=envelope;
    assert.equal(method,'POST');assert(!JSON.stringify(envelope).includes('fixture-bridge-secret'));
    const params=format==='nested'?body:flat,name=new URL(url).pathname.split('/').at(-1)!;
    forwarded.push({method:name,params});
    if(name==='sendMessage'&&(!params?.text||!params.chat_id))return new Response(JSON.stringify({ok:false,error_code:400,description:'Bad Request: message text is empty'}),{status:400});
    // The nested bridge deliberately ignores top-level fields, as on the VPS.
    const result=name==='getUpdates'?[{update_id:1400},{update_id:1401}].filter(u=>u.update_id>=Number(params?.offset||0)):{message_id:72};
    return new Response(JSON.stringify({ok:true,result}));
   };
   const sent=await telegramRequest('https://api.telegram.org/botFIXTURE/sendMessage',message,1000);assert.equal(sent.status,200);assert.equal((await sent.json() as any).ok,true);
   await telegramRequest('https://api.telegram.org/botFIXTURE/editMessageText',{...message,message_id:72},1000);
   await telegramRequest('https://api.telegram.org/botFIXTURE/answerCallbackQuery',{callback_query_id:'fixture-query'},1000);
   const poll=await telegramRequest('https://api.telegram.org/botFIXTURE/getUpdates',{offset:1402,timeout:20,limit:10,allowed_updates:['message','callback_query']},1000);
   assert.deepEqual((await poll.json() as any).result,[],'offset must reach Telegram to acknowledge old updates');
   assert.deepEqual(forwarded,[{method:'sendMessage',params:message},{method:'editMessageText',params:{...message,message_id:72}},{method:'answerCallbackQuery',params:{callback_query_id:'fixture-query'}},{method:'getUpdates',params:{offset:1402,timeout:20,limit:10,allowed_updates:['message','callback_query']}}]);
  }
 }finally{globalThis.fetch=savedFetch;for(const key of ['TELEGRAM_PROXY_URL','TELEGRAM_PROXY_SECRET']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
});

test('direct Telegram requests keep their original JSON and an uncertain send is attempted once',async()=>{
 const savedFetch=globalThis.fetch,env={...process.env};delete process.env.TELEGRAM_PROXY_URL;
 const message={chat_id:'81001',text:'Вымышленная проверка'};let calls=0;
 try{
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(String(url),'https://api.telegram.org/botFIXTURE/sendMessage');assert.deepEqual(JSON.parse(String(init!.body)),message);assert.equal((init!.headers as any)['X-Proxy-Secret'],undefined);return new Response('{"ok":true,"result":{"message_id":1}}')};
  await telegramRequest('https://api.telegram.org/botFIXTURE/sendMessage',message,1000);assert.equal(calls,1);
  process.env.TELEGRAM_PROXY_URL='https://bridge.example/forward';process.env.TELEGRAM_PROXY_SECRET='fixture-bridge-secret';calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('uncertain result')};
  await assert.rejects(()=>telegramRequest('https://api.telegram.org/botFIXTURE/sendMessage',message,1000),/uncertain result/);assert.equal(calls,1);
 }finally{globalThis.fetch=savedFetch;for(const key of ['TELEGRAM_PROXY_URL','TELEGRAM_PROXY_SECRET']){if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];}}
});
