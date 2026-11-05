import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createBitrixTransport,BitrixTransportError} from '../server/bitrix-transport.js';
import {parseBalancerExample,saveBalancerFiles} from '../server/balancer-config.js';
const source=`const BALANCER_URL = 'https://balancer.example/forward';
const BALANCER_PUBLIC = 'fixture-public';
const BALANCER_PRIVATE = 'fixture-private';
const BITRIX_WEBHOOK = 'https://thebest.bitrix24.ru/rest/1/fixture-webhook/';
throw new Error('MUST NEVER EXECUTE');`;
const envKeys=['BITRIX_TRANSPORT','BITRIX_BALANCER_CONFIG_FILE','BITRIX_BALANCER_TIMEOUT_MS'] as const;
async function fixture(run:(folder:string)=>Promise<void>){
 const folder=await mkdtemp(join(tmpdir(),'ruspet-balancer-test-')),saved=Object.fromEntries(envKeys.map(k=>[k,process.env[k]])),fetch=globalThis.fetch,now=Date.now;
 try{for(const key of envKeys)delete process.env[key];await saveBalancerFiles(folder,parseBalancerExample(source),true);process.env.BITRIX_BALANCER_CONFIG_FILE=join(folder,'bitrix-balancer.json');await run(folder);}
 finally{globalThis.fetch=fetch;Date.now=now;for(const key of envKeys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}await rm(folder,{recursive:true,force:true});}
}
test('balancer signs the supplied protocol, wraps classic URLs and unwraps the original Bitrix result without exposing keys',async()=>fixture(async()=>{
 Date.now=()=>1700000000000;let calls=0;
 globalThis.fetch=async(url,init)=>{
  calls++;assert.equal(String(url),'https://balancer.example/forward');const headers=init!.headers as Record<string,string>;
  assert.equal(headers['X-Timestamp'],'1700000000');assert.equal(headers['X-Signature'],createHmac('sha256','fixture-private').update('fixture-public:1700000000').digest('hex'));
  assert.equal(headers['Content-Type'],'application/json');assert.equal(init!.redirect,'error');
  assert.deepEqual(JSON.parse(String(init!.body)),{url:'https://thebest.bitrix24.ru/rest/1/fixture-webhook/tasks.task.get.json',method:'POST',body:{taskId:'5',select:['*','UF_PRICE']}});
  assert(!JSON.stringify(init).includes('fixture-private'));assert(!JSON.stringify(init).includes('fixture-public'));
  return new Response(JSON.stringify({body:{result:{task:{id:'5'}},next:50},quota_left:98}));
 };
 const transport=await createBitrixTransport('https://thebest.bitrix24.ru');assert.equal(transport.mode,'balancer');
 const response=await transport.send(new URL('https://thebest.bitrix24.ru/rest/1/fixture-webhook/tasks.task.get'),{taskId:'5',select:['*','UF_PRICE']});
 assert.deepEqual(response.body,{result:{task:{id:'5'}},next:50});assert.equal(response.layer,'bitrix');assert.equal(calls,1);
}));

test('REST 3.0 keeps its documented path; each request receives a fresh signature',async()=>fixture(async()=>{
 const requests:{body:any;headers:any}[]=[];let clock=1700000000000;Date.now=()=>clock;
 globalThis.fetch=async(_url,init)=>{requests.push({body:JSON.parse(String(init!.body)),headers:init!.headers});return new Response(JSON.stringify({body:{result:{result:true}}}));};
 const transport=await createBitrixTransport('https://thebest.bitrix24.ru'),url=new URL('https://thebest.bitrix24.ru/rest/api/1/fixture-webhook/tasks.task.chat.message.send');
 await transport.send(url,{fields:{taskId:'5',text:'Fixture'}});clock+=1000;await transport.send(url,{fields:{taskId:'5',text:'Other fixture'}});
 assert.equal(requests[0].body.url,url.toString());assert(!requests[0].body.url.endsWith('.json'));assert.notEqual(requests[0].headers['X-Signature'],requests[1].headers['X-Signature']);
 assert(!('is_recurrent' in requests[0].body));assert(!('result_key' in requests[0].body));
}));

test('a timeout or malformed balancer response never retries writes, falls back to direct calls or reveals the upstream URL',async()=>fixture(async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;throw Error('fixture-private https://thebest.bitrix24.ru/rest/1/fixture-webhook/')};
 const transport=await createBitrixTransport('https://thebest.bitrix24.ru'),url=new URL('https://thebest.bitrix24.ru/rest/1/fixture-webhook/tasks.task.update');
 await assert.rejects(()=>transport.send(url,{fields:{TITLE:'Fixture'}}),(e:unknown)=>e instanceof BitrixTransportError&&e.disposition==='uncertain'&&!e.message.includes('fixture-private')&&!e.message.includes('fixture-webhook'));assert.equal(calls,1);
 for(const reply of [{body:[]},{error:'may contain a secret'},{body:{unexpected:true}},null]){
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify(reply))};const attemptCount:number=calls;
  await assert.rejects(()=>transport.send(url,{}),(e:unknown)=>e instanceof BitrixTransportError&&e.disposition==='uncertain');assert.equal(calls,attemptCount+1);
 }
}));

