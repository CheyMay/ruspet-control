import {useEffect,useRef,useState} from 'react';
import {Clock3,House,ListTodo,Search,Send} from 'lucide-react';
import type {BotScreen} from '../server/bot.js';
import {api,ApiError} from './api.js';
import {BotText} from './BotText.js';
import {VoiceRecorder} from './VoiceRecorder.js';
import {TaskRoleSwitch} from './TaskRoleSwitch.js';
import type {PersonalTaskScope} from '../shared/types.js';

type Entry='home'|'tasks'|'notices'|'inbox'|'search_prompt';
type Props={mobile?:boolean;initial?:Entry;textDraft?:boolean;refresh:()=>Promise<unknown>};

export function BotConversation({mobile=false,initial='home',textDraft=false,refresh}:Props){
 const [view,setView]=useState<BotScreen|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[voice,setVoice]=useState(false);
 const [enterDraft,setEnterDraft]=useState(textDraft);
 const active=useRef(false);
 const revision=useRef(0);
 const pendingText=useRef<{text:string;id:string;draft:boolean}|null>(null);
 const query=mobile?'?channel=mobile':'';
 const field=useRef<HTMLTextAreaElement|null>(null);
 const message=useRef<HTMLDivElement|null>(null);
 useEffect(()=>{
  let mounted=true;
  const requested=++revision.current;
  active.current=true;setBusy(true);
  api<BotScreen>('/bot/screen'+query,'POST',{screen:initial},{timeout:12000}).then(next=>{
   if(mounted&&requested===revision.current)setView(next);
  }).catch(e=>{if(mounted&&requested===revision.current)setError(e.message);}).finally(()=>{
   if(mounted&&requested===revision.current){active.current=false;setBusy(false);}
  });
  api<{enabled:boolean}>('/bot/voice','GET',undefined,{timeout:10000}).then(status=>{if(mounted)setVoice(status.enabled);}).catch(()=>{});
  return()=>{mounted=false;};
 },[query,initial]);
 useEffect(()=>{setEnterDraft(textDraft);if(textDraft)field.current?.focus({preventScroll:true});},[textDraft]);
 async function run(path:string,body:unknown,focus=false){
  if(active.current)return false;
  revision.current++;
  active.current=true;setBusy(true);setError('');
  try{
   const next=await api<BotScreen>(path+query,'POST',body,{timeout:15000});
   pendingText.current=null;
   setView(next);setText('');
   if(path==='/bot/text-draft')setEnterDraft(false);
   if(focus)window.requestAnimationFrame(()=>field.current?.focus());
   else if(mobile)window.requestAnimationFrame(()=>message.current?.scrollIntoView({block:'start'}));
   if(next.buttons.flat().some(button=>button.text==='Отменить последнее действие'||button.text==='К задаче'))void refresh().catch(()=>{});
   return true;
  }catch(e){
   if(e instanceof ApiError&&!e.unconfirmed&&e.status!==401)pendingText.current=null;
   setError((e as Error).message);
   return false;
  }
  finally{active.current=false;setBusy(false);}
 }
 function open(screen:Entry,scope?:PersonalTaskScope){void run('/bot/screen',{screen,scope},screen==='search_prompt');}
 function sendText(draft=false){
  if(active.current||!text.trim())return;
  const previous=pendingText.current;
  const id=previous?.text===text&&previous.draft===draft?previous.id:crypto.randomUUID();
  pendingText.current={text,id,draft};
  void run(draft?'/bot/text-draft':'/bot/text',{text,inputId:id});
 }
 async function sendVoice(audio:Blob,id:string){
  if(active.current)throw new Error('Дождитесь ответа бота.');
  revision.current++;
  active.current=true;setBusy(true);setError('');
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),45000);
  try{
   const result=await fetch('/api/bot/voice'+query,{method:'POST',credentials:'same-origin',body:audio,
    headers:{'Content-Type':audio.type,'X-Voice-Input-Id':id},signal:controller.signal});
   const next=await result.json().catch(()=>null);
   if(!result.ok||!next)throw new Error(next?.error||'Не удалось распознать запись.');
   pendingText.current=null;setView(next as BotScreen);setText('');
   if(mobile)message.current?.scrollIntoView({block:'nearest'});
  }catch(error){
   if(controller.signal.aborted||error instanceof TypeError)throw new Error('Не получили ответ. Повторите отправку этой записи.');
   throw error;
  }finally{clearTimeout(deadline);active.current=false;setBusy(false);}
 }
 return <section className={mobile?'mobile-conversation':'panel'} aria-label="Рабочий бот">

  <div className="bot-preview" ref={message}>
   {view?.taskScope&&<TaskRoleSwitch value={view.taskScope} change={scope=>open('tasks',scope)} disabled={busy}/>}
   <div aria-live="polite">
    {view?<div className="bot-message"><BotText text={view.text} html={view.format==='HTML'}/></div>:!error&&<div className="bot-message">Загружаем рабочее меню…</div>}
   </div>
   {view?.document&&<a className="button primary" href={'/api/reports/'+view.document.reportId+'/pdf'} target="_blank" rel="noreferrer">Скачать PDF</a>}
   {view?.links?.filter(link=>!mobile||link.text!=='Войти на сайт').map(link=><a key={link.url} className="text-button" href={link.url} target="_blank" rel="noreferrer">{link.text}</a>)}
   {view&&<div className="bot-buttons">{view.buttons.map((row,i)=><div key={i}>{row.map(b=><button disabled={busy} key={b.token} onClick={()=>void run('/bot/click',{token:b.token},b.text==='Поиск')}>{b.text}</button>)}</div>)}</div>}
   {error&&<div className="alert error" role="alert"><span>{error}</span>{!view&&<button className="button secondary" disabled={busy} onClick={()=>open(initial)}>Повторить</button>}</div>}
   <form className="bot-compose" onSubmit={event=>{event.preventDefault();sendText(enterDraft);}}>
    <textarea ref={field} aria-label="Ответ боту" value={text} maxLength={4000} onChange={event=>setText(event.target.value)} placeholder={enterDraft?'Вставьте поручение или напишите команду…':'Ответ, номер задачи или поручение…'}/>
    <div className="bot-compose-actions">
     {!mobile&&voice&&<VoiceRecorder disabled={busy} onSend={sendVoice}/>}
     <button className="button primary" disabled={busy||!text.trim()}><Send size={16}/> {busy?'Подождите…':enterDraft?'Подготовить действие':'Отправить'}</button>
     {!enterDraft&&<button type="button" className="button secondary" disabled={busy||!text.trim()} onClick={()=>sendText(true)}>Разобрать как команду</button>}
    </div>
   </form>
  </div>
  {mobile&&<nav className="mobile-bot-nav" aria-label="Рабочие разделы">
   <button type="button" onClick={()=>open('home')} disabled={busy}><House size={19}/><span>Главная</span></button>
   <button type="button" onClick={()=>open('tasks')} disabled={busy}><ListTodo size={19}/><span>Задачи</span></button>
   {voice&&<VoiceRecorder mobile disabled={busy} onSend={sendVoice}/>}
   <button type="button" onClick={()=>open('search_prompt')} disabled={busy}><Search size={19}/><span>Поиск</span></button>
   <button type="button" onClick={()=>open('inbox')} disabled={busy}><Clock3 size={19}/><span>Сроки</span></button>
  </nav>}
 </section>;
}
