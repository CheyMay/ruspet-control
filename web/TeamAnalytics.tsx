import {useEffect,useRef,useState} from 'react';
import {ArrowRight,ChartNoAxesCombined,ChevronDown,ChevronLeft,ChevronRight,RefreshCw} from 'lucide-react';
import {analyticsMetricLabels,type AnalyticsDay,type AnalyticsMetric,type AnalyticsNumbers,type AnalyticsOverview,type AnalyticsRow,type AnalyticsTask} from '../shared/team-analytics.js';
import {api} from './api.js';
import './team-analytics.css';

type Period='day'|'week';
type PickTasks=(key:AnalyticsMetric,ids:string[],context?:string)=>void;
type Drill={label:string;ids:string[];context:string;stamp:string};
const dayLabel=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long'});
const dateLong=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',weekday:'long',day:'numeric',month:'long'});
const timeLabel=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
const dueLabel=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const clock=(value:string)=>timeLabel.format(new Date(value));
const dayDate=(iso:string)=>new Date(iso+'T12:00:00+03:00');
const statusLabels={active:'В работе',review:'На приёмке',completed:'Завершена'};
const dayCards=['front','closed','remaining','overdue'] as const;
const weekCards=['closedAll','onTime','late','overdue'] as const;
const tones:Partial<Record<AnalyticsMetric,string>>={closed:'good',closedAll:'good',onTime:'good',overdue:'urgent',late:'warm',remaining:'neutral'};
const explanations:Partial<Record<AnalyticsMetric,string>>={
 front:'Задачи с крайним сроком на сегодня или раньше, которые были открыты в течение дня.',
 closed:'Завершено сегодня из числа задач к работе.',
 remaining:'Задачи из фронта дня, по которым ещё предстоит работа или решение.',
 overdue:'Задачи с истёкшим крайним сроком, включая те, что сейчас ждут решения.',
 moved:'Задачи из фронта дня, чей крайний срок перенесли на другую дату или сняли.',
 onTime:'Закрыто в пределах крайнего срока, зафиксированного к моменту завершения.',
 late:'Закрыто после крайнего срока, зафиксированного к моменту завершения.',
 unknown:'Задачи без подтверждённого крайнего срока на момент закрытия.',
 waiting:'Задачи на приёмке или на согласовании. В карточке видно, кто принимает решение.',
 idle:'Просрочки, где ход за исполнителем. Сегодня пока нет сдачи, переноса или другого рабочего действия.',
 stuck:'Задачи с истёкшим сроком или ожиданием решения более двух часов.'
};

function Metric({metric,ids,onPick}:{metric:AnalyticsMetric;ids:string[];onPick:PickTasks}){
 const name=metric==='overdue'?'Просрочено сейчас':analyticsMetricLabels[metric];
 return <button className={'bi-metric '+(tones[metric]??'')} type="button" disabled={!ids.length}
  title={explanations[metric]} onClick={()=>onPick(metric,ids)}>
  <span>{name}</span><strong>{ids.length}</strong><ArrowRight size={16} aria-hidden="true"/>
 </button>;
}

function MetricLink({metric,ids,onPick,label}:{metric:AnalyticsMetric;ids:string[];onPick:PickTasks;label?:string}){
 return <button type="button" className={'bi-metric-link '+(tones[metric]??'')} disabled={!ids.length}
  title={explanations[metric]} onClick={()=>onPick(metric,ids)}><strong>{ids.length}</strong> {label??analyticsMetricLabels[metric]}</button>;
}

function TodayDetails({numbers,onPick}:{numbers:AnalyticsNumbers;onPick:PickTasks}){
 return <div className="bi-day-context" aria-label="Разбивка по срокам">
  <MetricLink metric="earlier" ids={numbers.earlier} onPick={onPick} label="просрочек прошлых дней"/>
  <MetricLink metric="expired" ids={numbers.expired} onPick={onPick} label="истекли сегодня"/>
  <MetricLink metric="due" ids={numbers.due} onPick={onPick} label="срок ещё сегодня"/>
  <MetricLink metric="moved" ids={numbers.moved} onPick={onPick} label="перенесено с дня"/>
  <MetricLink metric="tomorrow" ids={numbers.tomorrow} onPick={onPick} label="срок завтра"/>
  {numbers.closedAll.length>numbers.closed.length&&<MetricLink metric="closedAll" ids={numbers.closedAll} onPick={onPick} label="закрыто всего"/>}
 </div>;
}

