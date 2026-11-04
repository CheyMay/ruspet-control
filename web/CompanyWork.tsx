import {useEffect,useState,type FormEvent} from 'react';
import {api} from './api.js';
import {moscowTimestamp} from './SystemHealth.js';
import type {User} from '../shared/types.js';

type Work={total:number;tasks:{id:string;title:string;assignee_id:string;status:string;deadline:string|null}[];history:{id:string;task_id:string;actor_id:string|null;message:string;created_at:string}[]};
type Contact={id:string;author_id:string;note:string;occurred_at:string};
const status:Record<string,string>={active:'В работе',review:'На приёмке',completed:'Завершена'};
export function CompanyWork({id,users,openTask,createTask,onContact}:{id:string;users:User[];openTask:(id:string)=>void;createTask:()=>void;onContact:()=>void}){
 const [work,setWork]=useState<Work|null>(null),[contacts,setContacts]=useState<Contact[]|null>(null);
 const [error,setError]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{
  let active=true;
  const path='/okb/companies/'+id;
  void Promise.all([api<Work>(path+'/work'),api<Contact[]>(path+'/contacts')]).then(([tasks,log])=>{
   if(active){setWork(tasks);setContacts(log);setError('');}
  }).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[id,reload]);
 const person=(id:string|null)=>users.find(u=>u.id===id)?.name||(id?'Сотрудник':'Система');
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();setBusy(true);setError('');
  try{await api('/okb/companies/'+id+'/contacts','POST',{note});setNote('');setReload(n=>n+1);onContact();}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <section className="okb-related">
  <div className="automation-heading"><h3>Работа с компанией</h3><button className="button primary" type="button" onClick={createTask}>Новая задача для компании</button></div>
  {error&&<p role="alert" className="alert error">{error}</p>}
  {!work&&!error&&<p role="status">Загружаем задачи и контакты…</p>}
  {work&&<><p className="muted">Связанные задачи · {work.total}{work.total>50?' · показано 50':''}</p>
   {work.total===0&&<p>Связанных задач пока нет.</p>}
   {work.tasks.map(task=><div className="automation-run" key={task.id}><div><button type="button" className="text-button task-link" onClick={()=>openTask(task.id)}>#{task.id} · {task.title}</button>
    <p>{status[task.status]??task.status} · {person(task.assignee_id)} · {moscowTimestamp(task.deadline)}</p></div></div>)}
   {!!work.history.length&&<details className="automation-log"><summary>Последние действия по задачам</summary>{work.history.map(entry=><p key={entry.id}>{moscowTimestamp(entry.created_at)} · {person(entry.actor_id)} · #{entry.task_id} · {entry.message}</p>)}</details>}
  </>}
  <details className="automation-log okb-contact-history"><summary>Контакты{contacts?' · '+contacts.length:''}</summary>
   <form className="work-design-form" onSubmit={save}><label>Что обсудили<textarea value={note} onChange={e=>setNote(e.target.value)} required minLength={3} maxLength={2000}/></label>
    <button className="button secondary" disabled={busy}>Зафиксировать контакт</button></form>
   {contacts?.length===0&&<p>Контакты ещё не отмечали.</p>}
   {contacts?.map(contact=><div className="automation-run" key={contact.id}><div><strong>{person(contact.author_id)} · {moscowTimestamp(contact.occurred_at)}</strong><p>{contact.note}</p></div></div>)}
  </details>
 </section>;
}
