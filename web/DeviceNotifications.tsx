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
const worker=window.isSecureContext&&'serviceWorker' in navigator?navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>null):null;
const deviceOwner='ruspet-push-user';
export async function syncDeviceNotifications(userId:string){
 const previous=localStorage.getItem(deviceOwner);
 if(!previous||!worker)return;
 const registration=await worker;
 const subscription=await registration?.pushManager?.getSubscription();
 if(previous!==userId){
  await subscription?.unsubscribe();
  localStorage.removeItem(deviceOwner);
 }else if(subscription&&window.Notification?.permission==='granted')await api('/notifications/push','POST',subscription.toJSON());
}
const isStandalone=()=>window.matchMedia('(display-mode: standalone)').matches||
 (navigator as Navigator&{standalone?:boolean}).standalone===true;
const isAppleMobile=()=>/iP(?:hone|ad|od)/i.test(navigator.userAgent)||
 (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
type Status={publicKey:string|null;active:boolean};

export function DeviceNotifications({install=false,userId}:{install?:boolean;userId:string}){
 const [settings,setSettings]=useState<Status|null>(null),[registration,setRegistration]=useState<ServiceWorkerRegistration|null>(null);
 const [canInstall,setCanInstall]=useState(!!installPrompt),[standalone,setStandalone]=useState(isStandalone);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [permission,setPermission]=useState(()=>window.Notification?.permission);
 const [workerFailed,setWorkerFailed]=useState(false);
 const apple=isAppleMobile(),supported=!!worker&&'Notification' in window&&'PushManager' in window;
 useEffect(()=>{
  let active=true;
  const ready=()=>setCanInstall(!!installPrompt),installed=()=>{installPrompt=null;setCanInstall(false);setStandalone(true);};
  window.addEventListener('ruspet-install-ready',ready);window.addEventListener('appinstalled',installed);
  const refreshPermission=()=>setPermission(window.Notification?.permission);
  window.addEventListener('focus',refreshPermission);
  void api<Status>('/notifications/push').then(async value=>{
   const result=await worker;
   if(!active)return;
   setSettings(value);
   if(!result){if(active)setWorkerFailed(true);return;}
   if(!supported)return;
   const current=await navigator.serviceWorker.ready;
   if(!active)return;
   const subscription=await current.pushManager.getSubscription();
   if(active&&!value.active&&subscription&&localStorage.getItem(deviceOwner)===userId&&Notification.permission==='granted'){
    const saved=await api<Pick<Status,'active'>>('/notifications/push','POST',subscription.toJSON());
    if(active)setSettings(old=>old?{...old,active:saved.active}:old);
   }
   if(active)setRegistration(current);
  }).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;window.removeEventListener('ruspet-install-ready',ready);window.removeEventListener('appinstalled',installed);window.removeEventListener('focus',refreshPermission);};
 },[supported,userId]);
 async function installApp(){
  const prompt=installPrompt;if(!prompt)return;
  await prompt.prompt();
  const {outcome}=await prompt.userChoice;
  installPrompt=null;setCanInstall(false);
  if(outcome==='accepted')setStandalone(true);
 }
 async function change(){
  if(!registration||!settings?.publicKey)return;
  setBusy(true);setError('');setMessage('');
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
   const permission=Notification.permission==='granted'?'granted':await Notification.requestPermission();
   setPermission(permission);
   if(permission!=='granted')throw new Error('Разрешите уведомления РУСПЭТ в настройках устройства или браузера.');
   const raw=settings.publicKey.replace(/-/g,'+').replace(/_/g,'/');
   const base64=raw.padEnd(Math.ceil(raw.length/4)*4,'=');
   const key=Uint8Array.from(atob(base64),char=>char.charCodeAt(0));
   const subscription=await registration.pushManager.getSubscription()??
    await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
   await api('/notifications/push','POST',subscription.toJSON());
   localStorage.setItem(deviceOwner,userId);
   setSettings({...settings,active:true});
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 async function sendTest(){
  if(!registration||!settings)return;
  setBusy(true);setError('');setMessage('');
  try{
   const subscription=await registration.pushManager.getSubscription();
   if(!subscription){setSettings({...settings,active:false});throw Error('Подписка исчезла. Включите уведомления снова.');}
   const result=await api<{sent:boolean;expired:boolean}>('/notifications/push/test','POST',{endpoint:subscription.endpoint});
   if(result.expired){
    await subscription.unsubscribe();setSettings({...settings,active:false});
    throw Error('Подписка устарела. Включите уведомления снова.');
   }
   setMessage('Тест отправлен. Проверьте уведомления телефона.');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="device-notifications">
  {install&&!standalone&&<div className="device-notification-row">
   <div><strong>РУСПЭТ на главном экране</strong><small>{apple?'Откройте ruspetdev.ru в Safari. Выберите «Поделиться» → «На экран „Домой“», затем запустите РУСПЭТ с новой иконки.':'Откройте сайт в Chrome или другом обычном браузере. В меню выберите «Установить приложение» или «На главный экран».'}</small></div>
   {canInstall&&<button className="button secondary" type="button" onClick={()=>void installApp().catch(e=>setError(e.message))}><Download size={16}/>Установить</button>}
  </div>}
  <div className="device-notification-row">
   <div><strong>Push на этом устройстве</strong><small>{apple&&!standalone?'На iPhone уведомления включаются из приложения с главного экрана (iOS 16.4 и новее).':
    !supported?'Откройте сайт в браузере с поддержкой push. Встроенный браузер Telegram может их не поддерживать.':
    workerFailed?'Не удалось запустить уведомления. Обновите страницу в браузере.':
    permission==='denied'?'Уведомления запрещены. Разрешите их в настройках уведомлений РУСПЭТ или в разрешениях сайта в браузере.':
    settings&&!settings.publicKey?'Push на сервере пока недоступны.':
    !registration||!settings?'Проверяем готовность устройства…':
    settings.active?'Уведомления включены. Проверьте доставку кнопкой рядом.':'Приходят о сроках и новых задачах, даже когда страница закрыта.'}</small></div>
   {supported&&(!apple||standalone)&&permission!=='denied'&&<div className="device-notification-actions">
    <button className="button secondary" type="button" disabled={busy||!settings?.publicKey||!registration} onClick={()=>void change()}>
     <Bell size={16}/>{settings?.active?'Выключить':'Включить'}
    </button>
    {settings?.active&&<button className="button secondary" type="button" disabled={busy||!registration} onClick={()=>void sendTest()}>Проверить push</button>}
   </div>}
  </div>
  {error&&<p className="red-text" role="alert">{error}</p>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
