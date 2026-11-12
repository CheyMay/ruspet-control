import {assert,AppError} from './domain.js';
import {telegramRequest} from './telegram-transport.js';
import {transcribeAudio,type AudioFormat} from './transcription.js';
import {voiceMaxBytes,voiceMaxSeconds} from '../shared/voice.js';

type Voice={file_id?:unknown;duration?:unknown;file_size?:unknown};
type FileInfo={file_path?:unknown;file_size?:unknown};
const formats:Record<string,AudioFormat>={oga:'ogg',ogg:'ogg',mp3:'mp3',m4a:'m4a',wav:'wav',webm:'webm'};

async function downloadAudio(url:string){
 let response:Response;
 try{response=await telegramRequest(url,null,10000);}
 catch{throw new AppError(502,'Не удалось скачать голосовое из Telegram. Попробуйте ещё раз.');}
 assert(response.ok&&response.body&&!response.headers.get('content-type')?.includes('json'),502,'Telegram не вернул аудиофайл.');
 const reader=response.body.getReader();
 const chunks:Uint8Array<ArrayBuffer>[]=[];
 let size=0;
 try{
  assert(Number(response.headers.get('content-length')||0)<=voiceMaxBytes,400,'Голосовое больше 4 МБ.');
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   size+=value.length;
   assert(size<=voiceMaxBytes,400,'Голосовое больше 4 МБ.');
   chunks.push(new Uint8Array(value));
  }
  assert(size,502,'Telegram вернул пустое аудио.');
  return new Blob(chunks);
 }finally{await reader.cancel().catch(()=>{});}
}
export async function transcribeTelegramVoice(userId:string,voice:Voice,getFile:(id:string)=>Promise<FileInfo>,getToken:()=>Promise<string>){
 assert(typeof voice.file_id==='string'&&voice.file_id.length>0&&voice.file_id.length<=256,400,'Не удалось прочитать голосовое сообщение.');
 assert(typeof voice.duration==='number'&&Number.isFinite(voice.duration)&&voice.duration>=0&&voice.duration<=voiceMaxSeconds&&
  (typeof voice.file_size!=='number'||voice.file_size<=voiceMaxBytes),400,'Запишите голосовое до 90 секунд и 4 МБ.');
 const file=await getFile(voice.file_id);
 assert(typeof file.file_path==='string'&&/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:ogg|oga|mp3|m4a|wav|webm)$/i.test(file.file_path),502,'Telegram не вернул поддерживаемый аудиофайл.');
 assert(typeof file.file_size!=='number'||file.file_size<=voiceMaxBytes,400,'Голосовое больше 4 МБ.');
 const url='https://api.telegram.org/file/bot'+await getToken()+'/'+file.file_path;
 return transcribeAudio(await downloadAudio(url),formats[file.file_path.split('.').at(-1)!.toLowerCase()],userId);
}
