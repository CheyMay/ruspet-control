import {createHash,randomUUID} from 'node:crypto';
import {mkdir,stat,rename,unlink} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {assert} from './domain.js';

export async function archiveFile(portal:string,raw:Record<string,any>,options:{directory?:string;fetcher?:typeof fetch;limit?:number;hosts?:string[];beforeFetch?:()=>Promise<void>;onThrottle?:()=>Promise<void>}={}){
 const directory=resolve(options.directory||process.env.BITRIX_ARCHIVE_DIR||'.local/bitrix-archive');
 assert(!directory.startsWith(resolve('dist')+'/')&&directory!==resolve('dist'),400,'Архив файлов должен быть вне публичного каталога.');
 await mkdir(directory,{recursive:true,mode:0o700});assert(((await stat(directory)).mode&0o077)===0,503,'Каталог архива должен иметь права 0700.');
 const limit=options.limit||128*1024*1024,size=Number(raw.SIZE);
 assert(Number.isSafeInteger(size)&&size>=0&&size<=limit,409,'Размер файла неизвестен или превышает лимит архива.');
 const hosts=new Set([portal,...(options.hosts||String(process.env.BITRIX_FILE_HOSTS||'').split(',').filter(Boolean))]);
 let url:URL;try{url=new URL(raw.DOWNLOAD_URL,`https://${portal}/`);}catch{throw Error('Нет подтверждённого адреса скачивания файла.');}
 let response:Response|undefined;
 for(let redirects=0;redirects<5;redirects++){
  assert(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&hosts.has(url.hostname),403,'Файловый хост не разрешён для архива.');
  await options.beforeFetch?.();
  response=await (options.fetcher||fetch)(url,{redirect:'manual',signal:AbortSignal.timeout(60000)});
  if([429,503].includes(response.status)){await response.body?.cancel();await options.onThrottle?.();throw Error('Загрузка файлов приостановлена после ограничения источника.');}
  if(![301,302,303,307,308].includes(response.status))break;
  const location=response.headers.get('location');await response.body?.cancel();assert(location,502,'Перенаправление файла не содержит адреса.');url=new URL(location,url);response=undefined;
 }
 assert(response?.ok&&response.body,502,'Файл не получен. Проверьте права и разрешённые файловые хосты.');
 const temporary=join(directory,randomUUID()+'.part'),hash=createHash('sha256');let bytes=0;
 try{
  await pipeline(Readable.fromWeb(response.body as any),new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>limit)return done(Error('Превышен лимит размера файла.'));hash.update(chunk);done(null,chunk);}}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
  assert(bytes===size,502,'Размер полученного файла не совпадает с метаданными.');
  const sha256=hash.digest('hex'),path=join(directory,sha256);await rename(temporary,path);return {sha256,path,bytes};
 }catch(error){await unlink(temporary).catch(()=>{});throw error;}
}
