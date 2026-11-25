import {ClientPortfolio} from './Crm.js';
import {HelpHint} from './Management.js';
import {useEffect,useRef,useState,type PointerEvent} from 'react';
import {ChartNoAxesCombined,ChevronRight,RefreshCw} from 'lucide-react';
import {analyticsColumns,analyticsDeadlineParts,type AnalyticsColumn,type AnalyticsDay,type AnalyticsLayout,type AnalyticsMetric,
 type AnalyticsOverview,type AnalyticsRow,type AnalyticsWait,type CompletedWork,type RemainingWork} from '../shared/team-analytics.js';
import {useSectionParam} from './section-history.js';
import {api} from './api.js';
import {TeamScopeSwitch} from './TeamScopeSwitch.js';
import type {WorkspaceLabelKey} from '../shared/workspace-labels.js';
import './team-analytics.css';

type Period='day'|'week';
const dateLong=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',weekday:'long',day:'numeric',month:'long'});
const dateShort=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short'});
const clock=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
const dayDate=(iso:string)=>new Date(iso+'T12:00:00+03:00');
type OpenMetric=(metric:AnalyticsMetric,group?:string,wait?:AnalyticsWait)=>void;
const deadlineParts=analyticsDeadlineParts;
type DeadlinePart=typeof deadlineParts[number];

function Summary({title,total,children,bar,positive=false,open}:{
 title:React.ReactNode;total:number;children:React.ReactNode;bar?:React.ReactNode;positive?:boolean;open:()=>void;
}){
 return <section className={'panel bi-summary'+(positive?' bi-positive':'')}>
  <div className="bi-summary-title"><h2>{title}</h2><strong>{total>0?<button type="button" className="bi-number-link" onClick={open}>{total}</button>:total}</strong></div>
  {bar}
  <dl>{children}</dl>
 </section>;
}

