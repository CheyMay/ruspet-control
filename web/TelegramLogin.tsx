import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import type {Bootstrap} from '../shared/types.js';
type Request={id:string;url:string;image:string;code:string;expiresAt:string};
export function TelegramLogin({onLogin}:{onLogin:(data:Bootstrap)=>void}){
 const [available,setAvailable]=useState<boolean|null>(null),[request,setRequest]=useState<Request|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[state,setState]=useState(''),[seconds,setSeconds]=useState(120);
 const generation=useRef(0);
 useEffect(()=>{let live=true;void api<{available:boolean}>('/auth/qr/config').then(r=>{if(live)setAvailable(r.available)}).catch(()=>{if(live)setAvailable(false)});return()=>{live=false;generation.current++}},[]);
 async function create(){
  if(busy)return;const version=++generation.current;setBusy(true);setError('');setRequest(null);setState('');
  try{const result=await api<Request>('/auth/qr','POST',{});if(version===generation.current){setRequest(result);setSeconds(120);setState('pending');}}
  catch(e){if(version===generation.current)setError((e as Error).message)}finally{if(version===generation.current)setBusy(false)}
 }
 useEffect(()=>{
  if(!request)return;let live=true,timer:ReturnType<typeof setTimeout>;const version=generation.current;
  async function poll(){
   if(!live||version!==generation.current)return;
   const remaining=Math.max(0,Math.ceil((Date.parse(request!.expiresAt)-Date.now())/1000));setSeconds(remaining);
   if(!remaining){setState('expired');return;}
   try{
    const result=await api<{state:string}>('/auth/qr/'+request!.id);
    if(!live||version!==generation.current)return;
    setState(result.state);setError('');
    if(result.state==='approved'||result.state==='consumed'){
     if(result.state==='approved')await api('/auth/qr/'+request!.id+'/consume','POST',{});
     const data=await api<Bootstrap>('/bootstrap');if(live&&version===generation.current)onLogin(data);return;
    }
    if(result.state!=='pending')return;
   }catch(e){if(live&&version===generation.current)setError((e as Error).message)}
   if(live&&version===generation.current)timer=setTimeout(poll,2000);
  }
  void poll();return()=>{live=false;clearTimeout(timer)};
 },[request,onLogin]);
 const active=request&&state==='pending';
 return <section className="telegram-login" aria-label="Вход через Telegram">
  <h2>Через Telegram</h2><p>Для сотрудников, чей Telegram уже привязан к учётной записи.</p>
  {active&&<><img className="login-qr" src={request.image} width={240} height={240} alt="QR-код для подтверждения входа в Telegram"/><p>Откройте камеру телефона, отсканируйте QR и нажмите «Старт» в боте.</p><p>Код проверки: <strong className="login-verification">{request.code}</strong></p><a className="button secondary" href={request.url} target="_blank" rel="noopener noreferrer">Открыть Telegram на этом устройстве</a><p role="status">Подтвердите вход в боте · осталось {seconds} сек.</p><p>Подтверждайте только свой вход и проверьте совпадение кода.</p></>}
  {request&&!active&&<p role="status">{({expired:'QR-код устарел.',denied:'Вы отклонили вход.',cancelled:'Запрос отменён.',approved:'Открываем вашу учётную запись…',consumed:'Вход подтверждён. Загружаем панель…'} as Record<string,string>)[state]||'Обновите QR-код.'}</p>}
  {error&&<p role="alert" className="login-error">{error}</p>}
  {available===false&&<p>Telegram сейчас недоступен. Войдите по логину и паролю.</p>}
  {available!==false&&<button className="button secondary" type="button" disabled={busy||available===null} onClick={()=>void create()}>{busy?'Создаём QR-код…':request?'Обновить QR-код':'Показать QR-код'}</button>}
 </section>;
}