function WeekChart({days,onPick}:{days:AnalyticsDay[];onPick:PickTasks}){
 const max=Math.max(1,...days.map(d=>d.numbers.closedAll.length));
 return <section className="panel bi-week-chart">
  <div className="bi-section-heading"><div><h3>Закрытия по дням</h3><p>Просрочки показаны на конец каждого дня. Сегодня — на текущий момент.</p></div></div>
  <div className="bi-legend"><span className="good">В срок</span><span className="warm">С опозданием</span><span className="unknown">Срок неизвестен</span></div>
  <div className="bi-chart-scroller"><div className="bi-chart" style={{gridTemplateColumns:`repeat(${Math.max(1,days.length)}, minmax(54px, 1fr))`}}>
   {days.map(day=>{
    const {numbers:n}=day,caption=dayLabel.format(dayDate(day.date));
    return <div key={day.date} className={'bi-chart-day'+(day.live?' live':'')}>
     <button type="button" className="bi-bar-button" disabled={!n.closedAll.length} aria-label={caption+', закрыто '+n.closedAll.length}
      title={caption+` · В срок ${n.onTime.length} · Поздно ${n.late.length} · Срок неизвестен ${n.unknown.length}`}
      onClick={()=>onPick('closedAll',n.closedAll,caption)}>
      <span className="bi-chart-value">{n.closedAll.length}</span>
      <span className="bi-bar-track" aria-hidden="true">
       <i className="good" style={{height:n.onTime.length/max*100+'%'}}/>
       <i className="warm" style={{height:n.late.length/max*100+'%'}}/>
       <i className="unknown" style={{height:n.unknown.length/max*100+'%'}}/>
      </span>
     </button>
     <strong>{day.live?'Сегодня':caption}</strong>
     <button type="button" className="bi-overdue-point" disabled={!n.overdue.length}
      aria-label={caption+', просрочено '+n.overdue.length} onClick={()=>onPick('overdue',n.overdue,caption)}>
      {n.overdue.length} <span>просрочено</span>
     </button>
    </div>;
   })}
  </div></div>
 </section>;
}

