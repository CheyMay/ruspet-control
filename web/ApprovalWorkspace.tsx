import {useEffect,useState,type ReactNode} from 'react';
import {Search} from 'lucide-react';
import {businessDay} from '../shared/queues.js';
import type {Approval,Bootstrap} from '../shared/types.js';
import {api} from './api.js';
import {EmployeeFilter,matchesFilter} from './SearchFilter.js';
import {activeTaskApproval,approvalTurn} from '../shared/actions.js';

const approvalKinds=[{id:'deadline',label:'Переносы сроков'},{id:'completion',label:'Закрытие задач'}] as const;
type BatchStatus={head:{name:string;linked:boolean};total:number;last:{created_at:string;state:string|null}|null;
 rows:{id:string;name:string;processed:number;waiting:number;approved:number;ready:number}[]};
export function DirectorBatch({stamp}:{stamp:string}){
 const [data,setData]=useState<BatchStatus|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const load=()=>api<BatchStatus|null>('/director-approval-batches');
 useEffect(()=>{let live=true;void load().then(data=>{if(live)setData(data);}).catch(error=>{if(live)setMessage(error.message);});return()=>{live=false;};},[stamp]);
 async function send(){
  setBusy(true);setMessage('');
  try{
   const result=await api<{count:number}>('/director-approval-batches','POST',{});
   setMessage('Передано на согласование: '+result.count+'.');
   setData(await load());
  }catch(error){setMessage((error as Error).message);}finally{setBusy(false);}
 }
 if(!data)return message?<p role="status">{message}</p>:null;
 const last=data.last?.state;
 return <section className="panel director-approval-panel">
  <div className="director-approval-heading"><div><h2>Пакет для {data.head.name}</h2>
   <p>{data.total?`К отправке · ${data.total}. Рабочий ориентир — собрать пакет к 15:00 МСК.`:'Новых запросов для отправки нет.'} {!data.head.linked?'Получатель увидит пакет на сайте. Telegram ещё не привязан.':''}</p>
  </div><button className="button primary" disabled={!data.total||busy} onClick={()=>void send()}>Отправить пакет</button></div>
   {data.rows.length>0&&<div className="director-approval-table"><table><thead><tr><th>Сотрудник</th><th>Обработано сегодня</th><th>На первом этапе</th><th>Первый этап пройден сегодня</th><th>В пакете</th></tr></thead>
   <tbody>{data.rows.map(row=><tr key={row.id}><th scope="row">{row.name}</th><td>{row.processed}</td><td>{row.waiting}</td><td>{row.approved}</td><td>{row.ready}</td></tr>)}</tbody></table></div>}
  {data.last&&<small>Последний пакет · {last==='sent'?'доставлен в Telegram':last==='failed'?'Telegram отклонил сообщение':last==='uncertain'?'доставка в Telegram не подтверждена':'сохранён в уведомлениях'}</small>}
  {message&&<p role="status">{message}</p>}
 </section>;
}

