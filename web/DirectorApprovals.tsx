import {TaskId} from './TaskId.js';
import {useEffect,useState} from 'react';
import {api} from './api.js';

export function DirectorBatchPanel({refreshKey}:{refreshKey:string}){
 const [count,setCount]=useState(0),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 useEffect(()=>{
  let active=true;
  void api<{count:number}>('/director-approval-batches').then(value=>{if(active)setCount(value.count);}).catch(error=>{if(active)setStatus(error.message);});
  return ()=>{active=false;};
 },[refreshKey]);
 async function send(){
  setBusy(true);setStatus('');
  try{
   const result=await api<{count:number}>('/director-approval-batches','POST',{});
   setCount(0);setStatus(result.count?'В очередь отправлен пакет. Запросов: '+result.count+'.':'Новых запросов для пакета больше нет.');
  }catch(error){setStatus((error as Error).message);}
  finally{setBusy(false);}
 }
 return <section className="panel director-approval-panel"><h2>Пакет для руководителя продаж</h2>
  <p>Переносы, готовые к отправке: {count}</p>
  <button type="button" className="button primary" disabled={busy||!count} onClick={()=>void send()}>Отправить пакет</button>
  {status&&<p role="status">{status}</p>}
 </section>;
}

type WeeklyTask={id:string;number:string;title:string;assignee:string;watched:boolean;required:boolean};
export function DirectorWeeklyTasks({week,open}:{week:string;open:(id:string)=>void}){
 const [rows,setRows]=useState<WeeklyTask[]|null>(null),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;
  void api<WeeklyTask[]>('/director-weekly-tasks?week='+encodeURIComponent(week))
   .then(value=>{if(active)setRows(value);}).catch(error=>{if(active)setError(error.message);});
  return ()=>{active=false;};
 },[week]);
 async function select(id:string,enabled:boolean){
  setBusy(id);setError('');
  try{
   await api('/tasks/'+encodeURIComponent(id)+'/approval-watch','PUT',{enabled});
   setRows(current=>current?.map(task=>task.id===id?{...task,watched:enabled}:task)??null);
  }catch(error){setError((error as Error).message);}
  finally{setBusy(null);}
 }
 return <section className="panel director-approval-panel">
  <h2>Задачи с прошлой недели в работе</h2>
  <p>Отметьте задачи, переносы по которым хотите согласовывать. Перед вашим решением запрос увидит постановщик.</p>
  <a className="text-button" href="/?view=approvals">Открыть согласования</a>
  {error&&<p role="alert">{error}</p>}
  {!rows&&!error&&<p>Загружаем задачи…</p>}
  {rows?.length===0&&<p>Нет задач в работе за этот период.</p>}
  {rows?.map(task=><article key={task.id} className="incident-row">
   <div><TaskId number={task.number}/> · <button className="text-button" type="button" onClick={()=>open(task.id)}>{task.title}</button><p>Исполнитель · {task.assignee}</p></div>
   <label><input type="checkbox" checked={task.watched||task.required} disabled={task.required||busy!==null}
    onChange={e=>void select(task.id,e.target.checked)}/> {task.required?'Уже в маршруте':'Согласовывать переносы'}</label>
  </article>)}
 </section>;
}