function Groups({rows,period,onGroup,onPick}:{rows:AnalyticsRow[];period:Period;onGroup:(key:string)=>void;onPick:PickTasks}){
 const [expanded,setExpanded]=useState(false);
 const visible=expanded?rows:rows.slice(0,6);
 return <section className="panel bi-groups">
  <div className="bi-section-heading"><div><h3>{period==='day'?'По командам':'По командам за неделю'}</h3>
   <p>{period==='day'?'Группы с просрочками показаны первыми.':'Закрытия за неделю и просрочки на текущий момент.'}</p></div></div>
  <div className="bi-team-list">
   {visible.map(row=>{
    const n=row.numbers,main:AnalyticsMetric=period==='day'?'front':'closedAll';
    const primary=n[main].length?main:n.closedAll.length?'closedAll':n.waiting.length?'waiting':n.unaccepted.length?'unaccepted':'tomorrow';
    const total=period==='week'?n.closedAll.length:n.front.length;
    const done=period==='week'?n.onTime.length:n.closed.length;
    const moved=period==='week'?n.late.length:n.moved.length;
    return <article key={row.key} className="bi-team-row">
     <button type="button" className="bi-team-name" onClick={()=>row.navigable?onGroup(row.key):onPick(primary,n[primary],row.label)}>
      <span><strong>{row.label}</strong>{row.caption&&<small>{row.caption}</small>}</span><ChevronRight size={17} aria-hidden="true"/>
     </button>
     <div className="bi-team-progress">
      <div className="bi-progress-track" aria-hidden="true">
       <i className="good" style={{width:(total?done/total*100:0)+'%'}}/><i className="warm" style={{width:(total?moved/total*100:0)+'%'}}/>
      </div>
      <div className="bi-progress-labels">
       <button type="button" disabled={!n[period==='week'?'closedAll':'closed'].length}
        onClick={()=>onPick(period==='week'?'closedAll':'closed',n[period==='week'?'closedAll':'closed'],row.label)}>
        {n[period==='week'?'closedAll':'closed'].length} закрыто</button>
       {period==='day'&&<button type="button" disabled={!n.remaining.length} onClick={()=>onPick('remaining',n.remaining,row.label)}>{n.remaining.length} осталось</button>}
       {period==='day'&&n.moved.length>0&&<button type="button" onClick={()=>onPick('moved',n.moved,row.label)}>{n.moved.length} перенесено</button>}
       {period==='week'&&<button type="button" disabled={!n.late.length} onClick={()=>onPick('late',n.late,row.label)}>{n.late.length} с опозданием</button>}
      </div>
     </div>
     <div className="bi-team-alerts">
      <button type="button" className={n.overdue.length?'urgent':''} disabled={!n.overdue.length} onClick={()=>onPick('overdue',n.overdue,row.label)}>
       <strong>{n.overdue.length}</strong> просрочено</button>
      {period==='day'&&n.waiting.length>0&&<button type="button" onClick={()=>onPick('waiting',n.waiting,row.label)}><strong>{n.waiting.length}</strong> ждут решения</button>}
      {period==='day'&&n.unaccepted.length>0&&<button type="button" onClick={()=>onPick('unaccepted',n.unaccepted,row.label)}><strong>{n.unaccepted.length}</strong> к приёму</button>}
     </div>
    </article>;
   })}
  </div>
  {rows.length>6&&<button type="button" className="bi-expand text-button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
   {expanded?'Свернуть список':'Показать все · '+rows.length}<ChevronDown size={15}/></button>}
 </section>;
}

function Attention({data,onPick}:{data:AnalyticsOverview;onPick:PickTasks}){
 const age=(since:string|null)=>{
  if(!since)return '';
  const minutes=Math.max(0,Math.floor((Date.parse(data.generatedAt)-Date.parse(since))/60000));
  return minutes<60?minutes+' мин':minutes<1440?Math.floor(minutes/60)+' ч '+minutes%60+' мин':Math.floor(minutes/1440)+' дн';
 };
 return <aside className="panel bi-attention">
  <div className="bi-section-heading"><div><h3>Где нужно вмешаться</h3><p>Ход за конкретным человеком</p></div></div>
  {!data.attention.length&&<p className="bi-empty">На этом срезе срочных сигналов нет.</p>}
  {data.attention.map(task=><button type="button" className="bi-attention-row" key={task.id}
   onClick={()=>onPick(task.kind,[task.id],task.person)}>
   <span className={'bi-signal '+task.kind}>{task.kind==='stuck'?'Ждёт решения':'Требует действия'}</span>
   <strong>#{task.id} · {task.title}</strong>
   <small>{task.person} · {task.label}{task.since?' · '+age(task.since):''}</small>
   <ChevronRight size={16} aria-hidden="true"/>
  </button>)}
  {data.attention.length>0&&<div className="bi-attention-footer">
   {data.numbers.idle.length>0&&<MetricLink metric="idle" ids={data.numbers.idle} onPick={onPick} label="без движения"/>}
   {data.numbers.stuck.length>0&&<MetricLink metric="stuck" ids={data.numbers.stuck} onPick={onPick} label="ждут решения"/>}
  </div>}
 </aside>;
}

