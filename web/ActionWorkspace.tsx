import {ArrowRight,CalendarClock,Clock3,ListChecks,Search,SlidersHorizontal} from 'lucide-react';
import {useMemo,useState} from 'react';
import {businessDay} from '../shared/queues.js';
import {canComplete} from '../shared/actions.js';
import {workLabels,workQueue,type WorkBucket,type WorkScope,type WorkTask} from '../shared/work-queue.js';
import type {Bootstrap,Task} from '../shared/types.js';
import {EmployeeFilter,matchesFilter} from './SearchFilter.js';
import './work-queue.css';

const buckets=['overdue','today','next','waiting'] as const;
const icons={overdue:Clock3,today:CalendarClock,next:ListChecks,waiting:Clock3};
const time=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
const shortDate=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const labels={answer:'Ответить',decision:'К согласованию',review:'Проверить результат',clarification:'К уточнению',
 edit_permission:'К запросу',rework:'К замечаниям'};
const kinds={all:'Любой шаг',execution:'Работа по задаче',assignment:'Приём назначения',decision:'Согласование',
 review:'Приёмка результата',answer:'Объяснение',clarification:'Уточнение',edit_permission:'Редактирование',rework:'Доработка'};
type Filter='all'|WorkBucket;
type Props={data:Bootstrap;open:(id:string,tab?:string)=>Promise<void>;complete?:(task:Task)=>void;
 busy?:boolean;initial?:Filter;queue?:ReturnType<typeof workQueue>};

