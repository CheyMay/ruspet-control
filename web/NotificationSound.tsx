import {useEffect,useState} from 'react';
import {Volume2} from 'lucide-react';
import {notificationTones,playTone,type NotificationTone} from './notification-tones.js';

const enabledKey=(userId:string)=>'ruspet-notification-sound:'+userId;
const toneKey=(userId:string)=>'ruspet-notification-tone:'+userId;
const changeEvent='ruspet-sound-preference';
function readPreference(key:string){
 try{return localStorage.getItem(key);}catch{return null;}
}
function preferences(userId:string){
 const value=readPreference(toneKey(userId));
 const tone=value&&Object.hasOwn(notificationTones,value)?value as NotificationTone:'classic';
 return {enabled:readPreference(enabledKey(userId))!=='off',tone};
}

let context:AudioContext|undefined;
export async function unlockNotificationSound(){
 if(!window.AudioContext)return false;
 try{
  context??=new AudioContext();
  if(context.state!=='running')await context.resume();
  return context.state==='running';
 }catch{return false;}
}

export async function playNotificationSound(userId:string,preview=false){
 const {enabled,tone}=preferences(userId);
 if(!preview&&(!enabled||document.visibilityState!=='visible'))return false;
 if(!context||context.state!=='running')return false;
 try{
  return await playTone(context,tone,()=>{
   const latest=preferences(userId);
   return latest.tone===tone&&(preview||latest.enabled&&document.visibilityState==='visible');
  });
 }catch{return false;}
}

export function NotificationSound({userId}:{userId:string}){
 const [settings,setSettings]=useState(()=>preferences(userId)),[message,setMessage]=useState('');
 useEffect(()=>{
  const update=()=>setSettings(preferences(userId));
  update();
  window.addEventListener('storage',update);
  window.addEventListener(changeEvent,update);
  return()=>{window.removeEventListener('storage',update);window.removeEventListener(changeEvent,update);};
 },[userId]);

 function save(key:string,value:string){
  try{localStorage.setItem(key,value);}
  catch{setMessage('Браузер не сохранил настройку звука.');return false;}
  setMessage('');
  window.dispatchEvent(new Event(changeEvent));
  return true;
 }

 return <div className="notification-sound">
  <label><input type="checkbox" checked={settings.enabled} onChange={event=>{
   const checked=event.target.checked;
   if(save(enabledKey(userId),checked?'on':'off')&&checked)void unlockNotificationSound();
  }}/> Звук новых уведомлений</label>
  <div className="notification-sound-controls">
   <label>Сигнал
    <select value={settings.tone} onChange={event=>save(toneKey(userId),event.target.value)}>
     {Object.entries(notificationTones).map(([value,label])=><option value={value} key={value}>{label}</option>)}
    </select>
   </label>
   <button type="button" className="button secondary" onClick={async()=>{
    if(await unlockNotificationSound()&&await playNotificationSound(userId,true))setMessage('Сигнал воспроизведён.');
    else setMessage('Не удалось воспроизвести сигнал.');
   }}><Volume2 size={16}/> Прослушать</button>
  </div>
  {message&&<small role="status">{message}</small>}
 </div>;
}
