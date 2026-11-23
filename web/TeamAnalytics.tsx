import {ClientPortfolio} from './Crm.js';
import {HelpHint} from './Management.js';
import {useEffect,useState} from 'react';
import {ChartNoAxesCombined,ChevronRight,RefreshCw} from 'lucide-react';
import type {AnalyticsDay,AnalyticsOverview,AnalyticsRow,CompletedWork,RemainingWork} from '../shared/team-analytics.js';
import {api} from './api.js';
import './team-analytics.css';

type Period='day'|'week';
const dateLong=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',weekday:'long',day:'numeric',month:'long'});
const dateShort=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short'});
const clock=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
const dayDate=(iso:string)=>new Date(iso+'T12:00:00+03:00');

function Summary({title,total,children,caption,bar,positive=false}:{
 title:string;total:number;children:React.ReactNode;caption?:string;bar?:React.ReactNode;positive?:boolean;
}){
 return <section className={'panel bi-summary'+(positive?' bi-positive':'')}>
  <div className="bi-summary-title"><h2>{title}</h2><strong>{total}</strong>{caption&&<p>{caption}</p>}</div>
  {bar}
  <dl>{children}</dl>
 </section>;
}

const deadlineParts=['overdue','today','nextWorkday'] as const;
type DeadlinePart=typeof deadlineParts[number];
const completedParts=['overdue','today','nextWorkday','later','withoutDeadline'] as const;
type CompletedTone=`done-${typeof completedParts[number]}`;

function DeadlineBar({work}:{work:RemainingWork}){
 return <div className="bi-deadline-bar" aria-hidden="true">
  {deadlineParts.filter(part=>work[part]>0).map(part=><span key={part} data-tone={part} style={{flexGrow:work[part]}}/>)}
 </div>;
}
function CompletedBar({work}:{work:CompletedWork}){
 return <div className="bi-deadline-bar bi-completed-bar" aria-hidden="true">
  {completedParts.filter(part=>work[part]>0).map(part=><span key={part} data-tone={'done-'+part} style={{flexGrow:work[part]}}/>)}
 </div>;
}
function Measure({label,value,urgent=false,tone}:{label:string;value:number;urgent?:boolean;tone?:DeadlinePart|CompletedTone}){
 return <div className={urgent&&value?'bi-urgent':undefined}><dt>{tone&&<i className="bi-deadline-dot" data-tone={tone} aria-hidden="true"/>}{label}</dt><dd>{value}</dd></div>;
}
function Remaining({work,nextLabel,horizon}:{work:RemainingWork;nextLabel:string;horizon:string}){
 return <Summary title="Осталось к выполнению" total={work.total} caption={horizon} bar={<DeadlineBar work={work}/>}>
  <Measure label="Просрочено" value={work.overdue} tone="overdue" urgent/>
  <Measure label="Крайний срок сегодня" value={work.today} tone="today"/>
  <Measure label={nextLabel} value={work.nextWorkday} tone="nextWorkday"/>
 </Summary>;
}
function Completed({work,period,nextLabel}:{work:CompletedWork;period:Period;nextLabel:string}){
 const week=period==='week';
 return <Summary title={week?'Выполнено за неделю':'Выполнено сегодня'} total={work.total} bar={<CompletedBar work={work}/>} positive>
  <Measure label="После крайнего срока" value={work.overdue} tone="done-overdue"/>
  <Measure label={week?'Со сроком в день выполнения':'Крайний срок сегодня'} value={work.today} tone="done-today"/>
  <Measure label={week?'Со сроком до следующего рабочего дня':nextLabel} value={work.nextWorkday} tone="done-nextWorkday"/>
  {work.later>0&&<Measure label="С более поздним сроком" value={work.later} tone="done-later"/>}
  {work.withoutDeadline>0&&<Measure label="Без крайнего срока" value={work.withoutDeadline} tone="done-withoutDeadline"/>}
 </Summary>;
}

function WeekChart({days,date}:{days:AnalyticsDay[];date:string}){
 const top=Math.max(1,...days.map(day=>day.completed));
 return <section className="panel bi-section">
  <h2>Выполнено по дням</h2>
  <ul className="bi-chart">{days.map(day=><li key={day.date} aria-label={dateLong.format(dayDate(day.date))+' · выполнено '+day.completed}>
   <strong>{day.completed}</strong>
   <div className="bi-bar-track" aria-hidden="true"><span style={{height:day.completed/top*100+'%'}}/></div>
   <span>{day.date===date?'Сегодня':dateShort.format(dayDate(day.date))}</span>
  </li>)}</ul>
 </section>;
}

