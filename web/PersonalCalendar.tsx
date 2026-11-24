import {useEffect,useState} from 'react';
import {CalendarDays,ChevronLeft,ChevronRight} from 'lucide-react';
import {moscowClock,type CalendarDeadline,type CalendarTask,type PersonalCalendarMonth,type StaffWorkDay,type TaskPersonalPlan} from '../shared/personal-calendar.js';
import {businessDay} from '../shared/queues.js';
import type {Task} from '../shared/types.js';
import {api} from './api.js';
import './personal-calendar.css';

const dayTitle=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',weekday:'long',day:'numeric',month:'long'});
const monthTitle=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',month:'long',year:'numeric'});
const planTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});
const workTime=(minutes:number)=>Math.floor(minutes/60)+' ч '+String(minutes%60).padStart(2,'0')+' мин';
const dateOf=(day:string)=>new Date(day+'T12:00:00+03:00');
const weekdays=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
type Act=(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>;

export function PersonalTaskPlan({task,plan,busy,error,act}:{task:Task;plan:TaskPersonalPlan;busy:boolean;error:string;act:Act}){
 const [editing,setEditing]=useState(plan.needsAcceptance);
 const [submitted,setSubmitted]=useState(false);
 const [value,setValue]=useState(plan.plannedAt?moscowClock(plan.plannedAt):'');
 const [nextStep,setNextStep]=useState(plan.nextStep??'');
 const when=value?Date.parse(value+':00+03:00'):NaN;
 const laterThanDeadline=task.deadline&&when>Date.parse(task.deadline);
 return <section className={'task-card-section personal-task-plan'+(plan.needsAcceptance?' awaiting-acceptance':'')} aria-label="Мой план задачи">
  <h3><CalendarDays size={16}/> {plan.needsAcceptance?'Принять задачу и запланировать':'Мой план'}</h3>
  {plan.plannedAt&&<p><strong>{planTime.format(new Date(plan.plannedAt))} МСК</strong>{plan.acceptedAt?' · задача принята':''}</p>}
  {plan.nextStep&&<p>Следующий шаг · <strong>{plan.nextStep}</strong></p>}
  {plan.needsAcceptance&&<p>Примите задачу и назначьте время для следующего шага.</p>}
  {!plan.plannedAt&&!plan.needsAcceptance&&task.status==='active'&&<p>Добавьте задачу в личный календарь.</p>}
  {task.status==='active'&&(editing?<form onSubmit={async e=>{
   e.preventDefault();
   if(!Number.isFinite(when))return;
   setSubmitted(true);
   if(await act('/tasks/'+encodeURIComponent(task.id)+'/personal-plan',
    {epoch:plan.epoch,revision:plan.revision,plannedAt:new Date(when).toISOString(),accept:plan.needsAcceptance,nextStep},'PUT',
    plan.needsAcceptance?'Задача принята и добавлена в календарь.':'Время в календаре обновлено.'))setEditing(false);
  }}>
   <label>Следующий шаг<input value={nextStep} maxLength={500} onChange={e=>setNextStep(e.target.value)} placeholder="Например, отправить клиенту расчёт"/></label>
   <label>{plan.needsAcceptance?'Плановая дата и время · МСК':'Дата и время шага · МСК'}
    <input type="datetime-local" required value={value} onChange={e=>setValue(e.target.value)}/>
   </label>
   <p className="muted">Это ваш личный план. Крайний срок задачи сохраняется.</p>
   {laterThanDeadline&&<p className="calendar-warning">Шаг запланирован позже крайнего срока задачи.</p>}
   {submitted&&error&&<p className="calendar-warning" role="alert">{error}</p>}
   <div className="calendar-actions">
    <button type="submit" className="button primary" disabled={busy||!value}>{plan.needsAcceptance?'Принять и запланировать':'Сохранить план'}</button>
    <button type="button" className="button secondary" disabled={busy} onClick={()=>setEditing(false)}>Отмена</button>
   </div>
  </form>:<button type="button" className={'button '+(plan.needsAcceptance?'primary':'secondary')} disabled={busy}
   onClick={()=>{setSubmitted(false);setNextStep(plan.nextStep??'');setValue(plan.plannedAt?moscowClock(plan.plannedAt):'');setEditing(true)}}>{plan.needsAcceptance?'Принять задачу':plan.plannedAt?'Изменить план':'Запланировать'}</button>)}
 </section>;
}

function WorkLog({day,work,saved}:{day:string;work?:StaffWorkDay;saved:(entry:StaffWorkDay)=>void}){
 const initial=work?.minutes;
 const [hours,setHours]=useState(initial==null?'':Math.floor(initial/60)+':'+String(initial%60).padStart(2,'0'));
 const [note,setNote]=useState(work?.note??''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false);
 return <form className="calendar-work-log" onSubmit={async e=>{
  e.preventDefault();setBusy(true);setFailed(false);setMessage('');
  const match=/^(\d{1,2}):([0-5]\d)$/.exec(hours.trim());
  const total=match?Number(match[1])*60+Number(match[2]):null;
  try{
   if(hours.trim()&&(!match||total!>1440))throw new Error('Укажите время в формате 7:30, максимум 24:00.');
   const result=await api<StaffWorkDay>('/personal-calendar/work/'+day,'PUT',{minutes:total,note,revision:work?.revision??0});
   saved(result);setMessage('Запись сохранена.');
  }catch(error){setFailed(true);setMessage((error as Error).message);}
  finally{setBusy(false);}
 }}>
  <h3>Отработанное время</h3>
  <label>Часы и минуты<input value={hours} onChange={e=>setHours(e.target.value)} placeholder="7:30" maxLength={5}/></label>
  <label>Что сделано<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={2000} rows={2}/></label>
  <button type="submit" className="button secondary" disabled={busy}>Сохранить часы</button>
  {message&&<p className={failed?'calendar-warning':'muted'} role={failed?'alert':'status'}>{message}</p>}
 </form>;
}

export function PersonalCalendar({open,refreshKey}:{open?:(id:string)=>void;refreshKey?:string}){
 const [day,setDay]=useState(()=>businessDay(new Date()));
 const month=day.slice(0,7);
 const [loaded,setLoaded]=useState<{month:string;data:PersonalCalendarMonth}|null>(null);
 const [failure,setFailure]=useState<string|null>(null);
 const [attempt,setAttempt]=useState(0);
 useEffect(()=>{
  let current=true;
  setFailure(null);
  api<PersonalCalendarMonth>('/personal-calendar?month='+month,'GET',undefined,{timeout:8000}).then(data=>{
   if(current)setLoaded({month,data});
  }).catch(error=>{if(current)setFailure(error.message);});
  return()=>{current=false};
 },[month,refreshKey,attempt]);
 const data=loaded?.month===month?loaded.data:null;
 const today=data?.today??businessDay(new Date());
 const first=dateOf(month+'-01'),year=first.getUTCFullYear(),m=first.getUTCMonth();
 const pad=(first.getUTCDay()+6)%7,days=new Date(Date.UTC(year,m+1,0)).getUTCDate();
 const iso=(n:number)=>month+'-'+String(n).padStart(2,'0');
 const scheduledByDay=new Map<string,CalendarTask[]>();
 for(const task of data?.scheduled??[]){
  const date=businessDay(task.plan.plannedAt!),previous=scheduledByDay.get(date)??[];
  previous.push(task);scheduledByDay.set(date,previous);
 }
 const deadlinesByDay=new Map<string,CalendarDeadline[]>();
 for(const task of data?.deadlines??[]){
  const date=businessDay(task.deadline!),previous=deadlinesByDay.get(date)??[];
  previous.push(task);deadlinesByDay.set(date,previous);
 }
 const shift=(delta:number)=>{
  const target=new Date(Date.UTC(year,m+delta,1)).toISOString().slice(0,7);
  setDay(target===today.slice(0,7)?today:target+'-01');
 };
 const taskLink=(task:CalendarDeadline,label:string)=>open?
  <button type="button" className="text-button" onClick={()=>open(task.id)}>{label}</button>:
  <a className="text-button" href={'/?view=tasks&scope=mine&full=1&task='+encodeURIComponent(task.id)}>{label}</a>;
 return <section className="personal-calendar panel">
  <div className="panel-heading calendar-title">
   <div><h2>Мой календарь</h2><p>Личный план и крайние сроки · МСК</p></div>
   <button className="button secondary" type="button" onClick={()=>setDay(today)}>Сегодня</button>
  </div>
  {failure&&<div className="alert error" role="alert">{failure} <button className="text-button" onClick={()=>setAttempt(attempt+1)}>Повторить</button></div>}
  {data&&data.awaiting.length>0&&<section className="calendar-new">
   <h3>Нужно принять · {data.awaiting.length}</h3>
   <ul>{data.awaiting.map(task=><li key={task.id}>{taskLink(task,'#'+task.id+' · '+task.title)}
    {task.deadline&&<small>Крайний срок {planTime.format(new Date(task.deadline))} МСК</small>}</li>)}</ul>
  </section>}
  <div className="personal-calendar-grid">
   <section className="calendar-month" aria-label="Даты месяца">
    <div className="calendar-actions calendar-month-nav">
     <button className="icon-button" type="button" aria-label="Предыдущий месяц" onClick={()=>shift(-1)}><ChevronLeft size={20}/></button>
     <strong>{monthTitle.format(first)}</strong>
     <button className="icon-button" type="button" aria-label="Следующий месяц" onClick={()=>shift(1)}><ChevronRight size={20}/></button>
    </div>
    <div className="calendar-days">
     {weekdays.map(w=><small key={w}>{w}</small>)}
     {Array.from({length:pad},(_,i)=><span key={'pad'+i}/>)}
     {Array.from({length:days},(_,i)=>{
      const date=iso(i+1),count=scheduledByDay.get(date)?.length??0;
      const due=deadlinesByDay.get(date)?.length??0;
      const worked=data?.work.some(w=>w.date===date&&w.minutes!==null);
      return <button key={date} type="button" className={date===day?'selected':''} aria-pressed={date===day}
       aria-current={date===today?'date':undefined} aria-label={dayTitle.format(dateOf(date))+(count?', в плане '+count:'')+(due?', крайних сроков '+due:'')} onClick={()=>setDay(date)}>
       <span>{i+1}</span>{(!!count||!!due)&&<span className="calendar-counts">{!!count&&<small title="В личном плане">{count}</small>}{!!due&&<small className="calendar-deadline-count" title="Крайние сроки">{due}</small>}</span>}{worked&&<i aria-hidden="true"/>}
      </button>;
     })}
    </div>
    {data?.canLogWork&&<div className="calendar-actions calendar-month-total"><span>За месяц · {workTime(data.work.reduce((sum,w)=>sum+(w.minutes??0),0))}</span>
     <a className="text-button" href={'/api/personal-calendar/work.csv?month='+month}>Скачать CSV</a>
    </div>}
   </section>
   <section className="calendar-day" aria-label="План на день">
    <h3>{dayTitle.format(dateOf(day))}</h3>
    {!data&&!failure&&<p role="status" className="muted">Загружаем календарь…</p>}
    {data&&<h4>Личный план</h4>}
    {data&&!(scheduledByDay.get(day)?.length)&&<p className="muted">На этот день задач в плане пока нет.</p>}
    <ul className="calendar-task-list">{scheduledByDay.get(day)?.map(task=><li key={task.id}>
     <time>{moscowClock(task.plan.plannedAt!).slice(11)}</time>
     <div>{taskLink(task,'#'+task.id+' · '+task.title)}
      {task.plan.nextStep&&<strong>{task.plan.nextStep}</strong>}
      <small>{task.status==='completed'?'Завершена':task.status==='review'?'На приёмке':
       task.deadline?'Крайний срок '+planTime.format(new Date(task.deadline))+' МСК':'Без крайнего срока'}</small></div>
    </li>)}</ul>
    {data&&<h4>Крайние сроки</h4>}
    {data&&!(deadlinesByDay.get(day)?.length)&&<p className="muted">На этот день крайних сроков нет.</p>}
    <ul className="calendar-task-list">{deadlinesByDay.get(day)?.map(task=><li key={task.id}>
     <time>{moscowClock(task.deadline!).slice(11)}</time><div>{taskLink(task,'#'+task.id+' · '+task.title)}
     {task.status==='review'&&<small>На приёмке</small>}</div>
    </li>)}</ul>
    {data?.canLogWork&&day<=today&&<WorkLog key={day} day={day} work={data.work.find(w=>w.date===day)} saved={entry=>{
     setLoaded(previous=>previous?.month===month?{month,data:{...previous.data,work:[...previous.data.work.filter(w=>w.date!==entry.date),entry]}}:previous);
    }}/>}
   </section>
  </div>
 </section>;
}
