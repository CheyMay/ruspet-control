import {useEffect,useState,type FormEvent} from 'react';
import {api} from './api.js';
import {moscowTimestamp} from './SystemHealth.js';
import type {Task,User} from '../shared/types.js';

type LinkedTask={id:string;title:string;status:Task['status'];assignee_id:string};
type Links={canDelegate:boolean;source:LinkedTask|null;copies:LinkedTask[]};
type Targets=import('../shared/company-responsibility.js').DelegationTargets;
const status:Record<Task['status'],string>={active:'В работе',review:'На приёмке',completed:'Завершено'};
const moscowInput=(value:string|null)=>value?new Date(Date.parse(value)+10800000).toISOString().slice(0,16):'';

export function TaskDelegation({task,user,users,open,onCreated}:{task:Task;user:User;users:User[];open:(id:string)=>void;onCreated:()=>void}){

 const [links,setLinks]=useState<Links|null>(null),[show,setShow]=useState(false),[targets,setTargets]=useState<Targets|null>(null);
 const available=links?.canDelegate??(user.role!=='employee'&&task.assignee_id===user.id&&task.status==='active');
 const [manual,setManual]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[linkError,setLinkError]=useState(''),[newId,setNewId]=useState<string|null>(null);
 useEffect(()=>{
  let active=true;
  void api<Links>('/tasks/'+encodeURIComponent(task.id)+'/delegation').then(result=>{if(active){setLinks(result);setLinkError('');}}).catch(e=>{if(active)setLinkError(e.message);});
  return()=>{active=false;};
 },[task.id,task.version,newId]);
 useEffect(()=>{
  if(!show)return;
  let active=true;
  void api<Targets>('/tasks/'+encodeURIComponent(task.id)+'/delegation-targets').then(result=>{
   if(!active)return;
   if(result.version!==task.version){setError('Карточка изменилась. Откройте задачу заново.');return;}
   setTargets(result);
  }).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[show,task.id,task.version]);
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!targets)return;
  setBusy(true);setError('');
  const fields=new FormData(event.currentTarget),date=String(fields.get('deadline')||'');
  try{
   const copy=await api<{id:string}>('/tasks/'+encodeURIComponent(task.id)+'/delegate','POST',{
    ...(targets.responsibility.managerId&&!manual?{responsibilityToken:targets.responsibility.token}:{assigneeId:fields.get('assigneeId')}),instruction:fields.get('instruction'),expectedVersion:task.version,
    ...(date!==moscowInput(task.deadline)?{deadline:date?new Date(date+':00+03:00').toISOString():null}:{})
   });
   setNewId(copy.id);setShow(false);onCreated();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 if(!available&&!links?.source&&!links?.copies.length&&!task.delegated_from_id)return null;
 return <section className="task-delegation">
  <div className="automation-heading"><h3>Делегирование</h3>{available&&<button className="button secondary" type="button" onClick={()=>{setTargets(null);setManual(false);setError('');setShow(true);}}>Делегировать задачу</button>}</div>
  {links?.source&&<p>Исходная задача · <button className="text-button" onClick={()=>open(links.source!.id)}>#{links.source.id} · {links.source.title}</button></p>}
  {task.delegated_from_id&&!links?.source&&<p className="muted">Поручение от руководителя</p>}
  {linkError&&<p className="red-text" role="alert">{linkError}</p>}
  {newId&&<p role="status">Поручение создано · <button className="text-button" onClick={()=>open(newId)}>Открыть #{newId}</button></p>}
  {links?.copies.map(copy=><div className="automation-run" key={copy.id}><div>
   <button className="text-button" onClick={()=>open(copy.id)}>#{copy.id} · {copy.title}</button>
   <p>{users.find(person=>person.id===copy.assignee_id)?.name||'Исполнитель'} · {status[copy.status]}</p>
  </div></div>)}
  {show&&<div className="modal-backdrop"><form className="modal task-editor" role="dialog" aria-modal="true" aria-label="Делегировать задачу" onSubmit={submit}>
   <div className="panel-heading"><div><h2>Делегировать задачу</h2><p>#{task.id} · {task.title}</p></div><button type="button" className="text-button" disabled={busy} onClick={()=>setShow(false)}>Закрыть</button></div>
   <p className="muted">Исходная задача остаётся у своего руководителя. После приёмки всех поручений она автоматически перейдёт на приёмку. Цена поручения 0 ₽, бюджет остаётся в исходной задаче.</p>
   {error&&<p className="alert error" role="alert">{error}</p>}
   {!targets&&!error&&<p role="status">Загружаем подчинённых…</p>}
   {targets?.people.length===0&&<p>В вашей области нет доступных подчинённых.</p>}
   {!!targets?.people.length&&<>
    {targets.responsibility.managerId&&!manual?<div className="inline-note"><p>Ответственный компании «{targets.responsibility.companyName}»: <strong>{targets.responsibility.managerName}</strong> · {targets.responsibility.source==='bitrix'?'Битрикс24':'ОКБ'}</p><button type="button" className="text-button" onClick={()=>setManual(true)}>Выбрать другого сотрудника</button></div>:<><p className="muted">{targets.responsibility.reason||'Выберите другого доступного сотрудника.'}</p><label>Подчинённый<select name="assigneeId" defaultValue="" required><option value="" disabled>Выберите сотрудника</option>{targets.people.map(person=><option value={person.id} key={person.id}>{person.name} · {person.branch_id}</option>)}</select></label></>}
    <label>Крайний срок поручения · МСК<input name="deadline" type="datetime-local" defaultValue={moscowInput(task.deadline)}/></label>
    <p className="muted">Крайний срок исходной задачи · {moscowTimestamp(task.deadline)}</p>
    <label>Уточнение для исполнителя<textarea name="instruction" maxLength={2000} placeholder="Что именно сделать и какой результат ожидается"/></label>
    <div className="drawer-actions"><button type="button" className="button secondary" disabled={busy} onClick={()=>setShow(false)}>Отмена</button><button className="button primary" disabled={busy}>Создать поручение</button></div>
   </>}
  </form></div>}
 </section>;
}
