import {useEffect,useState} from 'react';
import {api} from './api.js';

type Alert={id:string;task_id:string|null;body:string;due_at:string;expires_at:string;acknowledged_at:string|null;canceled_at:string|null};
const format=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});

export function ReminderInbox({userId,readOnly=false,open,onChange}:{
 userId:string;readOnly?:boolean;open:(id:string)=>void;onChange:()=>Promise<unknown>;
}){
 const [alerts,setAlerts]=useState<Alert[]|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{
  let live=true;
  const load=()=>api<Alert[]>('/alerts').then(value=>{if(live){setAlerts(value);setError('');}}).catch(e=>{if(live)setError(e.message);});
  void load();
  const timer=setInterval(load,30000);
  return()=>{live=false;clearInterval(timer);};
 },[userId]);
 const now=Date.now();
 const active:Alert[]=[],upcoming:Alert[]=[],history:Alert[]=[];
 for(const alert of alerts??[]){
  if(alert.acknowledged_at||alert.canceled_at||Date.parse(alert.expires_at)<=now)history.push(alert);
  else if(Date.parse(alert.due_at)>now)upcoming.push(alert);
  else active.push(alert);
 }
 upcoming.reverse();

 async function acknowledge(id:string){
  setBusy(true);setError('');
  try{
   await api('/alerts/'+id+'/ack','POST',{});
   setAlerts(current=>current?.map(alert=>alert.id===id?{...alert,acknowledged_at:new Date().toISOString()}:alert)??null);
   void onChange().catch(()=>{});
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }

 function row(alert:Alert,state:'active'|'upcoming'|'history'){
  return <article key={alert.id}>
   <small>{format.format(new Date(alert.due_at))} МСК{state==='history'&&
    (alert.acknowledged_at?' · Просмотрено':alert.canceled_at?' · Отменено':' · Срок напоминания истёк')}</small>
   <p>{alert.body}</p>
   <div className="task-scope-actions">
    {alert.task_id&&<button className="text-button" type="button" onClick={()=>open(alert.task_id!)}>К задаче #{alert.task_id}</button>}
    {state==='active'&&!readOnly&&<button className="button secondary" type="button" disabled={busy}
     onClick={()=>void acknowledge(alert.id)}>Отметить просмотренным</button>}
   </div>
  </article>;
 }

 return <section className="panel reminder-inbox">
  <h2>Напоминания</h2>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {!alerts&&!error&&<p role="status">Загружаем напоминания…</p>}
  {alerts&&<>
   {active.length?active.map(alert=>row(alert,'active')):<p className="empty">Сейчас нет напоминаний к просмотру.</p>}
   {upcoming.length>0&&<details className="report-more"><summary>Запланированные · {upcoming.length}</summary>{upcoming.map(alert=>row(alert,'upcoming'))}</details>}
   {history.length>0&&<details className="report-more"><summary>История · {history.length}</summary>{history.map(alert=>row(alert,'history'))}</details>}
  </>}
 </section>;
}