function DeadlineBar({work}:{work:RemainingWork}){
 return <div className="bi-deadline-bar" aria-hidden="true">
  {deadlineParts.filter(part=>work[part]>0).map(part=><span key={part} data-tone={part} style={{flexGrow:work[part]}}/>)}
 </div>;
}
function CompletedBar({work}:{work:CompletedWork}){
 return <DeadlineBar work={work}/>;
}
function Measure({label,value,urgent=false,tone,open}:{label:string;value:number;urgent?:boolean;tone?:DeadlinePart;open?:()=>void}){
 return <div className={urgent&&value?'bi-urgent':undefined}>
  <dt>{tone&&<i className="bi-deadline-dot" data-tone={tone} aria-hidden="true"/>}
   {open&&value>0?<button type="button" className="bi-measure-link" onClick={open}>{label}</button>:label}</dt><dd>{value}</dd>
 </div>;
}
function Remaining({title,work,nextLabel,open}:{title:React.ReactNode;work:RemainingWork;nextLabel:string;open:OpenMetric}){
 const labels=['Просрочено','Крайний срок сегодня',nextLabel,'Позднее','Без крайнего срока'];
 return <Summary title={title} total={work.total} open={()=>open('remaining')} bar={<DeadlineBar work={work}/>}>
  {deadlineParts.map((part,i)=><Measure key={part} label={labels[i]} value={work[part]} tone={part} urgent={part==='overdue'} open={()=>open(`remaining:${part}`)}/>)}
 </Summary>;
}
function Completed({title,work,period,nextLabel,open}:{title:React.ReactNode;work:CompletedWork;period:Period;nextLabel:string;open:OpenMetric}){
 const week=period==='week';
 const labels=['Выполнено после крайнего срока',week?'Со сроком в день выполнения':'Крайний срок сегодня',
  week?'Со сроком до следующего рабочего дня':nextLabel,'Позднее','Без крайнего срока'];
 return <Summary title={title} total={work.total} open={()=>open('completed')} bar={<CompletedBar work={work}/>} positive>
  {deadlineParts.map((part,i)=><Measure key={part} label={labels[i]} value={work[part]} tone={part} open={()=>open(`completed:${part}`)}/>)}
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

const defaultWidths:Record<AnalyticsColumn,number>={person:225,remaining:145,overdue:100,today:112,next:135,later:86,
 withoutDeadline:106,completed:140,approvals:132,review:121};
function Teams({rows,period,nextLabel,onGroup,open,widths,resize,title}:{
 rows:AnalyticsRow[];period:Period;nextLabel:string;onGroup:(key:string)=>void;open:OpenMetric;
 widths:AnalyticsLayout;resize:(column:AnalyticsColumn|null,width:number|null,commit?:boolean)=>void;title:React.ReactNode;
}){
 const [expanded,setExpanded]=useState(false);
 const drag=useRef<{column:AnalyticsColumn;x:number;initial:number;width:number}|null>(null);
 const shown=expanded?rows:rows.slice(0,8);
 const labels=['Сотрудник или подразделение','Осталось к выполнению','Просрочено','Срок сегодня',nextLabel,
  'Позднее','Без срока',period==='week'?'Выполнено за неделю':'Выполнено сегодня','На согласовании','Ждёт приёмки'];
 const columns=analyticsColumns.map((id,i)=>({id,label:labels[i],width:widths[id]??defaultWidths[id]}));
 const tones=[null,'overdue','today','nextWorkday',null,null,'completed'];
 const metrics:AnalyticsMetric[]=['remaining',...deadlineParts.map(part=>`remaining:${part}` as const),'completed','approvals','review'];
 const clamp=(column:AnalyticsColumn,value:number)=>Math.max(column==='person'?115:64,Math.min(600,Math.round(value)));
 function startResize(event:PointerEvent<HTMLSpanElement>,column:AnalyticsColumn,width:number){
  if(event.button!==0)return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current={column,x:event.clientX,initial:width,width};
 }
 function endResize(){
  if(!drag.current)return;
  const {column,width}=drag.current;drag.current=null;
  resize(column,width,true);
 }
 return <section className="panel bi-section">
  <div className="bi-section-heading"><h2>{title}</h2>
   {Object.keys(widths).length>0&&<button type="button" className="text-button" onClick={()=>resize(null,null,true)}>Сбросить ширину</button>}
  </div>
  <div className="bi-table-wrap"><table className="bi-table" style={{width:columns.reduce((sum,column)=>sum+column.width,0)}}>
   <colgroup>{columns.map(column=><col key={column.id} style={{width:column.width}}/>)}</colgroup>
   <thead><tr>{columns.map(column=><th scope="col" key={column.id}>
    {column.label}
    <span className="bi-column-resizer" role="separator" tabIndex={0} aria-orientation="vertical"
     aria-label={'Ширина столбца '+column.label} aria-valuenow={column.width} aria-valuemin={column.id==='person'?115:64} aria-valuemax={600}
     onPointerDown={e=>startResize(e,column.id,column.width)}
     onPointerMove={e=>{if(drag.current?.column!==column.id)return;
      drag.current.width=clamp(column.id,drag.current.initial+e.clientX-drag.current.x);resize(column.id,drag.current.width);
     }} onPointerUp={endResize} onPointerCancel={endResize}
     onKeyDown={e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();
      resize(column.id,clamp(column.id,column.width+(e.key==='ArrowRight'?12:-12)),true);
     }}/>
   </th>)}</tr></thead>
   <tbody>{shown.map(row=>{
    const {remaining,completed,approvals,review}=row.numbers;
    const values=[remaining.total,...deadlineParts.map(part=>remaining[part]),completed.total,approvals,review];
    return <tr key={row.key}>
     <th scope="row"><button type="button" className="bi-team-name" onClick={()=>onGroup(row.key)}>
      <span>{row.label}{row.caption&&<small>{row.caption}</small>}</span><ChevronRight size={16} aria-hidden="true"/>
     </button></th>
     {values.map((value,index)=><td key={metrics[index]} data-metric={value?tones[index]??undefined:undefined}>
      {value>0?<button className="bi-number-link" type="button" aria-label={row.label+' · '+labels[index+1]+' · '+value}
       onClick={()=>open(metrics[index],row.key)}>{value}</button>:0}
      {index===0&&<DeadlineBar work={remaining}/>}{index===6&&<CompletedBar work={completed}/>}
     </td>)}
    </tr>;
   })}</tbody>
  </table></div>
  {rows.length>8&&<button type="button" className="text-button bi-expand" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
   {expanded?'Свернуть':'Показать все · '+rows.length}
  </button>}
 </section>;
}

