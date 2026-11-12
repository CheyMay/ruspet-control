import {readFile} from 'node:fs/promises';
import {Agent,ProxyAgent,buildConnector,type Dispatcher} from 'undici';
import {assert,AppError} from './domain.js';
import {voiceMaxBytes} from '../shared/voice.js';

const hostname='api.groq.com';
const endpoint='https://'+hostname+'/openai/v1/audio/transcriptions';
const limits=new Map<string,{started:number;count:number}>();
const active=new Set<string>();
const hour=3600000;
export type AudioFormat='webm'|'m4a'|'ogg'|'wav'|'mp3';

export function voiceEnabled(channel:'web'|'telegram',userId:string){
 const prefix=channel==='web'?'WEB_VOICE':'TELEGRAM_VOICE';
 const allowed=process.env[prefix+'_USER_IDS']?.split(',').map(value=>value.trim()).filter(Boolean);
 return process.env[prefix+'_ENABLED']==='true'&&!!(process.env.GROQ_API_KEY_FILE||process.env.GROQ_API_KEY)&&(!allowed?.length||allowed.includes(userId));
}

export function browserAudioFormat(mime:string,bytes:Buffer):AudioFormat{
 const type=mime.split(';',1)[0].trim().toLowerCase();
 if(type==='audio/webm'&&bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'webm';
 if(['audio/mp4','audio/x-m4a','video/mp4'].includes(type)&&bytes.subarray(4,8).toString()==='ftyp')return 'm4a';
 if(type==='audio/ogg'&&bytes.subarray(0,4).toString()==='OggS')return 'ogg';
 if(['audio/wav','audio/x-wav'].includes(type)&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')return 'wav';
 if(['audio/mpeg','audio/mp3'].includes(type)&&(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0))return 'mp3';
 throw new AppError(415,'Нужна аудиозапись WebM, M4A, Ogg, WAV или MP3.');
}

function dispatcher():Dispatcher|undefined{
 const port=process.env.GROQ_TUNNEL_PORT;
 if(port){
  assert(/^\d{1,5}$/.test(port)&&Number(port)>0&&Number(port)<=65535,503,'Некорректная настройка голосового туннеля.');
  const connect=buildConnector({timeout:7000});
  return new Agent({connect:(options,callback)=>{
   if(options.hostname!==hostname||options.protocol!=='https:'){callback(new Error('Unexpected transcription host'),null);return;}
   connect({...options,hostname:'127.0.0.1',port,servername:hostname},callback);
  }});
 }
 const proxy=process.env.GROQ_HTTPS_PROXY;
 return proxy?new ProxyAgent(proxy):undefined;
}

export async function transcribeAudio(audio:Blob,format:AudioFormat,userId:string){
 assert(audio.size>0&&audio.size<=voiceMaxBytes,400,'Аудиозапись должна быть не больше 4 МБ.');
 const now=Date.now();
 for(const [id,value] of limits)if(now-value.started>=hour)limits.delete(id);
 const limit=limits.get(userId)||{started:now,count:0};
 assert(limit.count<20&&!active.has(userId)&&active.size<4,429,'Дождитесь окончания распознавания или попробуйте позже.');
 limits.set(userId,limit);limit.count++;active.add(userId);
 let transport:Dispatcher|undefined;
 try{
  let key:string;
  try{key=(process.env.GROQ_API_KEY||await readFile(process.env.GROQ_API_KEY_FILE??'','utf8')).trim();}
  catch{throw new AppError(503,'Распознавание пока недоступно. Можно написать ответ текстом.');}
  assert(/^[A-Za-z0-9_-]+$/.test(key),503,'Распознавание пока недоступно. Можно написать ответ текстом.');
  const form=new FormData();
  form.set('file',audio,'voice.'+format);
  form.set('model','whisper-large-v3-turbo');
  form.set('language','ru');form.set('response_format','json');form.set('temperature','0');
  transport=dispatcher();
  const options:RequestInit&{dispatcher?:Dispatcher}={method:'POST',headers:{Authorization:'Bearer '+key},
   body:form,signal:AbortSignal.timeout(25000),redirect:'error',...(transport?{dispatcher:transport}:{})};
  const response=await fetch(endpoint,options);
  if(response.status===429)throw new AppError(429,'Лимит распознавания исчерпан. Попробуйте позже или напишите текст.');
  if(!response.ok)throw new AppError(502,'Сервис распознавания отклонил запись. Попробуйте записать ещё раз или напишите текст.');
  const {text}=await response.json();
  assert(typeof text==='string'&&text.trim(),400,'Речь не распознана. Попробуйте короткую запись.');
  return text.trim().slice(0,4000);
 }catch(error){
  if(error instanceof AppError)throw error;
  throw new AppError(502,'Сервис распознавания не ответил. Попробуйте позже или напишите текст.');
 }finally{
  active.delete(userId);
  await transport?.destroy().catch(()=>{});
 }
}