function Drilldown({value,close,openTask}:{value:Drill;close:()=>void;openTask:(id:string,tab?:string)=>void}){
 const [page,setPage]=useState(0),[data,setData]=useState<{page:number;rows:AnalyticsTask[]}|null>(null);
 const [error,setError]=useState(''),[retry,setRetry]=useState(0);
 const section=useRef<HTMLElement>(null);
 const heading=useRef<HTMLHeadingElement>(null);
 const pageSize=12,pages=Math.ceil(value.ids.length/pageSize);
 useEffect(()=>{
  if(!section.current||!heading.current)return;
  section.current.scrollIntoView({block:'nearest'});
  heading.current.focus({preventScroll:true});
 },[]);
 useEffect(()=>{
  let alive=true;
  setError('');
  api<AnalyticsTask[]>('/analytics/tasks','POST',{ids:value.ids.slice(page*pageSize,(page+1)*pageSize)},{timeout:10000})
   .then(rows=>{if(alive)setData({page,rows})}).catch(e=>{if(alive)setError(e.message)});
  return()=>{alive=false};
 },[value.ids,page,retry]);
 const rows=data?.page===page?data.rows:null;
 return <section className="panel bi-drill" ref={section} aria-label={value.label}>
  <div className="bi-section-heading"><div><h3 ref={heading} tabIndex={-1}>{value.label} · {value.ids.length}</h3>
   <p>{value.context} · Срез в {clock(value.stamp)} МСК. Карточки показывают текущее состояние.</p></div>
   <button type="button" className="button secondary" onClick={close}>Закрыть список</button>
  </div>
  {error?<p className="bi-empty" role="alert">{error} <button type="button" className="text-button" onClick={()=>setRetry(retry+1)}>Повторить</button></p>:
   !rows?<p className="bi-empty" role="status">Загружаем задачи…</p>:
   <>
    {rows.length<Math.min(pageSize,value.ids.length-page*pageSize)&&<p className="bi-empty">Часть задач вышла из текущей области доступа.</p>}
    {rows.map(task=><article key={task.id} className="bi-drill-task">
     <div>
      <strong>#{task.id} · {task.title}</strong>
      <p>{task.assignee} · {statusLabels[task.status]}{task.deadline?' · Крайний срок '+dueLabel.format(new Date(task.deadline))+' МСК':''}</p>
      {task.next&&<p className="bi-task-step">{task.next}{task.nextPerson?' · '+task.nextPerson:''}</p>}
      {task.lastRemark&&<p className="bi-task-remark">Последнее замечание · {task.lastRemark}</p>}
      {!task.nativeCard&&<details><summary>Детали задачи</summary><p>Постановщик · {task.creator} · {task.branch}</p>{task.description&&<p>{task.description}</p>}</details>}
     </div>
     {task.nativeCard&&<button className="button secondary" type="button" onClick={()=>openTask(task.id,task.status==='review'?'result':'info')}>Открыть <ArrowRight size={15}/></button>}
    </article>)}
   </>}
  {pages>1&&<div className="bi-pagination">
   <button type="button" className="icon-button" aria-label="Предыдущая страница" onClick={()=>setPage(page-1)} disabled={page===0}><ChevronLeft size={19}/></button>
   <span>Страница {page+1} из {pages}</span>
   <button type="button" className="icon-button" aria-label="Следующая страница" onClick={()=>setPage(page+1)} disabled={page+1>=pages}><ChevronRight size={19}/></button>
  </div>}
 </section>;
}

