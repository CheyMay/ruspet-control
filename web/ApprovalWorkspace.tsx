import {useRememberedFilter} from './remembered-filter.js';
import {useEffect,useState,type ReactNode} from 'react';
import {businessDay} from '../shared/queues.js';
import type {Approval,Bootstrap} from '../shared/types.js';
import {HelpHint} from './Management.js';
import {api} from './api.js';

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
   <p>{data.total?'Готово к отправке: '+data.total+'.':'Новых запросов для отправки нет.'} {!data.head.linked?'Получатель увидит пакет на сайте. Telegram ещё не привязан.':''}</p>
  </div><button className="button primary" disabled={!data.total||busy} onClick={()=>void send()}>Отправить пакет</button></div>
  {data.rows.length>0&&<div className="director-approval-table"><table><thead><tr><th>Сотрудник</th><th>Обработано сегодня</th><th>У рукфила</th><th>Рукфил согласовал сегодня</th><th>В пакете</th></tr></thead>
   <tbody>{data.rows.map(row=><tr key={row.id}><th scope="row">{row.name}</th><td>{row.processed}</td><td>{row.waiting}</td><td>{row.approved}</td><td>{row.ready}</td></tr>)}</tbody></table></div>}
  {data.last&&<small>Последний пакет · {last==='sent'?'доставлен в Telegram':last==='failed'?'Telegram отклонил сообщение':last==='uncertain'?'доставка в Telegram не подтверждена':'сохранён в уведомлениях'}</small>}
  {message&&<p role="status">{message}</p>}
 </section>;
}

export function ApprovalWorkspace({data,render,readOnly=false}:{data:Bootstrap;render:(a:Approval)=>ReactNode;readOnly?:boolean}){
 const [tab,setTab]=useRememberedFilter(data.user.id,'ApprovalWorkspace.tab','pending'),[query,setQuery]=useState(''),[owner,setOwner]=useRememberedFilter(data.user.id,'ApprovalWorkspace.owner','all'),[actor,setActor]=useRememberedFilter(data.user.id,'ApprovalWorkspace.actor','all'),[type,setType]=useRememberedFilter(data.user.id,'ApprovalWorkspace.type','all'),[from,setFrom]=useRememberedFilter(data.user.id,'ApprovalWorkspace.from',''),[to,setTo]=useRememberedFilter(data.user.id,'ApprovalWorkspace.to','');
 const waiting=(a:Approval)=>!!a.clarification_requested_at&&!a.clarification_answered_at;
 const current=(a:Approval)=>waiting(a)?a.requester_id:a.route[a.current_step]?.userId;
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
  </section><div className="approval-list">{selected.map(a=><div key={a.id}>{render(a)}</div>)}</div></>;
 }
 const items=data.approvals.filter(a=>{const t=data.tasks.find(t=>t.id===a.task_id);return (tab==='all'||tab==='mine'&&a.state==='pending'&&current(a)===data.user.id||tab==='clarification'&&a.state==='pending'&&waiting(a)||tab==='canceled'&&!!a.canceled_at||a.state===tab&&!a.canceled_at)&&(owner==='all'||t?.assignee_id===owner)&&(actor==='all'||current(a)===actor)&&(type==='all'||a.type===type)&&(!from||businessDay(a.created_at)>=from)&&(!to||businessDay(a.created_at)<=to)&&`${a.task_id} ${t?.title||''} ${a.reason}`.toLowerCase().includes(query.toLowerCase())});
 return <><div className="tabs">{Object.entries({pending:'Ожидают решения',mine:'Моё действие',clarification:'Ждём уточнения',approved:'Согласовано',rejected:'Отказано',stale:'Устарели',canceled:'Отменено',all:'Вся история'}).map(([id,label])=><button key={id} className={tab===id?'selected':''} onClick={()=>setTab(id)}>{label}</button>)}</div><section className="panel"><div className="filters"><input aria-label="Поиск согласования" placeholder="Номер, название или причина" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="Исполнитель задачи" value={owner} onChange={e=>setOwner(e.target.value)}><option value="all">Все исполнители</option>{data.users.filter(u=>data.tasks.some(t=>t.assignee_id===u.id)).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><select aria-label="У кого сейчас запрос" value={actor} onChange={e=>setActor(e.target.value)}><option value="all">У любого участника</option>{data.users.filter(u=>data.approvals.some(a=>current(a)===u.id)).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><select aria-label="Тип запроса" value={type} onChange={e=>setType(e.target.value)}><option value="all">Все типы</option><option value="deadline">Перенос крайнего срока</option><option value="completion">Закрытие задачи</option></select><label className="date-filter">Запрос с<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="date-filter">по<input type="date" min={from} value={to} onChange={e=>setTo(e.target.value)}/></label><HelpHint text="Дата относится к созданию запроса. Фильтр «У кого» показывает участника, от которого сейчас требуется действие: согласующего или автора, если он должен ответить на уточнение."/><span>Найдено {items.length}</span></div></section><div className="approval-list">{items.map(a=><div key={a.id}>{render(a)}</div>)}{!items.length&&<section className="panel empty"><h3>Согласований с такими условиями нет</h3><p>Измените вкладку, участника или период.</p></section>}</div></>;
}