export function ActionWorkspace({data,open,complete,busy=false,initial='all',queue:personal}:Props){
 const [scope,setScope]=useState<WorkScope>('mine'),[bucket,setBucket]=useState<Filter>(initial);
 const [query,setQuery]=useState(''),[kind,setKind]=useState('all'),[owner,setOwner]=useState('all');
 const [dateField,setDateField]=useState<'deadline'|'since'>('deadline'),[from,setFrom]=useState(''),[to,setTo]=useState('');
 const [limits,setLimits]=useState<Partial<Record<WorkBucket,number>>>({});
 const queue=useMemo(()=>scope==='mine'&&personal?personal:workQueue(data,scope),[data,scope,personal]);
 const people=useMemo(()=>new Map(data.users.map(user=>[user.id,user.name])),[data.users]);
 const name=(id:string|null)=>id?people.get(id)??'Сотрудник':'';
 const all=buckets.flatMap(key=>queue[key]);
 const responsible=new Set(all.map(row=>row.ownerId));
 const hasFilters=!!(query||kind!=='all'||owner!=='all'||from||to);
 const matches=(row:WorkTask)=>{
  const t=row.task,date=dateField==='deadline'?t.deadline:row.action?.since;
  return (kind==='all'||(row.needsAcceptance?'assignment':row.action?.kind??'execution')===kind)&&
   (owner==='all'||row.ownerId===owner)&&(!from||!!date&&businessDay(date)>=from)&&(!to||!!date&&businessDay(date)<=to)&&
   matchesFilter([t.title,t.id,name(t.assignee_id),name(t.creator_id),name(row.ownerId)].join(' '),query.replace(/#/g,''));
 };
 const displayed=Object.fromEntries(buckets.map(key=>[key,queue[key].filter(matches)])) as typeof queue;
 const chosen:readonly WorkBucket[]=bucket==='all'?buckets:[bucket];
 const total=buckets.reduce((count,key)=>count+displayed[key].length,0);
 const active=bucket==='all'?total:displayed[bucket].length;
 const earlier=displayed.overdue.filter(row=>row.deadlineState==='earlier').length;
 const expired=displayed.overdue.length-earlier;
 function changeScope(next:WorkScope){setScope(next);setOwner('all');setBucket('all');setLimits({});}
 function show(next:Filter){setBucket(next);setLimits({});}
 function clear(){setQuery('');setKind('all');setOwner('all');setFrom('');setTo('');setLimits({});}
 const queueLabels={overdue:'С прошлых дней · '+earlier+' / Истекло сегодня · '+expired,
  today:'Крайний срок ещё впереди',next:'Приём новых задач, ответы и решения',
  waiting:scope==='mine'?'По вашим задачам ход за другим участником':'На приёмке или согласовании'};
 function row(item:WorkTask){
  const task=item.task,myStep=item.ownerId===data.user.id;
  const finish=complete&&myStep&&task.assignee_id===data.user.id&&!item.action&&!item.needsAcceptance&&!item.pendingApproval&&canComplete(data.user,task,data.approvalScope);
  const button=item.action?labels[item.action.kind]:item.tab==='approvals'?'К согласованию':item.tab==='result'?'К результату':null;
  const deadline=task.deadline,clock=deadline?item.deadlineState==='today'?'До '+time.format(new Date(deadline))+' МСК':
   (item.deadlineState==='expired'?'Истёк сегодня в '+time.format(new Date(deadline)):'Крайний срок '+shortDate.format(new Date(deadline)))+' МСК':'';
  return <article className="work-row" key={task.id}>
   <div className="work-row-content">
    <div className="work-row-meta"><span>#{task.id}</span>{clock&&<span className={item.deadlineState==='expired'||item.deadlineState==='earlier'?'urgent':''}>{clock}</span>}</div>
    <button type="button" className="work-task-title" onClick={()=>void open(task.id)}>{task.title}</button>
    <div className="work-row-people"><span>Исполнитель · {name(task.assignee_id)}</span><span>Постановщик · {name(task.creator_id)}</span></div>
    {(item.label!=='Выполнить задачу'||!myStep)&&<p className="work-step">{myStep?'Ваш шаг':name(item.ownerId)||'Следующий шаг'} · {item.label}</p>}
   </div>
   <div className="work-row-action">
    {finish?<button type="button" className="button secondary" disabled={busy} onClick={()=>complete(task)}>Завершить</button>:
     button&&item.tab!=='info'&&<button type="button" className={'button '+(myStep?'primary':'secondary')} onClick={()=>void open(task.id,item.tab)}>{button}<ArrowRight size={15}/></button>}
   </div>
  </article>;
 }
 return <div className="work-queue">
  <div className="work-toolbar">
   {data.user.role!=='employee'&&<div className="task-role-switch" role="group" aria-label="Область задач">
    <button type="button" aria-pressed={scope==='mine'} onClick={()=>changeScope('mine')}>Мои</button>
    <button type="button" aria-pressed={scope==='team'} onClick={()=>changeScope('team')}>{data.user.role==='admin'?'Доступная команда':'Команда'}</button>
   </div>}
   <label className="search-input work-search"><Search size={17}/>
    <input aria-label="Поиск в сроках и действиях" placeholder="Номер, название или сотрудник" value={query} onChange={e=>{setQuery(e.target.value);setLimits({});}}/>
   </label>
   <details className="work-filters">
    <summary className="button secondary"><SlidersHorizontal size={16}/> Фильтры{hasFilters?' · активны':''}</summary>
    <div className="panel work-filter-panel">
     {scope==='team'||responsible.size>1?<EmployeeFilter caption="Следующий шаг у" label="У кого следующий шаг" value={owner} onChange={setOwner}
      empty={{value:'all',label:'У любого сотрудника'}} people={data.users.filter(user=>responsible.has(user.id)||user.id===owner)}/>:null}
     <label>Что нужно сделать<select value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(kinds).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
     <label>Какая дата<select value={dateField} onChange={e=>setDateField(e.target.value==='since'?'since':'deadline')}><option value="deadline">Крайний срок задачи</option><option value="since">Когда поступил запрос</option></select></label>
     <div className="work-filter-dates"><label>С<input aria-label="Дата от" type="date" max={to||undefined} value={from} onChange={e=>setFrom(e.target.value)}/></label>
      <label>По<input aria-label="Дата до" type="date" min={from||undefined} value={to} onChange={e=>setTo(e.target.value)}/></label></div>
    </div>
   </details>
  </div>
  <div className="work-cards" aria-label="Быстрый выбор списка">
   {buckets.map(key=>{const Icon=icons[key];return <button type="button" key={key}
    className={'work-card '+key} aria-pressed={bucket===key} onClick={()=>show(bucket===key?'all':key)}>
    <Icon size={18} aria-hidden="true"/><strong>{displayed[key].length}</strong><span>{workLabels[key]}</span><small>{queueLabels[key]}</small>
   </button>;})}
  </div>
  <div className="work-results-bar">
   {bucket!=='all'?<button type="button" className="text-button" onClick={()=>show('all')}>Все группы · {total}</button>:
    <span>{total} {total%100>=11&&total%100<=14?'задач':total%10===1?'задача':total%10>=2&&total%10<=4?'задачи':'задач'}</span>}
   {hasFilters&&<button type="button" className="text-button" onClick={clear}>Сбросить фильтры</button>}
  </div>
  {!active&&<section className="panel work-empty"><h2>{hasFilters?'По этим фильтрам задач нет':bucket==='all'?'Срочных задач и запросов нет':
   bucket==='waiting'?'Никого не ждём':bucket==='next'?'Новых запросов и решений нет':bucket==='overdue'?'Просрочек нет':'Сегодня больше нет срочных сроков'}</h2>
   <p>{hasFilters?'Измените поиск, дату или сотрудника.':bucket==='all'?'Новые назначения и запросы появятся здесь.':queueLabels[bucket]}</p></section>}
  {chosen.map(key=>{
   const tasks=displayed[key];if(!tasks.length)return null;
   const limit=limits[key]??(bucket==='all'?3:12),rows=tasks.slice(0,limit);
   return <section className={'panel work-group '+key} key={key}>
    <div className="work-group-heading"><h2>{workLabels[key]} <span>{tasks.length}</span></h2>
     {key==='overdue'&&<small>{queueLabels.overdue}</small>}</div>
    {rows.map(row)}
    {tasks.length>limit&&<button type="button" className="text-button work-more" onClick={()=>setLimits(previous=>({...previous,[key]:limit+12}))}>Показать ещё · {Math.min(tasks.length-limit,12)}</button>}
   </section>;
  })}
 </div>;
}