const waitingLabels={approval:'Согласование',clarification:'Ответ на уточнение',review:'Приёмка результата',assignment:'Ознакомление с задачей'};
function age(since:string|null,now:string){
 if(!since)return 'Время ожидания неизвестно';
 const minutes=Math.max(0,Math.floor((Date.parse(now)-Date.parse(since))/60000));
 const hours=Math.floor(minutes/60);
 return hours>=24?`Ждёт ${Math.floor(hours/24)} д ${hours%24} ч`:hours?`Ждёт ${hours} ч ${minutes%60} мин`:
  minutes?`Ждёт ${minutes} мин`:'Меньше минуты';
}

export function TeamAnalytics({splitTeams=false,onTasks,renderTitle,editButton}:{
 splitTeams?:boolean;onTasks:(params:Record<string,string>)=>void;
 renderTitle:(key:WorkspaceLabelKey,fallback:string)=>React.ReactNode;editButton?:React.ReactNode;
}){
 const [periodParam,changePeriod]=useSectionParam('period'),[group,changeGroup]=useSectionParam('analytics-group');
 const period:Period=periodParam==='week'?'week':'day';
 const selection=group.split('|').filter(Boolean);
 const setPeriod=(value:Period)=>changePeriod(value==='day'?'':value);
 const setSelection=(path:string[])=>changeGroup(path.join('|'));
 const [loaded,setLoaded]=useState<{key:string;data:AnalyticsOverview}|null>(null);
 const [error,setError]=useState(''),[refreshing,setRefreshing]=useState(true),[request,setRequest]=useState(0);
 const [widths,setWidths]=useState<AnalyticsLayout>({}),[layoutError,setLayoutError]=useState('');
 const [showAllWaiting,setShowAllWaiting]=useState(false);
 const query=new URLSearchParams({period});selection.forEach(part=>query.append('group',part));
 const key=query.toString();
 const open:OpenMetric=(metric,part,wait)=>onTasks({
  'analytics-metric':metric,'analytics-period':period,'analytics-group':(part?[...selection,part]:selection).join('|'),
  ...(wait?{'analytics-person':wait.userId,'analytics-stage':wait.stage}:{})
 });
 useEffect(()=>{
  let active=true;
  void api<AnalyticsLayout>('/analytics/layout').then(layout=>{if(active)setWidths(layout);}).catch(()=>{});
  return()=>{active=false;};
 },[]);
 function resize(column:AnalyticsColumn|null,width:number|null,commit=false){
  setWidths(old=>column&&width?{...old,[column]:width}:{});
  if(commit){
   setLayoutError('');
   void api('/analytics/layout','PUT',{column,width}).catch(()=>setLayoutError('Не удалось сохранить ширину столбцов. Повторите изменение.'));
  }
 }
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
    <h1>{data?.path.at(-1)?.label??renderTitle('analytics','Аналитика')}</h1>{dateSpan&&<p>{dateSpan} · МСК</p>}
   </div></div>
   <div className="bi-header-actions">
    <div className="bi-segmented" role="group" aria-label="Период аналитики">
     <button type="button" aria-pressed={period==='day'} onClick={()=>setPeriod('day')}>Сегодня</button>
     <button type="button" aria-pressed={period==='week'} onClick={()=>setPeriod('week')}>Неделя</button>
    </div>
    <button type="button" className="icon-button" onClick={()=>setRequest(n=>n+1)} disabled={refreshing} aria-label="Обновить аналитику">
     <RefreshCw size={17}/>
    </button>
    {editButton}
   </div>
  </header>
  {splitTeams&&<TeamScopeSwitch
   value={selection[0]==='sales:my-team'?'team':selection[0]==='sales:branches'?'sales':'all'}
   base={{id:'all',label:'Общая сводка'}}
   onChange={team=>setSelection(team==='all'?[]:[team==='team'?'sales:my-team':'sales:branches'])}/>}
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
    <Remaining title={renderTitle('analytics.remaining','Осталось к выполнению')} work={data.numbers.remaining} nextLabel={nextLabel} open={open}/>
    <Completed title={period==='week'?renderTitle('analytics.completedWeek','Выполнено за неделю'):renderTitle('analytics.completedDay','Выполнено сегодня')}
     work={data.numbers.completed} period={period} nextLabel={nextLabel} open={open}/>
   </div>
   <dl className="panel bi-waiting" aria-label="Задачи, по которым ждут решения">
    <Measure label="На согласовании" value={data.numbers.approvals} open={()=>open('approvals')}/>
    <Measure label="Ждёт приёмки" value={data.numbers.review} open={()=>open('review')}/>
    <HelpHint text="В «Осталось к выполнению» входят будущие задачи и задачи без срока. Задачи на согласовании и приёмке показаны отдельно."/>
   </dl>
   {period==='day'&&<section className="panel bi-section">
    <div className="bi-section-heading"><h2>{renderTitle('analytics.morning','Срез на 09:00 МСК')}</h2>
     <HelpHint text="Срез восстановлен по истории незавершённых задач. «Проработано» означает, что по утренней задаче есть действие, например комментарий, перенос или сдача результата."/>
    </div>
    {data.morning?<dl className="bi-morning">
     <Measure label="Было в 09:00" value={data.morning.total} open={()=>open('morning')}/>
     <Measure label="Проработано с 09:00" value={data.morning.worked} open={()=>open('worked')}/>
     <Measure label="Из утренних без действий" value={data.morning.untouched} open={()=>open('untouched')}/>
    </dl>:<p className="muted">Срез на 09:00 пока недоступен.</p>}
   </section>}
   <section className="panel bi-section">
    <h2>{renderTitle('analytics.waiting','Где ждут следующего шага')}</h2>
    {data.waiting.length===0?<p className="muted">В этой области сейчас нет задач в ожидании.</p>:
     <ul className="bi-wait-list">{(showAllWaiting?data.waiting:data.waiting.slice(0,6)).map(wait=><li key={wait.stage+':'+wait.userId}>
      <button type="button" onClick={()=>open('waiting',undefined,wait)}><strong>{wait.name}</strong><span>{waitingLabels[wait.stage]} · {wait.count}</span>
       <small>{age(wait.oldest,data.generatedAt)}</small><ChevronRight size={15} aria-hidden="true"/></button>
     </li>)}</ul>}
    {data.waiting.length>6&&<button type="button" className="text-button bi-expand" onClick={()=>setShowAllWaiting(!showAllWaiting)}>
     {showAllWaiting?'Свернуть':'Показать все · '+data.waiting.length}</button>}
   </section>
   {period==='week'&&<WeekChart days={data.days} date={data.date}/>}
   {layoutError&&<p role="alert" className="alert error">{layoutError}</p>}
   {data.rows.length>0&&<Teams key={key} rows={data.rows} period={period} nextLabel={nextLabel} onGroup={part=>setSelection([...selection,part])}
    widths={widths} resize={resize} title={renderTitle('analytics.teams','По подразделениям и сотрудникам')} open={open}/>}
   {data.rows.length===0&&data.path.length===0&&<p className="panel bi-section muted">В вашей области сейчас нет задач для этой сводки.</p>}
   {data.path.length===0&&<ClientPortfolio/>}
   {period==='week'&&data.partialHistory&&<small className="bi-coverage">История за неделю покрыта частично{data.historyFrom?' · учёт с '+dateShort.format(new Date(data.historyFrom)):''}.</small>}
  </>}
 </div>;
}