function Teams({rows,period,nextLabel,onGroup}:{rows:AnalyticsRow[];period:Period;nextLabel:string;onGroup:(key:string)=>void}){
 const [expanded,setExpanded]=useState(false);
 const shown=expanded?rows:rows.slice(0,8);
 const columns=['Осталось к выполнению','Просрочено','Срок сегодня',nextLabel,
  period==='week'?'Выполнено за неделю':'Выполнено сегодня','На согласовании','На приёмке','Позже или без срока'];
 const tones=[null,'overdue','today','nextWorkday','completed'];
 return <section className="panel bi-section">
  <h2>По подразделениям и сотрудникам</h2>
  <div className="bi-table-wrap"><table className="bi-table">
   <thead><tr><th scope="col">Сотрудник или подразделение</th>{columns.map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead>
   <tbody>{shown.map(row=>{
    const {remaining,completed,approvals,review,outside}=row.numbers;
    const values=[remaining.total,remaining.overdue,remaining.today,remaining.nextWorkday,completed.total,approvals,review,outside??0];
    return <tr key={row.key}>
     <th scope="row"><button type="button" className="bi-team-name" onClick={()=>onGroup(row.key)}>
      <span>{row.label}{row.caption&&<small>{row.caption}</small>}</span><ChevronRight size={16} aria-hidden="true"/>
     </button></th>
     {values.map((value,index)=><td key={columns[index]} data-metric={value?tones[index]??undefined:undefined}>
      {value}{index===0&&<DeadlineBar work={remaining}/>}{index===4&&<CompletedBar work={completed}/>}
     </td>)}
    </tr>;
   })}</tbody>
  </table></div>
  {rows.length>8&&<button type="button" className="text-button bi-expand" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
   {expanded?'Свернуть':'Показать все · '+rows.length}
  </button>}
 </section>;
}

export function TeamAnalytics(){
 const [period,setPeriod]=useState<Period>('day'),[selection,setSelection]=useState<string[]>([]);
 const [loaded,setLoaded]=useState<{key:string;data:AnalyticsOverview}|null>(null);
 const [error,setError]=useState(''),[refreshing,setRefreshing]=useState(true),[request,setRequest]=useState(0);
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
 const scope=data?.scope??loaded?.data.scope??'Аналитика';
 const weekend=data?+dayDate(data.nextWorkday)-(+dayDate(data.date))>86400000:false;
 const nextLabel=weekend?'Крайний срок до конца понедельника':'Крайний срок завтра';
 const dateSpan=data&&period==='week'&&data.days.length>1?
  dateShort.format(dayDate(data.days[0].date))+' — '+dateShort.format(dayDate(data.date)):data?dateLong.format(dayDate(data.date)):'';
 return <div className="bi-workspace">
  <header className="panel bi-header">
   <div className="bi-header-left"><ChartNoAxesCombined size={23} aria-hidden="true"/><div>
    <h1>{data?.path.at(-1)?.label??scope}</h1>{dateSpan&&<p>{dateSpan} · МСК</p>}
   </div></div>
   <div className="bi-header-actions">
    <div className="bi-segmented" role="group" aria-label="Период аналитики">
     <button type="button" aria-pressed={period==='day'} onClick={()=>setPeriod('day')}>Сегодня</button>
     <button type="button" aria-pressed={period==='week'} onClick={()=>setPeriod('week')}>Неделя</button>
    </div>
    <button type="button" className="icon-button" onClick={()=>setRequest(n=>n+1)} disabled={refreshing} aria-label="Обновить аналитику">
     <RefreshCw size={17}/>
    </button>
   </div>
  </header>
  {data&&<div className="bi-context-line">
   {data.path.length>0&&<nav aria-label="Текущая область">
    <button type="button" onClick={()=>setSelection([])}>{scope}</button>
    {data.path.map((group,i)=><span key={group.key}><ChevronRight size={13} aria-hidden="true"/>
     {i<data.path.length-1?<button type="button" onClick={()=>setSelection(selection.slice(0,i+1))}>{group.label}</button>:group.label}
    </span>)}
   </nav>}
   <span>Данные на {clock.format(new Date(data.generatedAt))} МСК</span>
  </div>}
  {error&&<p className="alert error" role="alert">{error}{selection.length>0&&<button type="button" className="text-button" onClick={()=>setSelection([])}>К общей сводке</button>}</p>}
  {!data&&!error&&<p className="panel bi-section" role="status">Загружаем аналитику…</p>}
  {data&&<>
   <div className="bi-summaries">
    <Remaining work={data.numbers.remaining} nextLabel={nextLabel} horizon={'По '+dateShort.format(dayDate(data.nextWorkday))+' включительно'}/>
    <Completed work={data.numbers.completed} period={period} nextLabel={nextLabel}/>
   </div>
   <dl className="panel bi-waiting" aria-label="Задачи, по которым ждут решения">
    <Measure label="На согласовании" value={data.numbers.approvals}/><Measure label="На приёмке" value={data.numbers.review}/>
    <Measure label="Позже или без срока" value={data.numbers.outside??0}/>
    <HelpHint text="Остаток к выполнению охватывает сроки до конца следующего рабочего дня. Более дальние задачи, задачи без срока, согласования и приёмка показаны отдельно."/>
   </dl>
   {period==='week'&&<WeekChart days={data.days} date={data.date}/>}
   {data.rows.length>0&&<Teams key={key} rows={data.rows} period={period} nextLabel={nextLabel} onGroup={part=>setSelection([...selection,part])}/>}
   {data.rows.length===0&&data.path.length===0&&<p className="panel bi-section muted">В вашей области сейчас нет задач для этой сводки.</p>}
   {data.path.length===0&&<ClientPortfolio/>}
   {period==='week'&&data.partialHistory&&<small className="bi-coverage">История за неделю покрыта частично{data.historyFrom?' · учёт с '+dateShort.format(new Date(data.historyFrom)):''}.</small>}
  </>}
 </div>;
}
