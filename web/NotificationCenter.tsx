import {useEffect,useRef,useState} from 'react';
import {notificationTopics,type NotificationPreferences,type NotificationTopic} from '../shared/notification-settings.js';
import {ArrowUpRight,Bell,CheckCheck} from 'lucide-react';
import {groupNotifications} from '../shared/notifications.js';
import {workdayReports} from '../shared/report-links.js';
import type {Notification} from '../shared/types.js';
import {api} from './api.js';
import {DeviceNotifications} from './DeviceNotifications.js';
import {NotificationSound} from './NotificationSound.js';
import {TaskId,TaskReferences} from './TaskId.js';
import './notification-center.css';

const moscowTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});

export function NotificationCenter({items,userId,readOnly,open,refresh}:{items:Notification[];userId:string;readOnly:boolean;open:(id:string)=>void;refresh:()=>Promise<unknown>}){
 const [all,setAll]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [setup,setSetup]=useState(()=>new URLSearchParams(location.search).get('setup')==='1'||items.some(item=>item.push_invitation&&!item.read_at));
 const setupPanel=useRef<HTMLDetailsElement>(null);
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
  <div className="panel-heading notice-heading">
   <div><h2>Мои уведомления</h2><p>{ownUnread.length?ownUnread.length+' непрочитанных':'Вы всё прочитали'}</p></div>
   {!readOnly&&ownUnread.length>0&&<button className="button secondary" disabled={busy} onClick={()=>void mark(ownUnread)}><CheckCheck size={16}/> Прочитать все</button>}
  </div>
  {!readOnly&&<details ref={setupPanel} className="notice-setup" open={setup} onToggle={event=>setSetup(event.currentTarget.open)}>
   <summary>Push и звук</summary>
   {setup&&<><DeviceNotifications install userId={userId}/><NotificationSound userId={userId}/></>}
  </details>}
  <div className="tabs" aria-label="Фильтр уведомлений">
   <button className={!all?'selected':''} onClick={()=>setAll(false)} aria-pressed={!all}>Новые</button>
   <button className={all?'selected':''} onClick={()=>setAll(true)} aria-pressed={all}>Все</button>
  </div>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {!groups.length&&<p className="personal-empty">Здесь появятся комментарии, решения и другие события по вашим задачам.</p>}
  {groups.map(rows=>{
   const latest=rows[0];
   return <article className="notice-group" data-unread={rows.some(row=>!row.read_at)} key={latest.task_id||latest.id}>
    <span className="notice-icon"><Bell size={17} aria-hidden="true"/></span>
    <div>
     <small>{moscowTime.format(new Date(latest.created_at))} МСК</small>
     <p><TaskReferences text={latest.body}/></p>
     {rows.length>1&&<details><summary>{latest.task_notice?'Предыдущие напоминания':'Другие события по задаче'} · {rows.length-1}</summary>
      {rows.slice(1).map(row=><p key={row.id}><TaskReferences text={row.body}/></p>)}
     </details>}
     <div className="notice-actions">
      {latest.push_invitation&&!readOnly&&<button type="button" className="button primary" onClick={()=>{
       setSetup(true);setupPanel.current?.scrollIntoView({block:'nearest'});setupPanel.current?.querySelector('summary')?.focus();
      }}>Настроить push</button>}
      {latest.task_id&&<span className="notice-task"><TaskId number={latest.task_number??latest.task_id}/>
       <button type="button" className="text-button" onClick={()=>open(latest.task_id!)}>{latest.task_assignment?'Ознакомиться':'Открыть задачу'} <ArrowUpRight size={14}/></button></span>}
      {latest.task_notice?.taskIds.slice(0,3).map(id=><span key={id} className="notice-task"><TaskId number={id}/>
       <button type="button" className="text-button" aria-label={'Открыть задачу '+id} onClick={()=>open(id)}><ArrowUpRight size={14}/></button></span>)}
      {latest.task_notice?.hasDeadlines&&<a className="text-button" href="/?view=actions">Сроки и действия</a>}
      {latest.staff_review&&!readOnly&&<a className="text-button" href="/?view=registrations">Открыть заявки</a>}
      {latest.management_notice?.kind==='director-approvals'&&<a className="text-button" href={'/?view=approvals&batch='+latest.management_notice.batchId}>Открыть пакет</a>}
      {latest.management_notice?.kind==='approval-batch-ready'&&<a className="text-button" href="/?view=approvals">Открыть согласования</a>}
      {latest.management_notice?.kind==='weekly-deadline-watch'&&<a className="text-button" href={'/?view=approvals&weekly='+latest.management_notice.week}>Выбрать задачи для согласования</a>}
      {latest.management_notice?.kind==='morning-report'&&<a className="text-button" href={'/?view=reports&report='+latest.management_notice.reportId}>Открыть отчёт</a>}
      {latest.management_notice?.kind==='inactivity'&&<a className="text-button" href="/?view=tasks&scope=team&filter=overdue">Проверить просрочки</a>}
      {workdayReports(latest.management_notice).map(report=><a key={report.id} className="text-button" href={'/?view=reports&report='+report.id}>{report.label}</a>)}
      {!readOnly&&rows.some(row=>!row.read_at)&&<button className="text-button" disabled={busy} onClick={()=>void mark(rows)}>Прочитано</button>}
     </div>
    </div>
   </article>;
  })}
 </section>;
}

export function NotificationSettings({userId}:{userId:string}){
 const [preferences,setPreferences]=useState<NotificationPreferences|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let live=true;
  const load=()=>api<NotificationPreferences>('/notifications/preferences').then(value=>{if(live)setPreferences(value);}).catch(e=>{if(live)setError(e.message);});
  void load();
  window.addEventListener('ruspet-push-enabled',load);
  return()=>{live=false;window.removeEventListener('ruspet-push-enabled',load);};
 },[]);
 async function change(value:NotificationPreferences){
  setBusy(true);setError('');
  try{setPreferences(await api<NotificationPreferences>('/notifications/preferences','PUT',value));}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="panel automation-settings"><h2>Мои уведомления</h2>
  {error&&<p className="alert error" role="alert">{error}</p>}
  <p className="muted">Новые задачи собираются примерно за 10 минут. Уведомления на сайте доступны при любых настройках.</p>
  {preferences&&<div className="notification-channels">
   {([{label:'Telegram',master:'telegramDigest',topics:'telegramTopics'},{label:'Push на устройствах',master:'pushEnabled',topics:'pushTopics'}] as const).map(channel=><fieldset key={channel.master}>
    <legend>{channel.label}</legend>
    <label className="toggle-row"><strong>Получать уведомления</strong><input type="checkbox" checked={preferences[channel.master]}
     disabled={busy} onChange={e=>void change({...preferences,[channel.master]:e.target.checked})}/></label>
    {Object.entries(notificationTopics).map(([key,label])=><label className="toggle-row" key={key}>
     <span>{label}</span><input type="checkbox" checked={preferences[channel.topics][key as NotificationTopic]??true}
      disabled={busy||!preferences[channel.master]} onChange={e=>void change({...preferences,[channel.topics]:{...preferences[channel.topics],[key]:e.target.checked}})}/>
    </label>)}
   </fieldset>)}
  </div>}
  <DeviceNotifications key={String(preferences?.pushEnabled)} install userId={userId}/>
  <NotificationSound userId={userId}/>
 </section>;
}
