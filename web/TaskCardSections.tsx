import {useState} from 'react';
import {TaskIntegration} from './TaskIntegration.js';
import type {Task,User} from '../shared/types.js';
import type {TaskEditAccess} from '../shared/task-edit.js';

type Act=(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>;

export function TaskEditPanel({task,access,users,busy,act}:{task:Task;access:TaskEditAccess;users:User[];busy:boolean;act:Act}){
 const [reason,setReason]=useState(''),[comment,setComment]=useState('');
 const {request,canRequest,canDecide}=access;
 if(!request&&!canRequest)return null;
 const base='/tasks/'+encodeURIComponent(task.id)+'/edit-permissions';
 const labels={pending:'Ожидает решения',approved:'Разрешено одно сохранение',rejected:'Отклонён',used:'Использовано'};
 async function decide(decision:'approve'|'reject'){
  if(!request)return;
  if(await act(base+'/'+request.id+'/decision',{decision,comment},'POST',decision==='approve'?'Правка разрешена':'Запрос отклонён'))setComment('');
 }
 return <section className="task-card-section edit-permission-panel">
  <h3>Разрешение на редактирование</h3>
  {request&&<div className="edit-permission-summary">
   <strong>{labels[request.state]}</strong>
   <span>{users.find(person=>person.id===request.requesterId)?.name||'Исполнитель'}</span>
   <p>{request.reason}</p>
   {request.decisionComment&&<p className="muted">{request.decisionComment}</p>}
  </div>}
  {canDecide&&<>
   <label>Комментарий к решению<textarea value={comment} maxLength={4000} onChange={e=>setComment(e.target.value)}/></label>
   <div className="task-card-buttons"><button className="button primary" disabled={busy} onClick={()=>void decide('approve')}>Разрешить</button>
    <button className="button secondary" disabled={busy} onClick={()=>void decide('reject')}>Отклонить</button></div>
  </>}
  {canRequest&&<form onSubmit={async e=>{
   e.preventDefault();
   if(await act(base,{expectedVersion:task.version,reason},'POST','Запрос отправлен постановщику'))setReason('');
  }}>
   <label>Что нужно изменить<textarea value={reason} onChange={e=>setReason(e.target.value)} required minLength={5} maxLength={4000}/></label>
   <p className="muted">Постановщик получит запрос. Разрешение действует на одно сохранение текущей версии.</p>
   <div className="task-card-buttons"><button className="button primary" disabled={busy||reason.trim().length<5}>Отправить запрос</button></div>
  </form>}
 </section>;
}

const flag=(value:boolean|null)=>value===null?'Не указано':value?'Да':'Нет';
export function TaskCardFields({task,showPlanning,date}:{task:Task;showPlanning:boolean;date:(value:string|null,full?:boolean)=>string}){
 const source=Object.entries(task.source_fields??{}).filter(([key])=>showPlanning||!/план/iu.test(key));
 return <>
  <section className="task-card-section">
   <h3>Параметры</h3>
   <dl className="task-card-fields">
    <div><dt>Важная задача</dt><dd>{flag(task.important)}</dd></div>
    <div><dt>Риск потери клиента</dt><dd>{flag(task.customer_risk)}</dd></div>
    <div><dt>Родительская задача</dt><dd>{task.parent_id?'#'+task.parent_id:'Не указана'}</dd></div>
    <div><dt>Первоначальный крайний срок</dt><dd>{date(task.original_deadline,true)}</dd></div>
    {showPlanning&&<><div><dt>Плановое начало · МСК</dt><dd>{date(task.planned_start??null,true)}</dd></div>
     <div><dt>Плановое окончание · МСК</dt><dd>{date(task.planned_end,true)}</dd></div></>}
   </dl>
  </section>
  <section className="task-card-section">
   <h3>Дополнительные поля</h3>
   {task.custom_fields?.length?<dl className="task-card-fields">{task.custom_fields.map(field=><div key={field.label}><dt>{field.label}</dt><dd>{field.value||'Не заполнено'}</dd></div>)}</dl>:<p className="muted">Дополнительных полей нет.</p>}
  </section>
  {source.length>0&&<details className="task-card-section source-fields"><summary>Исходные поля выгрузки</summary>
   <dl className="task-card-fields">{source.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value===null||value===''?'Не заполнено':String(value)}</dd></div>)}</dl>
  </details>}
  <TaskIntegration id={task.id} version={task.version}/>
 </>;
}
