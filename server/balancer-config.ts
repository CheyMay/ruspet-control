import {open,readFile,realpath,stat,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {validateBalancerConfig,type BalancerConfig} from './bitrix-transport.js';
export function parseBalancerExample(source:string):{balancer:BalancerConfig;webhook:string}{
 const values:Record<string,string>={};
 for(const key of ['BALANCER_URL','BALANCER_PUBLIC','BALANCER_PRIVATE','BITRIX_WEBHOOK']){
  // Read four literal constants. Never evaluate or import the supplied JavaScript.
  const pattern=new RegExp('^\\s*const\\s+'+key+'\\s*=\\s*(?:"([^"\\\\\\r\\n]*)"|\'([^\'\\\\\\r\\n]*)\')\\s*;[ \\t]*(?://[^\\r\\n]*)?$','gm');
  const matches=[...source.matchAll(pattern)];
  if(matches.length!==1)throw Error('Нужны четыре однозначные строковые константы без экранирования. Исходник не исполняется.');
  values[key]=matches[0][1]??matches[0][2];
 }
 const balancer=validateBalancerConfig({url:values.BALANCER_URL,publicKey:values.BALANCER_PUBLIC,privateKey:values.BALANCER_PRIVATE});
 let webhook:URL;try{webhook=new URL(values.BITRIX_WEBHOOK);}catch{throw Error('Некорректный вебхук в примере.');}
 if(webhook.protocol!=='https:'||webhook.hostname!=='thebest.bitrix24.ru'||webhook.port||webhook.username||webhook.password||webhook.search||webhook.hash||!/^\/rest\/\d+\/[A-Za-z0-9_-]+\/$/.test(webhook.pathname))throw Error('Ожидался HTTPS вебхук нужного портала.');
 return {balancer,webhook:webhook.toString()};
}
export async function saveBalancerFiles(directory:string,settings:ReturnType<typeof parseBalancerExample>,apply=false){
 const folder=await realpath(directory),info=await stat(folder);
 if(folder!==resolve(directory)||!info.isDirectory()||(info.mode&0o077)!==0)throw Error('Нужен закрытый обычный каталог с правами 700.');
 const files=[{name:'bitrix-balancer.json',body:JSON.stringify(settings.balancer,null,2)+'\n',json:true},{name:'bitrix-webhook',body:settings.webhook+'\n',json:false}];
 const plan:{path:string;body:string;create:boolean}[]=[];
 for(const file of files){
  const path=join(folder,file.name);let exists=false;
  try{const current=await lstat(path);if(!current.isFile()||current.isSymbolicLink()||(current.mode&0o077)!==0)throw Error('Небезопасный существующий файл.');exists=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(exists){
   const current=await readFile(path,'utf8');let same=false;
   try{same=file.json?JSON.stringify(validateBalancerConfig(JSON.parse(current)))===JSON.stringify(settings.balancer):current.trim()===settings.webhook;}catch{}
   if(!same)throw Error('Существующие настройки отличаются. Файлы не перезаписаны; проверьте их вручную.');
  }
  plan.push({path,body:file.body,create:!exists});
 }
 if(apply)for(const file of plan.filter(p=>p.create)){
  const handle=await open(file.path,'wx',0o600);try{await handle.writeFile(file.body,'utf8');await handle.sync();}finally{await handle.close();}
 }
 return plan.map(({path,create})=>({path,action:create?(apply?'created':'would-create'):'preserved'}));
}