test('gateway authentication, quota and Bitrix errors retain their distinct failure semantics',async()=>fixture(async()=>{
 const transport=await createBitrixTransport('https://thebest.bitrix24.ru'),url=new URL('https://thebest.bitrix24.ru/rest/1/fixture-webhook/tasks.task.get');
 globalThis.fetch=async()=>new Response('fixture-private',{status:401});await assert.rejects(()=>transport.send(url,{}),(e:unknown)=>e instanceof BitrixTransportError&&e.disposition==='rejected'&&!e.message.includes('fixture-private'));
 globalThis.fetch=async()=>new Response('may contain upstream secrets',{status:429});assert.deepEqual(await transport.send(url,{}),{status:429,ok:false,body:null,layer:'balancer'});
 globalThis.fetch=async()=>new Response(JSON.stringify({body:{error:'QUERY_LIMIT_EXCEEDED'}}));assert.equal((await transport.send(url,{})).body.error,'QUERY_LIMIT_EXCEEDED');
 globalThis.fetch=async()=>new Response('may contain upstream secrets',{status:500});assert.deepEqual(await transport.send(url,{}),{status:500,ok:false,body:null,layer:'balancer'});
}));

test('configuration fails closed for invalid keys, unsafe files, timeouts and foreign targets; direct mode is explicit',async()=>fixture(async(folder)=>{
 const path=join(folder,'bitrix-balancer.json');await chmod(path,0o644);await assert.rejects(()=>createBitrixTransport('https://thebest.bitrix24.ru'),/закрытый файл/);await chmod(path,0o600);
 process.env.BITRIX_BALANCER_TIMEOUT_MS='NaN';await assert.rejects(()=>createBitrixTransport('https://thebest.bitrix24.ru'),/Таймаут/);delete process.env.BITRIX_BALANCER_TIMEOUT_MS;
 process.env.BITRIX_TRANSPORT='bad';await assert.rejects(()=>createBitrixTransport('https://thebest.bitrix24.ru'),/BITRIX_TRANSPORT/);delete process.env.BITRIX_TRANSPORT;
 const transport=await createBitrixTransport('https://thebest.bitrix24.ru');let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{"result":true}')};
 await assert.rejects(()=>transport.send(new URL('https://other.example/rest/1/key/tasks.task.get'),{}));assert.equal(calls,0);
 await writeFile(path,JSON.stringify({url:'http://balancer.example',publicKey:'fixture',privateKey:'fixture'}));await assert.rejects(()=>createBitrixTransport('https://thebest.bitrix24.ru'));
 process.env.BITRIX_TRANSPORT='direct';const direct=await createBitrixTransport('https://thebest.bitrix24.ru');assert.equal(direct.mode,'direct');assert.equal((await direct.send(new URL('https://thebest.bitrix24.ru/rest/1/key/tasks.task.get'),{})).body.result,true);assert.equal(calls,1);
}));

test('the example is parsed as data, saved with private permissions, and existing different settings are never overwritten',async()=>fixture(async(folder)=>{
 assert.throws(()=>parseBalancerExample(source.replace("'fixture-private'","process.exit(1)")),/строковые/);
 assert.throws(()=>parseBalancerExample(source.replace('https://thebest.bitrix24.ru/rest/1/fixture-webhook/','https://other.example/rest/1/fixture-webhook/')),/портала/);
 assert.throws(()=>parseBalancerExample(source+'\nconst BALANCER_PRIVATE = \'duplicate\';'),/однозначные/);
 const settings=parseBalancerExample(source);assert((await saveBalancerFiles(folder,settings,true)).every(f=>f.action==='preserved'));
 assert.equal((await stat(join(folder,'bitrix-balancer.json'))).mode&0o777,0o600);assert.equal((await stat(join(folder,'bitrix-webhook'))).mode&0o777,0o600);
 const original=await readFile(join(folder,'bitrix-webhook'),'utf8');await assert.rejects(()=>saveBalancerFiles(folder,{...settings,balancer:{...settings.balancer,privateKey:'different-fixture'}},true),/отличаются/);assert.equal(await readFile(join(folder,'bitrix-webhook'),'utf8'),original);
 const other=await mkdtemp(join(tmpdir(),'ruspet-balancer-plan-'));try{assert((await saveBalancerFiles(other,settings,false)).every(f=>f.action==='would-create'));await assert.rejects(()=>stat(join(other,'bitrix-balancer.json')),/ENOENT/);}finally{await rm(other,{recursive:true,force:true})}
}));
