import {useEffect,useState} from 'react';
import {Bell,Download} from 'lucide-react';
import {api} from './api.js';

type InstallPrompt=Event&{prompt():Promise<void>;userChoice:Promise<{outcome:string}>};
let installPrompt:InstallPrompt|null=null;
window.addEventListener('beforeinstallprompt',event=>{
 event.preventDefault();
 installPrompt=event as InstallPrompt;
 window.dispatchEvent(new Event('ruspet-install-ready'));
});
const worker='serviceWorker' in navigator?navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>null):null;
const deviceOwner='ruspet-push-user';
export async function syncDeviceNotifications(userId:string){
 const previous=localStorage.getItem(deviceOwner);
 if(!previous||!worker)return;
 const registration=await worker;
 const subscription=await registration?.pushManager?.getSubscription();
 if(previous!==userId){
  await subscription?.unsubscribe();
  localStorage.removeItem(deviceOwner);
 }else if(subscription)await api('/notifications/push','POST',subscription.toJSON());
}
const isStandalone=()=>window.matchMedia('(display-mode: standalone)').matches||
 (navigator as Navigator&{standalone?:boolean}).standalone===true;
const isAppleMobile=()=>/iP(?:hone|ad|od)/i.test(navigator.userAgent)||
 (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
type Status={publicKey:string|null;active:boolean};

export function DeviceNotifications({install=false,userId}:{install?:boolean;userId:string}){
 const [settings,setSettings]=useState<Status|null>(null),[registration,setRegistration]=useState<ServiceWorkerRegistration|null>(null);
 const [canInstall,setCanInstall]=useState(!!installPrompt),[standalone,setStandalone]=useState(isStandalone);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const apple=isAppleMobile(),supported='Notification' in window&&'PushManager' in window;
 useEffect(()=>{
  let active=true;
  const ready=()=>setCanInstall(!!installPrompt),installed=()=>{installPrompt=null;setCanInstall(false);setStandalone(true);};
  window.addEventListener('ruspet-install-ready',ready);window.addEventListener('appinstalled',installed);
  void worker?.then(async result=>{
   if(result&&supported){const current=await navigator.serviceWorker.ready;if(active)setRegistration(current);}
  });
  void api<Status>('/notifications/push').then(value=>{if(active)setSettings(value);}).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;window.removeEventListener('ruspet-install-ready',ready);window.removeEventListener('appinstalled',installed);};
 },[supported]);
 async function installApp(){
  const prompt=installPrompt;if(!prompt)return;
  await prompt.prompt();
  const {outcome}=await prompt.userChoice;
  installPrompt=null;setCanInstall(false);
  if(outcome==='accepted')setStandalone(true);
 }
 async function change(){
  if(!registration||!settings?.publicKey)return;
  setBusy(true);setError('');
  try{
   if(settings.active){
    const subscription=await registration.pushManager.getSubscription();
    if(subscription){
     await api('/notifications/push','DELETE',{endpoint:subscription.endpoint});
     await subscription.unsubscribe();
    }
    localStorage.removeItem(deviceOwner);
    setSettings({...settings,active:false});
    return;
   }
   const permission=await Notification.requestPermission();
   if(permission!=='granted')throw new Error('Разрешите уведомления РУСПЭТ в настройках устройства или браузера.');
   const base64=settings.publicKey.replace(/-/g,'+').replace(/_/g,'/').padEnd(88,'=');
   const key=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
   const subscription=await registration.pushManager.getSubscription()??
    await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
   await api('/notifications/push','POST',subscription.toJSON());
   localStorage.setItem(deviceOwner,userId);
   setSettings({...settings,active:true});
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="device-notifications">
  {install&&!standalone&&<div className="device-notification-row">
   <div><strong>РУСПЭТ на главном экране</strong><small>{apple?'В Safari откройте «Поделиться» → «На экран „Домой“».':'В меню браузера выберите «Установить приложение» или «На главный экран».'}</small></div>
   {canInstall&&<button className="button secondary" type="button" onClick={()=>void installApp().catch(e=>setError(e.message))}><Download size={16}/>Установить</button>}
  </div>}
  <div className="device-notification-row">
   <div><strong>Push на этом устройстве</strong><small>{settings?.active?'Уведомления включены.':
    apple&&!standalone?'Откройте РУСПЭТ с главного экрана, чтобы включить push.':
    !supported?'В этом браузере фоновые уведомления недоступны.':
    settings&&!settings.publicKey?'Push на сервере пока недоступны.':'Приходят о сроках и новых задачах, даже когда страница закрыта.'}</small></div>
   {supported&&(!apple||standalone)&&<button className="button secondary" type="button" disabled={busy||!settings?.publicKey||!registration} onClick={()=>void change()}>
    <Bell size={16}/>{settings?.active?'Выключить':'Включить'}
   </button>}
  </div>
  {error&&<p className="red-text" role="alert">{error}</p>}
 </section>;
}
