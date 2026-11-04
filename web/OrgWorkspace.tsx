import {useEffect,useState,type FormEvent} from 'react';
import {api} from './api.js';
import {moscowTimestamp} from './SystemHealth.js';
import {businessDay} from '../shared/queues.js';

type Person={id:string;name:string;role:string;branch_id:string;manager_id:string|null};
type Substitution={id:string;manager_id:string;deputy_id:string;starts_at:string;ends_at:string};
type Directory={people:Person[];substitutions:Substitution[]};
type Entry={id:string;title:string;sourceId:string|null;sourceTitle:string|null;status:'active'|'review'|'completed';deadline:string|null;assignee:string;manager:string;substitution:boolean};
const errorText=(e:unknown)=>e instanceof Error?e.message:'Не удалось выполнить запрос.';

export function OrgWorkspace({roles}:{roles:Record<string,string>}){
 const [data,setData]=useState<Directory|null>(null),[query,setQuery]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 useEffect(()=>{
  let active=true;
  void api<Directory>('/org').then(value=>{if(active)setData(value);}).catch(e=>{if(active)setError(errorText(e));});
  return()=>{active=false;};
 },[reload]);
 const people=data?.people??[],managers=people.filter(person=>person.role!=='employee');
 const visible=people.filter(p=>(p.name+' '+p.branch_id).toLowerCase().includes(query.trim().toLowerCase()));
 const name=(id:string)=>people.find(p=>p.id===id)?.name||'Сотрудник';
 async function save(path:string,method:string,body?:unknown){
  setBusy(true);setError('');setNotice('');
  try{await api(path,method,body);setNotice('Сохранено.');setReload(n=>n+1);}
  catch(e){setError(errorText(e));}finally{setBusy(false);}
 }
 function substitute(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  const fields=new FormData(event.currentTarget);
  void save('/org/substitutions','POST',{managerId:fields.get('managerId'),deputyId:fields.get('deputyId'),startsAt:fields.get('startsAt')+':00+03:00',endsAt:fields.get('endsAt')+':00+03:00'});
 }
 return <>
  {error&&<p className="alert error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <section className="panel automation-settings"><h2>Оргструктура</h2>
   <p className="muted">Укажите прямого руководителя. Связь применяется при делегировании. Если руководитель ещё не настроил команду, используется прежняя выборка по роли и филиалу.</p>
   <div className="filters"><input aria-label="Найти сотрудника" placeholder="Имя или филиал" value={query} onChange={e=>setQuery(e.target.value)}/></div>
   {!data&&!error&&<p>Загружаем сотрудников…</p>}
   <div className="table-scroll"><table><thead><tr><th>Сотрудник</th><th>Роль и филиал</th><th>Прямой руководитель</th></tr></thead><tbody>
    {visible.map(p=><tr key={p.id}><td>{p.name}</td><td>{roles[p.role]} · {p.branch_id}</td><td><select aria-label={'Руководитель для '+p.name} value={p.manager_id??''} disabled={busy}
     onChange={e=>void save('/org/reporting/'+encodeURIComponent(p.id),'PUT',{managerId:e.target.value||null})}>
      <option value="">Не назначен</option>{managers.filter(m=>m.id!==p.id).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
     </select></td></tr>)}
   </tbody></table></div>
  </section>
  <section className="panel automation-settings"><h2>Замещения</h2>
   <p className="muted">На заданный период заместитель видит поручения руководителя в своей области доступа и может делегировать его доступные задачи.</p>
   <form className="work-design-form" onSubmit={substitute}><div className="editor-grid">
    {([['managerId','Кого замещают'],['deputyId','Кто замещает']] as const).map(([field,label])=><label key={field}>{label}<select name={field} required defaultValue=""><option value="" disabled>Выберите</option>{managers.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label>)}
    <label>С · МСК<input name="startsAt" type="datetime-local" required/></label><label>До · МСК<input name="endsAt" type="datetime-local" required/></label>
   </div><button className="button primary" disabled={busy}>Назначить замещение</button></form>
   {data?.substitutions.length===0&&<p>Запланированных и действующих замещений нет.</p>}
   {data?.substitutions.map(s=><div className="automation-run" key={s.id}><div><strong>{name(s.manager_id)} → {name(s.deputy_id)}</strong>
    <p>{moscowTimestamp(s.starts_at)} — {moscowTimestamp(s.ends_at)}</p></div>
    <button className="button secondary" disabled={busy} onClick={()=>void save('/org/substitutions/'+s.id,'DELETE')}>Завершить</button></div>)}
  </section>
 </>;
}
const filters={all:'Все',overdue:'Просрочены',today:'Срок сегодня',review:'На приёмке',completed:'Завершены'} as const;
export function DelegationInbox({open}:{open:(id:string)=>void}){
 const [entries,setEntries]=useState<Entry[]|null>(null),[error,setError]=useState(''),[filter,setFilter]=useState<keyof typeof filters>('all'),[query,setQuery]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{
  let active=true;
  const load=()=>void api<Entry[]>('/delegations').then(rows=>{if(active){setEntries(rows);setError('');}}).catch(e=>{if(active)setError(errorText(e));});
  load();const timer=setInterval(load,30000);
  return()=>{active=false;clearInterval(timer);};
 },[reload]);
 const today=businessDay(new Date());
 const matches=(entry:Entry,key:keyof typeof filters)=>{
  if(key==='all')return true;
  if(key==='overdue')return entry.status==='active'&&!!entry.deadline&&businessDay(entry.deadline)<today;
  if(key==='today')return entry.status==='active'&&!!entry.deadline&&businessDay(entry.deadline)===today;
  return entry.status===key;
 };
 const visible=entries?.filter(row=>matches(row,filter)&&[row.title,row.assignee,row.id,row.sourceTitle].some(text=>text?.toLowerCase().includes(query.trim().toLowerCase())));
 return <section className="panel automation-settings"><h2>Мои поручения</h2><p className="muted">Ваши поручения и поручения руководителей, которых вы сейчас замещаете.</p>
  <div className="tabs">{Object.entries(filters).map(([id,label])=><button className={id===filter?'selected':''} key={id} onClick={()=>setFilter(id as keyof typeof filters)}>{label}<span>{entries?.filter(row=>matches(row,id as keyof typeof filters)).length??'—'}</span></button>)}</div>
  <div className="filters"><input aria-label="Поиск поручения" placeholder="Задача, номер или исполнитель" value={query} onChange={e=>setQuery(e.target.value)}/><button className="button secondary" onClick={()=>setReload(n=>n+1)}>Обновить</button></div>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {!entries&&!error&&<p>Загружаем поручения…</p>}
  {visible?.length===0&&<p>В этой выборке пока нет поручений.</p>}
  {!!visible?.length&&<div className="table-scroll"><table><thead><tr><th>Поручение</th><th>Исполнитель</th><th>Крайний срок</th><th>Состояние</th><th>Исходная задача</th></tr></thead><tbody>
   {visible.map(row=><tr key={row.id}><td><button className="text-button" onClick={()=>open(row.id)}>#{row.id} · {row.title}</button>{row.substitution&&<small>Замещение · {row.manager}</small>}</td>
    <td>{row.assignee}</td><td className={matches(row,'overdue')?'red-text':undefined}>{moscowTimestamp(row.deadline)}</td>
    <td>{row.status==='active'?'В работе':filters[row.status]}</td><td>{row.sourceId?<button className="text-button" onClick={()=>open(row.sourceId!)}>#{row.sourceId} · {row.sourceTitle}</button>:'—'}</td></tr>)}
  </tbody></table></div>}
 </section>;
}
