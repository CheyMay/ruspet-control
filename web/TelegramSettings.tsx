import {useEffect,useState} from 'react';
import type {User} from '../shared/types.js';
import {mayManageStaffIdentity} from '../shared/workspace-access.js';
import {api} from './api.js';
import {EmployeeFilter} from './SearchFilter.js';

type Preferences={enabled:boolean;delivery:boolean;task_delivery:boolean;deadline_delivery:boolean;workday_delivery:boolean};
type Status={
 configured:boolean;username:string|null;bound:{user_id:string}|null;settings:Preferences;
 runtime:{error:string|null}|null;delivery:{state:string;count:number}[];
};
const switches=[
 {key:'delivery',label:'Общие события и сводки',hint:'Комментарии, решения и отчёты в личных чатах.'},
 {key:'task_delivery',label:'Новые назначения',hint:'Задачи собираются в один список за 10 минут.'},
 {key:'deadline_delivery',label:'Напоминания о сроках',hint:'Просрочки каждые 30 минут в рабочее время. Подготовка к согласованию к 15:00 МСК.'},
 {key:'workday_delivery',label:'Вечерние планы и отчёты',hint:'План на следующий рабочий день и сводка по поставленным задачам.'}
] as const;
const deliveryLabels:Record<string,string>={sent:'Отправлено',uncertain:'Доставка не подтверждена',failed:'Ошибка',sending:'Отправляется',pending:'В очереди'};

export function TelegramSettings({user,users}:{user:User;users:User[]}){
 const [status,setStatus]=useState<Status|null>(null),[target,setTarget]=useState(user.id),[pairing,setPairing]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);
 const admin=user.role==='admin';
 const own=target===user.id;

 useEffect(()=>{
  let active=true;
  api<Status>('/telegram/status').then(result=>{if(active)setStatus(result);}).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[user.id]);

 async function perform(action:()=>Promise<void>){
  setBusy(true);setError('');
  try{await action();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }

 async function change(field:keyof Preferences,value:boolean){
  if(!status)return;
  const next={...status.settings,[field]:value};
  await perform(async ()=>{
   await api('/telegram/settings','PUT',{
    enabled:next.enabled,delivery:next.delivery,
    taskDelivery:field==='task_delivery'?value:undefined,
    deadlineDelivery:field==='deadline_delivery'?value:undefined,
    workdayDelivery:field==='workday_delivery'?value:undefined
   });
   setStatus({...status,settings:next});
   if(field==='enabled'&&!value)setPairing(null);
  });
 }

 const refresh=()=>perform(async ()=>{
  const next=await api<Status>('/telegram/status');
  setStatus(next);
  if(next.bound&&own)setPairing(null);
 });

 return <section className="panel automation-settings">
  <h2>Telegram</h2>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {!status&&!error&&<p role="status">Проверяем подключение…</p>}
  {status&&<>
   <p>{status.bound?'Ваш личный чат подключён.':'Ваш личный чат ещё не подключён.'}{!status.settings.enabled&&' Доставка через Telegram выключена.'}</p>
   <div className="pilot-controls">
    {admin&&<button type="button" className="button secondary" disabled={busy||!status.configured}
     onClick={()=>void change('enabled',!status.settings.enabled)}>{status.settings.enabled?'Выключить Telegram':'Включить Telegram'}</button>}
    {status.settings.enabled&&admin&&<EmployeeFilter label="Чей Telegram подключить" value={target} disabled={busy}
     people={users.filter(person=>person.id!==user.id&&mayManageStaffIdentity(user,person))} empty={{value:user.id,label:'Мой Telegram'}}
     onChange={id=>{setTarget(id);setPairing(null);setCopied(false);}}/>}
    {status.settings.enabled&&(!own||!status.bound)&&<button type="button" className="button primary" disabled={busy||!status.configured}
     onClick={()=>void perform(async ()=>{
      const result=await api<{url:string}>('/telegram/pairing','POST',{userId:target});
      setPairing(result.url);setCopied(false);
     })}>{own?'Подключить мой чат':'Создать ссылку для сотрудника'}</button>}
   </div>
   {pairing&&<div className="telegram-pairing">
    <p>{own?'Откройте бота и нажмите «Начать».':'Передайте ссылку лично выбранному сотруднику.'} Ссылка действует 15 минут.</p>
    <div className="pilot-controls">
     {own?<><a className="button primary" href={pairing} target="_blank" rel="noreferrer">Открыть Telegram</a>
      <button type="button" className="button secondary" disabled={busy} onClick={()=>void refresh()}>Проверить привязку</button></>:
      <button type="button" className="button secondary" disabled={busy} onClick={()=>void perform(async ()=>{
       await navigator.clipboard.writeText(pairing);setCopied(true);
      })}>{copied?'Ссылка скопирована':'Скопировать ссылку'}</button>}
    </div>
   </div>}
   {admin&&<>
    {status.settings.enabled&&<><h3>Сообщения сотрудникам</h3>
     {switches.map(({key,label,hint})=><label className="toggle-row" key={key}>
      <span><strong>{label}</strong><small>{hint}</small></span>
      <input type="checkbox" checked={status.settings[key]} disabled={busy} onChange={e=>void change(key,e.target.checked)}/>
     </label>)}
    </>}
    <details className="report-more"><summary>Состояние доставки</summary>
     <p>{status.username?'@'+status.username:status.configured?'Бот настроен':'Бот ещё не настроен'}</p>
     {status.runtime?.error&&<p role="status" className="red-text">{status.runtime.error}</p>}
     {status.delivery.map(entry=><p key={entry.state}>{deliveryLabels[entry.state]??entry.state} · {entry.count}</p>)}
     <button type="button" className="text-button" disabled={busy} onClick={()=>void refresh()}>Обновить состояние</button>
    </details>
   </>}
  </>}
 </section>;
}
