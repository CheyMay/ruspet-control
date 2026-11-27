import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from './api.js';
import type {Bootstrap} from '../shared/types.js';

type Request={id:string;url?:string;image?:string;code:string;expiresAt:string};
const requestKey='ruspet:telegram-login-request';

function rememberedRequest():Request|null{
 try{
  const data=JSON.parse(sessionStorage.getItem(requestKey)??'null');
  if(typeof data?.id==='string'&&typeof data.code==='string'&&Date.parse(data.expiresAt)>Date.now())return data;
 }catch{}
 return null;
}
function rememberRequest(request?:Request){
 try{
  if(request){
   const {id,code,expiresAt}=request;
   sessionStorage.setItem(requestKey,JSON.stringify({id,code,expiresAt}));
  }else sessionStorage.removeItem(requestKey);
 }catch{}
}

export function TelegramLogin({mobile,onLogin}:{mobile:boolean;onLogin:(data:Bootstrap)=>void}){
 const [available,setAvailable]=useState<boolean|null>(null),[request,setRequest]=useState(rememberedRequest);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[state,setState]=useState('pending'),[seconds,setSeconds]=useState(120);
 const [connectUrl,setConnectUrl]=useState<string|null>(null);
 const generation=useRef(0);
 useEffect(()=>{
  let live=true;
  void api<{available:boolean;connectUrl?:string}>('/auth/qr/config','GET',undefined,{timeout:10000})
   .then(result=>{if(live){setAvailable(result.available);setConnectUrl(result.connectUrl??null);}})
   .catch(()=>{if(live)setAvailable(false)});
  return()=>{live=false;generation.current++;};
 },[]);

 async function create(){
  if(busy)return;
  const version=++generation.current;
  setBusy(true);setError('');setRequest(null);rememberRequest();
  try{
   const result=await api<Request>('/auth/qr','POST',{},{timeout:10000});
   if(version!==generation.current)return;
   setAvailable(true);setRequest(result);rememberRequest(result);setSeconds(120);setState('pending');
  }catch(e){if(version===generation.current)setError((e as Error).message);}
  finally{if(version===generation.current)setBusy(false);}
 }

 useEffect(()=>{
  if(!request)return;
  let live=true,waiting=false,finished=false,timer:ReturnType<typeof setTimeout>|undefined;
  const version=generation.current,path='/auth/qr/'+request.id,expiresAt=Date.parse(request.expiresAt);
  const current=()=>live&&version===generation.current;
  async function poll(){
   if(!current()||waiting||finished)return;
   clearTimeout(timer);waiting=true;
   setSeconds(Math.max(0,Math.ceil((expiresAt-Date.now())/1000)));
   try{
    const result=await api<{state:string}>(path,'GET',undefined,{timeout:10000});
    if(!current())return;
    setState(result.state);setError('');
    if(result.state==='approved'||result.state==='consumed'){
     if(result.state==='approved')await api(path+'/consume','POST',{},{timeout:10000});
     const data=await api<Bootstrap>('/bootstrap','GET',undefined,{timeout:10000});
     if(!current())return;
     finished=true;rememberRequest();onLogin(data);
    }else if(result.state!=='pending'){
     finished=true;rememberRequest();
    }
   }catch(e){
    if(!current())return;
    setError((e as Error).message);
    if(e instanceof ApiError&&[401,403,404].includes(e.status??0)){
     finished=true;rememberRequest();setState('cancelled');
    }
   }finally{
    waiting=false;
    if(current()&&!finished&&document.visibilityState==='visible')timer=setTimeout(poll,2000);
   }
  }
  const resume=()=>{if(document.visibilityState==='visible')void poll();};
  document.addEventListener('visibilitychange',resume);
  resume();
  return()=>{live=false;clearTimeout(timer);document.removeEventListener('visibilitychange',resume);};
 },[request,onLogin]);

 const active=request&&state==='pending';
 const buttonLabel=busy?'Готовим вход…':request?(mobile?'Начать вход заново':'Обновить QR-код'):
  mobile?'Войти через Telegram':'Показать QR-код';
 return <section className={'telegram-login'+(mobile?' telegram-login-mobile':'')} aria-label="Вход через Telegram">
  {!mobile&&<h2>Через Telegram</h2>}
  {active&&<>
   {!mobile&&request.image&&<><img className="login-qr" src={request.image} width={240} height={240} alt="QR-код для подтверждения входа в Telegram"/><p>Отсканируйте QR камерой телефона.</p></>}
   <p>Код проверки <strong className="login-verification">{request.code}</strong></p>
   {request.url&&<a className={'button '+(mobile?'primary':'secondary')} href={request.url} target="_blank" rel="noopener noreferrer">Открыть Telegram</a>}
   <p role="status">В боте нажмите «Подтвердить вход» и вернитесь на эту страницу. Осталось {seconds} сек.</p>
   <p>Сравните код в боте с кодом на этой странице.</p>
  </>}
  {request&&!active&&<p role="status">{({expired:'Код входа устарел.',denied:'Вы отклонили вход.',cancelled:'Запрос отменён.',approved:'Открываем вашу учётную запись…',consumed:'Вход подтверждён. Загружаем панель…'} as Record<string,string>)[state]}</p>}
  {error&&<p role="alert" className="login-error">{error}</p>}
  {available===false&&!request&&!error&&<p>Вход через Telegram временно недоступен. Повторите попытку или войдите по паролю.</p>}
  <button className={'button '+(mobile&&!active?'primary':'secondary')} type="button" disabled={busy} onClick={()=>void create()}>{buttonLabel}</button>
  <details className="login-no-access"><summary>Как подключить Telegram</summary>
   {connectUrl?<><p>Откройте бота, нажмите «Старт», укажите имя и фамилию и поделитесь своим номером. Если нужна проверка, заявка придёт администратору.</p>
    <a className="button secondary" href={connectUrl} target="_blank" rel="noreferrer">Подключить Telegram</a></>:
    <p>Обратитесь к администратору РУСПЭТ, чтобы подключить учётную запись.</p>}
  </details>
 </section>;
}