export function TeamAnalytics({openTask}:{openTask:(id:string,tab?:string)=>void}){
 const [period,setPeriod]=useState<Period>('day'),[selection,setSelection]=useState<string[]>([]);
 const [loaded,setLoaded]=useState<{key:string;data:AnalyticsOverview}|null>(null);
 const [error,setError]=useState(''),[refreshing,setRefreshing]=useState(true),[request,setRequest]=useState(0);
 const [drill,setDrill]=useState<Drill|null>(null);
 const opener=useRef<HTMLElement|null>(null);
 const query=new URLSearchParams({period});selection.forEach(part=>query.append('group',part));
 const key=query.toString();
 useEffect(()=>{
  const timer=setInterval(()=>{if(document.visibilityState==='visible')setRequest(n=>n+1)},60000);
  return()=>clearInterval(timer);
 },[]);
 useEffect(()=>{
  let alive=true;
  setRefreshing(true);setError('');
  api<AnalyticsOverview>('/analytics/overview?'+key,'GET',undefined,{timeout:12000})
   .then(data=>{if(alive)setLoaded({key,data})}).catch(e=>{if(alive)setError(e.message)})
   .finally(()=>{if(alive)setRefreshing(false)});
  return()=>{alive=false};
 },[key,request]);
 const data=loaded?.key===key?loaded.data:null;
 const scope=data?.scope??loaded?.data.scope??'Обзор работы';
 function changePeriod(value:Period){if(period!==value){setDrill(null);setPeriod(value);}}
 function changeGroup(value:string[]){setDrill(null);setSelection(value);}
 const pick:PickTasks=(metric,ids,context)=>{
  if(!data||!ids.length)return;
  opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
  setDrill({label:analyticsMetricLabels[metric],ids,context:context??data.path.at(-1)?.label??scope,stamp:data.generatedAt});
 };
 const metrics=period==='day'?dayCards:weekCards;
 const count=(metric:AnalyticsMetric)=>data?.numbers[metric]??[];
 return <div className="bi-workspace">
  <header className="panel bi-header">
   <div className="bi-header-left"><ChartNoAxesCombined size={23}/><div><h1>{scope}</h1>
    {data&&<p>{period==='week'&&data.days.length?`${dayLabel.format(dayDate(data.days[0].date))} — ${dayLabel.format(dayDate(data.date))}`:
     dateLong.format(dayDate(data.date))} · МСК</p>}</div></div>
   <div className="bi-header-actions">
    <div className="bi-segmented" role="group" aria-label="Период аналитики">
     <button type="button" aria-pressed={period==='day'} onClick={()=>changePeriod('day')}>Сегодня</button>
     <button type="button" aria-pressed={period==='week'} onClick={()=>changePeriod('week')}>Неделя</button>
    </div>
    <button type="button" className="icon-button" onClick={()=>setRequest(n=>n+1)} disabled={refreshing} aria-label="Обновить аналитику">
     <RefreshCw size={17}/>
    </button>
   </div>
  </header>
  {data&&<div className="bi-context-line">
   {data.path.length>0&&<nav aria-label="Текущая область">
    <button type="button" disabled={!data.path.length} onClick={()=>changeGroup([])}>{scope}</button>
    {data.path.map((group,i)=><span key={group.key}><ChevronRight size={13}/><button type="button"
     disabled={i===data.path.length-1} onClick={()=>changeGroup(selection.slice(0,i+1))}>{group.label}</button></span>)}
   </nav>}
   <span className={data.bitrixDelay||error?'bi-stale':''}>{data.bitrixDelay?'Есть задержка Битрикса · ':''}Данные на {clock(data.generatedAt)} МСК</span>
  </div>}
  {error&&<p className="alert error" role="alert">{error} {selection.length>0&&<button type="button" className="text-button" onClick={()=>changeGroup([])}>Вернуться к сводке</button>}</p>}
  {!data&&!error&&<p className="panel bi-empty" role="status">Загружаем аналитику…</p>}
  {data&&<>
   <div className="bi-metrics">{metrics.map(metric=><Metric key={metric} metric={metric} ids={count(metric)} onPick={pick}/>)}</div>
   {period==='day'?<TodayDetails numbers={data.numbers} onPick={pick}/>:
    count('unknown').length>0&&<div className="bi-day-context"><MetricLink metric="unknown" ids={count('unknown')} onPick={pick}/></div>}
   {drill&&<Drilldown key={drill.label+'|'+drill.context+'|'+drill.ids.join(',')} value={drill}
    close={()=>{setDrill(null);opener.current?.focus({preventScroll:true})}} openTask={openTask}/>}
   {period==='week'&&<WeekChart days={data.days} onPick={pick}/>}
   <div className={'bi-board '+(period==='day'&&data.rows.length?'with-attention':'')}>
    {data.rows.length>0&&<Groups key={key} rows={data.rows} period={period} onGroup={part=>changeGroup([...selection,part])} onPick={pick}/>}
    {period==='day'&&<Attention data={data} onPick={pick}/>}
   </div>
   {period==='week'&&data.partialHistory&&<p className="bi-coverage">История за неделю покрыта частично{data.historyFrom?' · данные учтены с '+dueLabel.format(new Date(data.historyFrom))+' МСК':''}.</p>}
  </>}
 </div>;
}
