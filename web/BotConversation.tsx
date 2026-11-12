import {useEffect,useRef,useState} from 'react';
import {Bell,House,ListTodo,Search,Send} from 'lucide-react';
import type {BotScreen} from '../server/bot.js';
import {api} from './api.js';
import {BotText} from './BotText.js';
import {VoiceRecorder} from './VoiceRecorder.js';

type Entry='home'|'tasks'|'notices'|'search_prompt';
type Props={mobile?:boolean;initial?:Entry;refresh:()=>Promise<unknown>};

export function BotConversation({mobile=false,initial='home',refresh}:Props){
 const [view,setView]=useState<BotScreen|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[voice,setVoice]=useState(false);
 const active=useRef(false);
 const query=mobile?'?channel=mobile':'';
 const field=useRef<HTMLTextAreaElement|null>(null);
 const message=useRef<HTMLDivElement|null>(null);
 useEffect(()=>{
  let mounted=true;
  api<BotScreen>('/bot/screen'+query,'POST',{screen:initial}).then(next=>{if(mounted)setView(next);}).catch(e=>{if(mounted)setError(e.message);});
  api<{enabled:boolean}>('/bot/voice').then(status=>{if(mounted)setVoice(status.enabled);}).catch(()=>{});
  return()=>{mounted=false;};
 },[query,initial]);
 async function run(path:string,body:unknown,focus=false){
  if(active.current)return;
  active.current=true;setBusy(true);setError('');
  try{
   setView(await api<BotScreen>(path+query,'POST',body));setText('');
   if(focus)window.requestAnimationFrame(()=>field.current?.focus());
   else if(mobile)message.current?.scrollIntoView({block:'nearest'});
   void refresh().catch(()=>{});
  }catch(e){setError((e as Error).message);}
  finally{active.current=false;setBusy(false);}
 }
 function open(screen:Entry){void run('/bot/screen',{screen},screen==='search_prompt');}
 async function sendVoice(audio:Blob,id:string){
  if(active.current)throw new Error('Дождитесь ответа бота.');
  active.current=true;setBusy(true);setError('');
  try{
   const result=await fetch('/api/bot/voice'+query,{method:'POST',credentials:'same-origin',body:audio,
    headers:{'Content-Type':audio.type,'X-Voice-Input-Id':id}});
   const next=await result.json().catch(()=>null);
   if(!result.ok||!next)throw new Error(next?.error||'Не удалось распознать запись.');
   setView(next as BotScreen);setText('');
   if(mobile)message.current?.scrollIntoView({block:'nearest'});
  }finally{active.current=false;setBusy(false);}
 }
 return <section className={mobile?'mobile-conversation':'panel'} aria-label="Рабочий бот">
  {!mobile&&<div className="panel-heading"><div><h2>Рабочий бот</h2><p>Найдите задачу, ответьте или запишите голосовое.</p></div><button className="button secondary" disabled={busy} onClick={()=>open('home')}>Меню</button></div>}
  <div className="bot-preview">
   <div ref={message} aria-live="polite">
    {view?<div className="bot-message"><BotText text={view.text} html={view.format==='HTML'}/></div>:!error&&<div className="bot-message">Загружаем рабочее меню…</div>}
   </div>
   {view?.document&&<a className="button primary" href={'/api/reports/'+view.document.reportId+'/pdf'} target="_blank" rel="noreferrer">Скачать PDF</a>}
   {view?.links?.filter(link=>!mobile||link.text!=='Войти на сайт').map(link=><a key={link.url} className="text-button" href={link.url} target="_blank" rel="noreferrer">{link.text}</a>)}
   {view&&<div className="bot-buttons">{view.buttons.map((row,i)=><div key={i}>{row.map(b=><button disabled={busy} key={b.token} onClick={()=>void run('/bot/click',{token:b.token},b.text==='Поиск')}>{b.text}</button>)}</div>)}</div>}
   {error&&<div className="alert error" role="alert">{error}</div>}
   <form className="bot-compose" onSubmit={event=>{event.preventDefault();if(text.trim())void run('/bot/text',{text,inputId:crypto.randomUUID()});}}>
    <textarea ref={field} aria-label="Ответ боту" value={text} maxLength={4000} onChange={event=>setText(event.target.value)} placeholder="Ответ или номер задачи…"/>
    <div className="bot-compose-actions">
     {!mobile&&voice&&<VoiceRecorder disabled={busy} onSend={sendVoice}/>}
     <button className="button primary" disabled={busy||!text.trim()}><Send size={16}/> {busy?'Подождите…':'Отправить'}</button>
    </div>
   </form>
  </div>
  {mobile&&<nav className="mobile-bot-nav" aria-label="Рабочие разделы">
   <button type="button" onClick={()=>open('home')} disabled={busy}><House size={19}/><span>Главная</span></button>
   <button type="button" onClick={()=>open('tasks')} disabled={busy}><ListTodo size={19}/><span>Задачи</span></button>
   {voice&&<VoiceRecorder mobile disabled={busy} onSend={sendVoice}/>}
   <button type="button" onClick={()=>open('search_prompt')} disabled={busy}><Search size={19}/><span>Поиск</span></button>
   <button type="button" onClick={()=>open('notices')} disabled={busy}><Bell size={19}/><span>События</span></button>
  </nav>}
 </section>;
}
