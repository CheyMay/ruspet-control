import {useEffect,useState} from 'react';
import {Volume2} from 'lucide-react';

const key=(userId:string)=>'ruspet-notification-sound:'+userId;
function soundEnabled(userId:string){
 try{return localStorage.getItem(key(userId))!=='off';}catch{return true;}
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

export function playNotificationSound(userId:string,preview=false){
 if(!preview&&(!soundEnabled(userId)||document.visibilityState!=='visible'))return false;
 if(!context||context.state!=='running')return false;
 const start=context.currentTime;
 for(const [i,frequency] of [660,880].entries()){
  const osc=context.createOscillator(),gain=context.createGain(),at=start+i*.12;
  osc.type='sine';osc.frequency.value=frequency;
  gain.gain.setValueAtTime(.0001,at);
  gain.gain.exponentialRampToValueAtTime(.15,at+.025);
  gain.gain.exponentialRampToValueAtTime(.0001,at+.18);
  osc.connect(gain);gain.connect(context.destination);
  osc.start(at);osc.stop(at+.19);
  osc.onended=()=>{osc.disconnect();gain.disconnect();};
 }
 return true;
}

export function NotificationSound({userId}:{userId:string}){
 const [enabled,setEnabled]=useState(()=>soundEnabled(userId)),[message,setMessage]=useState('');
 useEffect(()=>{
  const update=()=>setEnabled(soundEnabled(userId));
  window.addEventListener('storage',update);
  window.addEventListener('ruspet-sound-preference',update);
  return()=>{window.removeEventListener('storage',update);window.removeEventListener('ruspet-sound-preference',update);};
 },[userId]);
 return <div className="notification-sound">
  <label><input type="checkbox" checked={enabled} onChange={event=>{
   const checked=event.target.checked;
   localStorage.setItem(key(userId),checked?'on':'off');
   setEnabled(checked);setMessage('');
   window.dispatchEvent(new Event('ruspet-sound-preference'));
   if(checked)void unlockNotificationSound();
  }}/> Звук новых уведомлений</label>
  <button type="button" className="button secondary" onClick={async()=>{
   if(await unlockNotificationSound()&&playNotificationSound(userId,true))setMessage('Звук воспроизведён.');
   else setMessage('Браузер не разрешил воспроизвести звук.');
  }}><Volume2 size={16}/> Проверить звук</button>
  {message&&<small role="status">{message}</small>}
 </div>;
}
