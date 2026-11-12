import {useEffect,useState} from 'react';
import {Bell,CheckCheck} from 'lucide-react';
import {groupNotifications} from '../shared/notifications.js';
import type {Notification} from '../shared/types.js';
import {api} from './api.js';
import {DeviceNotifications} from './DeviceNotifications.js';

const moscowTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});

export function NotificationCenter({items,readOnly,open,refresh}:{items:Notification[];readOnly:boolean;open:(id:string)=>void;refresh:()=>Promise<unknown>}){
 const [all,setAll]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const ownUnread=items.filter(item=>!item.read_at);
 const groups=groupNotifications(all?items:ownUnread);
 async function mark(rows:Notification[]){
  if(readOnly||busy)return;
  const ids=rows.filter(row=>!row.read_at).map(row=>row.id);
  if(!ids.length)return;
  setBusy(true);setError('');
  try{await api('/notifications/read','POST',{ids});await refresh();}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="panel personal-notices">
  <div className="panel-heading">
   <div><h2>Мои уведомления</h2><p>{ownUnread.length?ownUnread.length+' непрочитанных':'Вы всё прочитали'}</p></div>
   {!readOnly&&ownUnread.length>0&&<button className="button secondary" disabled={busy} onClick={()=>void mark(ownUnread)}><CheckCheck size={16}/> Отметить показанные</button>}
  </div>
  <div className="tabs" aria-label="Фильтр уведомлений">
   <button className={!all?'selected':''} onClick={()=>setAll(false)} aria-pressed={!all}>Новые</button>
   <button className={all?'selected':''} onClick={()=>setAll(true)} aria-pressed={all}>Все</button>
  </div>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {!groups.length&&<p className="personal-empty">Здесь появятся комментарии, решения и другие события по вашим задачам.</p>}
  {groups.map(rows=>{
   const latest=rows[0];
   return <article className="notice-group" key={latest.task_id||latest.id}>
    <Bell size={17} aria-hidden="true"/>
    <div>
     <small>{moscowTime.format(new Date(latest.created_at))} МСК</small>
     <p>{latest.body}</p>
     {rows.length>1&&<details><summary>{latest.task_notice?'Предыдущие напоминания':'Другие события по задаче'} · {rows.length-1}</summary>
      {rows.slice(1).map(row=><p key={row.id}>{row.body}</p>)}
     </details>}
     <div className="notice-actions">
      {latest.task_id&&<button className="text-button" onClick={()=>open(latest.task_id!)}>Открыть #{latest.task_id}</button>}
      {latest.task_notice?.taskIds.slice(0,3).map(id=><button key={id} className="text-button" onClick={()=>open(id)}>#{id}</button>)}
      {!readOnly&&rows.some(row=>!row.read_at)&&<button className="text-button" disabled={busy} onClick={()=>void mark(rows)}>Прочитано</button>}
     </div>
    </div>
   </article>;
  })}
 </section>;
}

export function NotificationSettings({userId}:{userId:string}){
 const [enabled,setEnabled]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let live=true;
  api<{telegramDigest:boolean}>('/notifications/preferences').then(value=>{if(live)setEnabled(value.telegramDigest);}).catch(e=>{if(live)setError(e.message);});
  return()=>{live=false;};
 },[]);
 async function change(value:boolean){
  setBusy(true);setError('');
  try{const result=await api<{telegramDigest:boolean}>('/notifications/preferences','PUT',{telegramDigest:value});setEnabled(result.telegramDigest);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="panel automation-settings"><h2>Мои уведомления</h2>
  {error&&<p className="alert error" role="alert">{error}</p>}
  <label className="toggle-row">
   <span><strong>Рабочие уведомления в Telegram</strong><small>Сроки, новые задачи и общие события. Личные напоминания приходят по назначенному расписанию.</small></span>
   <input type="checkbox" checked={enabled??false} disabled={busy||enabled===null} onChange={e=>void change(e.target.checked)}/>
  </label>
  <DeviceNotifications install userId={userId}/>
 </section>;
}

export function TelegramDeliverySettings(){
 type Status={settings:{enabled:boolean;delivery:boolean;task_delivery:boolean}};
 const [status,setStatus]=useState<Status['settings']|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let live=true;
  api<Status>('/telegram/status').then(value=>{if(live)setStatus(value.settings);}).catch(e=>{if(live)setError(e.message);});
  return()=>{live=false;};
 },[]);
 async function change(field:'delivery'|'task_delivery',value:boolean){
  if(!status)return;
  setBusy(true);setError('');
  const next={...status,[field]:value};
  try{
   await api('/telegram/settings','PUT',{enabled:next.enabled,delivery:next.delivery,taskDelivery:next.task_delivery});
   setStatus(next);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="panel automation-settings">
  <h2>Доставка сотрудникам</h2>
  {error&&<p className="alert error" role="alert">{error}</p>}
  <label className="toggle-row">
   <span><strong>Сроки и назначения в Telegram</strong><small>Один список просроченных каждые 30 минут с 09:00 до 19:00 МСК. Новые назначения собираются 10 минут.</small></span>
   <input type="checkbox" checked={status?.task_delivery??false} disabled={busy||!status?.enabled} onChange={e=>void change('task_delivery',e.target.checked)}/>
  </label>
  <label className="toggle-row">
   <span><strong>Общие события и сводки в Telegram</strong><small>{status?.enabled?'Комментарии, решения и отчёты в привязанных личных чатах.':'Сначала включите подключение в разделе «Рабочий бот».'}</small></span>
   <input type="checkbox" checked={status?.delivery??false} disabled={busy||!status?.enabled} onChange={e=>void change('delivery',e.target.checked)}/>
  </label>
 </section>;
}
