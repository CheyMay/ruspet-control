import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {AudioLines,Mic,Square,Upload,X} from 'lucide-react';
import {voiceExample,voiceMaxBytes,voiceMaxSeconds} from '../shared/voice.js';

type AudioDraft={audio:Blob;url:string;id:string};
const mimeTypes=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'];
const suffixTypes:Record<string,string>={webm:'audio/webm',mp4:'audio/mp4',m4a:'audio/mp4',ogg:'audio/ogg',oga:'audio/ogg',wav:'audio/wav',mp3:'audio/mpeg'};

export function VoiceRecorder({onSend,disabled,mobile=false}:{onSend:(audio:Blob,id:string)=>Promise<void>;disabled:boolean;mobile?:boolean}){
 const [open,setOpen]=useState(false),[state,setState]=useState<'idle'|'permission'|'recording'|'sending'>('idle');
 const [elapsed,setElapsed]=useState(0),[draft,setDraft]=useState<AudioDraft|null>(null),[error,setError]=useState('');
 const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null);
 const timer=useRef<number|undefined>(undefined),url=useRef<string|null>(null),generation=useRef(0);
 const canRecord=typeof MediaRecorder!=='undefined'&&!!navigator.mediaDevices?.getUserMedia;
 function release(){
  window.clearInterval(timer.current);
  stream.current?.getTracks().forEach(track=>track.stop());
  stream.current=null;
 }
 function reset(){
  generation.current++;
  if(recorder.current?.state==='recording')recorder.current.stop();
  recorder.current=null;
  release();
  if(url.current)URL.revokeObjectURL(url.current);
  url.current=null;
 }
 useEffect(()=>()=>reset(),[]);
 function close(){reset();setOpen(false);setDraft(null);setError('');setState('idle');}
 useEffect(()=>{
  if(!open||state==='sending')return;
  const cancel=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopImmediatePropagation();close();}};
  window.addEventListener('keydown',cancel,true);
  return()=>window.removeEventListener('keydown',cancel,true);
 },[open,state]);
 function prepare(audio:Blob){
  if(!audio.size||audio.size>voiceMaxBytes){setError(audio.size?'Файл больше 4 МБ. Запишите более короткое голосовое.':'Запись пустая. Попробуйте ещё раз.');return;}
  if(url.current)URL.revokeObjectURL(url.current);
  const preview=URL.createObjectURL(audio);url.current=preview;
  setDraft({audio,url:preview,id:crypto.randomUUID()});
 }
 async function start(){
  setOpen(true);setError('');
  if(!canRecord)return;
  reset();setDraft(null);setElapsed(0);setState('permission');
  const request=generation.current;
  try{
   const media=await navigator.mediaDevices.getUserMedia({audio:true});
   if(request!==generation.current){media.getTracks().forEach(track=>track.stop());return;}
   stream.current=media;
   const mime=mimeTypes.find(type=>MediaRecorder.isTypeSupported(type));
   const active=new MediaRecorder(media,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:64000});
   recorder.current=active;
   const chunks:Blob[]=[];
   active.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
   active.onstop=()=>{
    if(request!==generation.current)return;
    recorder.current=null;release();setState('idle');
    prepare(new Blob(chunks,{type:active.mimeType||chunks[0]?.type||'audio/webm'}));
   };
   active.onerror=()=>{
    if(request!==generation.current)return;
    reset();setState('idle');setError('Не удалось записать звук. Попробуйте ещё раз или выберите аудиофайл.');
   };
   active.start(1000);setState('recording');
   const started=Date.now();
   timer.current=window.setInterval(()=>{
    const seconds=Math.floor((Date.now()-started)/1000);
    setElapsed(Math.min(seconds,voiceMaxSeconds));
    if(seconds>=voiceMaxSeconds&&active.state==='recording')active.stop();
   },250);
  }catch(error){
   if(request!==generation.current)return;
   reset();setState('idle');
   setError(error instanceof DOMException&&error.name==='NotAllowedError'
    ?'Разрешите доступ к микрофону в браузере или выберите аудиофайл.'
    :'Микрофон недоступен. Попробуйте ещё раз или выберите аудиофайл.');
  }
 }
 function pick(file?:File){
  if(!file)return;
  setError('');
  const type=file.type.startsWith('audio/')||file.type==='video/mp4'?file.type:suffixTypes[file.name.split('.').at(-1)?.toLowerCase()||''];
  if(!type){setError('Выберите аудиофайл WebM, M4A, Ogg, WAV или MP3.');return;}
  prepare(file.type===type?file:new Blob([file],{type}));
 }
 async function send(){
  if(!draft)return;
  setState('sending');setError('');
  try{await onSend(draft.audio,draft.id);close();}
  catch(error){setState('idle');setError(error instanceof Error?error.message:'Не удалось распознать запись.');}
 }
 const clock=Math.floor(elapsed/60)+':'+String(elapsed%60).padStart(2,'0');
 return <>
  <button type="button" className={mobile?'mobile-mic':'button secondary'} disabled={disabled} onClick={()=>void start()}><Mic size={mobile?21:17}/> <span>Голосом</span></button>
  {open&&createPortal(<div className="voice-overlay" onMouseDown={event=>{if(event.target===event.currentTarget&&state!=='sending')close();}}>
   <section className="voice-sheet" role="dialog" aria-modal="true" aria-labelledby="voice-title">
    <div className="voice-heading"><h2 id="voice-title">Голосовое сообщение</h2><button type="button" className="icon-button" aria-label="Закрыть запись" disabled={state==='sending'} onClick={close}><X size={21}/></button></div>
    <p className="muted">Назовите действие и номер задачи. Если бот уже задал вопрос, ответьте на него голосом.</p>
    <blockquote>«{voiceExample}»</blockquote>
    {state==='permission'&&<p role="status">Разрешите доступ к микрофону.</p>}
    {state==='recording'&&<div className="voice-live" role="status"><AudioLines size={24}/> Запись идёт <strong>{clock}</strong></div>}
    {state==='sending'&&<p role="status">Распознаём запись…</p>}
    {error&&<p className="alert error" role="alert">{error}</p>}
    {draft&&<audio aria-label="Прослушать запись" controls preload="metadata" src={draft.url}/>}
    <div className="voice-actions">
     {state==='recording'&&<button type="button" className="button primary" onClick={()=>recorder.current?.stop()}><Square size={16}/> Остановить запись</button>}
     {state==='idle'&&<>
      {draft&&<button type="button" className="button primary" onClick={()=>void send()}><AudioLines size={17}/> Распознать</button>}
      {canRecord&&<button type="button" className="button secondary" onClick={()=>void start()}><Mic size={17}/> {draft?'Записать заново':'Начать запись'}</button>}
      <label className="voice-file"><Upload size={17}/> Выбрать аудио<input type="file" accept="audio/*,.webm,.m4a,.ogg,.wav,.mp3" onChange={event=>{pick(event.target.files?.[0]);event.target.value='';}}/></label>
     </>}
    </div>
   </section>
  </div>,document.body)}
 </>;
}