export function ApprovalWorkspace({data,render,readOnly=false,startOnMine=false}:{data:Bootstrap;render:(a:Approval)=>ReactNode;readOnly?:boolean;startOnMine?:boolean}){
 const taskIndex=new Map(data.tasks.map(task=>[task.id,task]));
 const current=(a:Approval)=>approvalTurn(a).userId;
 const active=(approval:Approval)=>{
  const task=taskIndex.get(approval.task_id);
  return !!task&&activeTaskApproval(task,approval);
 };
 const mine=data.approvals.filter(a=>active(a)&&current(a)===data.user.id).length;
 const [section,setTab]=useState<'mine'|'open'|'requests'|'history'>(()=>mine||startOnMine?'mine':data.user.role==='employee'?'requests':'open');
 const [query,setQuery]=useState('');
 const [owner,setOwner]=useState('all'),[actor,setActor]=useState('all'),[type,setType]=useState<'deadline'|'completion'|null>(null);
 const [from,setFrom]=useState(''),[to,setTo]=useState(''),[status,setStatus]=useState('all'),[limit,setLimit]=useState(12);
 const waiting=(a:Approval)=>!!a.clarification_requested_at&&!a.clarification_answered_at;
 useEffect(()=>{if(!readOnly)void api('/approvals/history-refresh','POST',{}, {timeout:8000}).catch(()=>{});},
  [data.user.id,readOnly]);
 const batch=new URLSearchParams(location.search).get('batch');
 const [batchItems,setBatchItems]=useState<{id:string}[]|null>(null),[batchError,setBatchError]=useState('');
 useEffect(()=>{
  if(!batch||readOnly)return;
  let live=true;
  void api<{id:string}[]>('/director-approval-batches/'+encodeURIComponent(batch))
   .then(rows=>{if(live){setBatchItems(rows);setBatchError('');}}).catch(error=>{if(live)setBatchError(error.message);});
  return()=>{live=false;};
 },[batch,data.serverTime,readOnly]);
 if(batch&&!readOnly){
  const ids=new Set(batchItems?.map(item=>item.id));
  const selected=data.approvals.filter(a=>ids.has(a.id));
  return <><section className="panel director-approval-panel"><h2>Пакет согласований</h2>
   <p>{batchError||(batchItems?selected.length?'Осталось запросов: '+selected.length+'.':'Все запросы пакета обработаны.':'Загружаем запросы…')}</p>
   <a className="text-button" href="/?view=approvals">Все согласования</a>
  </section>{approvalKinds.map(kind=>{
   const group=selected.filter(a=>a.type===kind.id);
   return group.length>0&&<section className="approval-group" key={kind.id}><h2>{kind.label}</h2>
    <div className="approval-list">{group.map(a=><div key={a.id}>{render(a)}</div>)}</div></section>;
  })}</>;
 }
 const tabLabels={mine:'От меня ждут решения',open:'Все открытые',requests:'Мои запросы',history:'История'};
 const states={pending:'На решении',clarification:'Нужно уточнение',approved:'Согласовано',rejected:'Отклонено',stale:'Неактуально',canceled:'Отменено'};
 const state=(a:Approval)=>a.canceled_at?'canceled':active(a)?waiting(a)?'clarification':'pending':a.state==='pending'?'stale':a.state;
 const scoped=data.approvals.filter(a=>section==='mine'?active(a)&&current(a)===data.user.id:
  section==='open'?active(a):section==='requests'?a.requester_id===data.user.id:!active(a));
 const owners=new Set(scoped.map(a=>taskIndex.get(a.task_id)?.assignee_id));
 const actors=new Set(scoped.map(current));
 const items=scoped.filter(a=>{
  const task=taskIndex.get(a.task_id);
  return (status==='all'||state(a)===status)&&(owner==='all'||task?.assignee_id===owner)&&(actor==='all'||current(a)===actor)&&
   (!from||businessDay(a.created_at)>=from)&&(!to||businessDay(a.created_at)<=to)&&
   matchesFilter(`${a.task_id} ${task?.title||''} ${a.reason}`,query.replace(/#/g,''));
 });
 const selectedType=type??(startOnMine||items.some(a=>a.type==='deadline')?'deadline':'completion');
 const queue=items.filter(a=>a.type===selectedType);
 const filtered=!!(query||owner!=='all'||actor!=='all'||from||to||status!=='all');
 const openStates=section==='mine'||section==='open';
 return <>
  <div className="tabs approval-kind-tabs" aria-label="Показать согласования">
   {(Object.keys(tabLabels) as (keyof typeof tabLabels)[]).map(key=><button type="button" key={key} className={section===key?'selected':''}
    aria-pressed={section===key} onClick={()=>{setTab(key);setType(null);setStatus('all');setOwner('all');setActor('all');setLimit(12);}}>
    {tabLabels[key]}{key==='mine'&&<small>{mine}</small>}
   </button>)}
  </div>
  <div className="tabs approval-kind-tabs" aria-label="Тип согласования">{approvalKinds.map(kind=>
   <button type="button" key={kind.id} className={selectedType===kind.id?'selected':''} aria-pressed={selectedType===kind.id} onClick={()=>{setType(kind.id);setLimit(12);}}>
    {kind.label} <small>{items.filter(a=>a.type===kind.id).length}</small>
   </button>)}</div>
  <section className="panel approval-queue-tools"><div className="filters">
   <label className="search-input work-search"><Search size={17}/>
    <input aria-label="Поиск согласования" placeholder="Номер, название или причина" value={query} onChange={e=>{setQuery(e.target.value);setLimit(12);}}/>
   </label>
   <details className="work-filters">
    <summary className="button secondary">Фильтры{filtered?' · активны':''}</summary>
    <div className="panel work-filter-panel">
     <EmployeeFilter caption="Исполнитель задачи" label="Исполнитель задачи" value={owner} onChange={setOwner}
      empty={{value:'all',label:'Все исполнители'}} people={data.users.filter(u=>owners.has(u.id)||u.id===owner)}/>
     <EmployeeFilter caption="Участник шага" label="Участник шага" value={actor} onChange={setActor}
      empty={{value:'all',label:'Любой участник'}} people={data.users.filter(u=>actors.has(u.id)||u.id===actor)}/>
     <label>Состояние<select value={status} onChange={e=>setStatus(e.target.value)}>
      <option value="all">Любое состояние</option>{Object.entries(states)
       .filter(([key])=>section==='requests'||(key==='pending'||key==='clarification')===openStates)
       .map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
     <div className="work-filter-dates"><label>Запрос с<input type="date" aria-label="Дата запроса от" max={to||undefined} value={from} onChange={e=>setFrom(e.target.value)}/></label>
      <label>По<input type="date" aria-label="Дата запроса до" min={from||undefined} value={to} onChange={e=>setTo(e.target.value)}/></label></div>
    </div>
   </details>
   {filtered&&<button type="button" className="text-button" onClick={()=>{setQuery('');setOwner('all');setActor('all');setStatus('all');setFrom('');setTo('');setLimit(12);}}>Сбросить</button>}
   <span className="muted">Найдено {queue.length}</span>
  </div></section>
  <div className="approval-list">{queue.slice(0,limit).map(a=><div key={a.id}>{render(a)}</div>)}
   {queue.length>limit&&<button type="button" className="button secondary" onClick={()=>setLimit(limit+12)}>Показать ещё · {Math.min(queue.length-limit,12)}</button>}
   {!queue.length&&<section className="panel empty"><h3>{filtered?'По этим фильтрам запросов нет':section==='mine'?'Сейчас от вас не ждут решения':'В этом списке пока нет запросов'}</h3>
    <p>{filtered?'Проверьте поиск, сотрудника и даты.':section==='mine'?'Другие доступные запросы есть во вкладке «Все открытые».':'Выберите другой тип согласования или вкладку.'}</p></section>}
  </div>
 </>;
}
