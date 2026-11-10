import {readFile} from 'node:fs/promises';
import {ProxyAgent} from 'undici';
import {assert,AppError} from './domain.js';
import {telegramRequest} from './telegram-transport.js';

export const voiceAvailable=(userId:string)=>process.env.TELEGRAM_VOICE_ENABLED==='true'&&
 (process.env.TELEGRAM_VOICE_USER_IDS??'').split(',').some(id=>id.trim()===userId);
const maxBytes=4*1024*1024;
const formats:Record<string,string>={oga:'ogg',ogg:'ogg',mp3:'mp3',m4a:'m4a',wav:'wav',webm:'webm'};
type FileInfo={file_path?:unknown;file_size?:unknown};
type Voice={file_id?:unknown;duration?:unknown;file_size?:unknown};
async function boundedAudio(response:Response){
 assert(response.ok&&response.body&&!response.headers.get('content-type')?.includes('json'),502,'Не удалось скачать аудио из Telegram. Повторите запись или отправьте текст.');
 const reader=response.body.getReader();
 const chunks:Uint8Array[]=[];
 let size=0;
 try{
  assert(Number(response.headers.get('content-length')||0)<=maxBytes,400,'Голосовое больше 4 МБ. Запишите более короткое.');
  for(;;){
   const {value,done}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   assert(size<=maxBytes,400,'Голосовое больше 4 МБ. Запишите более короткое.');
   chunks.push(value);
  }
  assert(size>0,502,'Telegram вернул пустой аудиофайл.');
  return new Blob(chunks.map(chunk=>new Uint8Array(chunk)));
 }finally{await reader.cancel().catch(()=>{});}
}

export async function transcribeTelegramVoice(voice:Voice,getFile:(id:string)=>Promise<FileInfo>,getToken:()=>Promise<string>){
 assert(typeof voice.file_id==='string'&&voice.file_id.length<=256&&voice.file_id.length>0,400,'Не удалось прочитать голосовое сообщение.');
 assert(typeof voice.duration==='number'&&Number.isFinite(voice.duration)&&voice.duration>=0&&voice.duration<=90&&
  (typeof voice.file_size!=='number'||voice.file_size<=maxBytes),400,'Запишите голосовое до 90 секунд и 4 МБ.');
 let key:string;
 try{key=(process.env.GROQ_API_KEY||await readFile(process.env.GROQ_API_KEY_FILE??'','utf8')).trim();}
 catch{throw new AppError(503,'Распознавание временно недоступно. Отправьте текст или выберите действие в задаче.');}
 assert(key&&/^[A-Za-z0-9_-]+$/.test(key),503,'Распознавание временно недоступно. Отправьте текст.');
 const file=await getFile(voice.file_id);
 assert(typeof file.file_path==='string'&&/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:ogg|oga|mp3|m4a|wav|webm)$/i.test(file.file_path),502,'Telegram не вернул поддерживаемый аудиофайл.');
 assert(typeof file.file_size!=='number'||file.file_size<=maxBytes,400,'Голосовое больше 4 МБ. Запишите более короткое.');
 const audioUrl=`https://api.telegram.org/file/bot${await getToken()}/${file.file_path}`;
 let audio:Blob;
 try{audio=await boundedAudio(await telegramRequest(audioUrl,null,10000));}
 catch(error){if(error instanceof AppError)throw error;throw new AppError(502,'Не удалось скачать голосовое. Повторите запись или отправьте текст.');}
 const extension=formats[file.file_path.split('.').at(-1)!.toLowerCase()];
 const form=new FormData();
 form.set('file',audio,'voice.'+extension);form.set('model','whisper-large-v3-turbo');
 form.set('language','ru');form.set('response_format','json');form.set('temperature','0');
 let proxy:ProxyAgent|undefined;
 try{
  if(process.env.GROQ_HTTPS_PROXY)proxy=new ProxyAgent(process.env.GROQ_HTTPS_PROXY);
  const init:RequestInit&{dispatcher?:ProxyAgent}={method:'POST',headers:{Authorization:'Bearer '+key},body:form,signal:AbortSignal.timeout(20000),redirect:'error',...(proxy?{dispatcher:proxy}:{})};
  const response=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',init);
  if(!response.ok)throw Error('STT failed');
  const {text}=await response.json();
  if(typeof text!=='string'||!text.trim())throw new AppError(400,'Речь не распознана. Попробуйте короткое голосовое или отправьте текст.');
  return text.trim();
 }catch(error){if(error instanceof AppError)throw error;throw new AppError(502,'Распознавание сейчас недоступно. Повторите позже или отправьте текст.');}
 finally{await proxy?.destroy().catch(()=>{});}
}
