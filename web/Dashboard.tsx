import {useRememberedFilter} from './remembered-filter.js';
import {EmployeeFilter} from './SearchFilter.js';
import {priceCounts,priceLabels} from '../shared/pricing.js';
import type {Bootstrap} from '../shared/types.js';
import {daysFrom,plannedMinutesOn,plannedInterval} from '../shared/analytics.js';
import {businessDay} from '../shared/queues.js';

const short=(day:string)=>new Date(day+'T12:00:00+03:00').toLocaleDateString('ru-RU',{day:'numeric',month:'short',timeZone:'Europe/Moscow'});

export function Dashboard({data,now,go}:{data:Bootstrap;now:Date;go:(filter:string,owner?:string,price?:string)=>void}){
 const [owner,setOwner]=useRememberedFilter(data.user.id,'Dashboard.owner','all');
 const [tab,setTab]=useRememberedFilter(data.user.id,'Dashboard.tab','control');
 const tasks=data.tasks.filter(task=>owner==='all'||task.assignee_id===owner);
 const assignees=new Set(data.tasks.map(task=>task.assignee_id));
 const users=data.users.filter(user=>user.id===owner||assignees.has(user.id));
 const days=daysFrom(now,7);
 const active=tasks.filter(task=>task.status==='active');
 const daily=days.map(day=>active.filter(task=>task.deadline&&businessDay(task.deadline)===day).length);
 const max=Math.max(1,...daily);
 const click=(filter:string,price?:string)=>go(filter,owner==='all'?undefined:owner,price);
 const showLoad=data.rules.showPlanning&&tab==='load';
 const waiting=tasks.filter(task=>data.controls.some(control=>control.task_id===task.id&&['waiting','escalated'].includes(control.state))).length;
 const risk=tasks.filter(task=>task.customer_risk&&task.status!=='completed').length;

 return <div className="task-metrics-content">
  <div className="dashboard-toolbar">
   <EmployeeFilter label="Исполнитель в сводке" value={owner} onChange={setOwner}
    people={users} empty={{value:'all',label:'Все исполнители'}}/>
   {data.rules.showPlanning&&<div className="tabs" aria-label="Показатели задач">
    <button type="button" className={!showLoad?'selected':''} onClick={()=>setTab('control')}>Цены и крайние сроки</button>
    <button type="button" className={showLoad?'selected':''} onClick={()=>setTab('load')}>Плановая нагрузка</button>
   </div>}
  </div>
  {showLoad?<section className="panel">
   <div className="panel-heading"><div><h2>Плановая нагрузка · 7 дней</h2><p>Часы по запланированным интервалам задач</p></div></div>
   <div className="table-scroll"><table><thead><tr><th>Сотрудник</th>{days.map(day=><th key={day}>{short(day)}</th>)}<th>Без полного плана</th></tr></thead>
    <tbody>{users.filter(user=>owner==='all'||user.id===owner).map(user=>{
     const own=active.filter(task=>task.assignee_id===user.id);
     return <tr key={user.id}><td>{user.name}</td>{days.map(day=>{
      const minutes=own.reduce((sum,task)=>sum+(plannedMinutesOn(task,day)||0),0);
      return <td key={day} className={minutes>480?'load-high':''}>{minutes?(minutes/60).toLocaleString('ru-RU',{maximumFractionDigits:1})+' ч':'—'}</td>;
     })}<td>{own.filter(task=>{const plan=plannedInterval(task);return !plan.start||!plan.end||new Date(plan.end)<new Date(plan.start);}).length}</td></tr>;
    })}</tbody></table></div>
   <p className="section-footnote">Учитываются пересечения, вечера и выходные. Если получилось больше 8 часов за день, проверьте план.</p>
  </section>:<>
   <section className="price-counters" aria-label="Задачи по цене">{Object.entries(priceCounts(tasks)).map(([key,count])=>
    <button type="button" key={key} onClick={()=>click('all',key)}><strong>{count}</strong><span>{priceLabels[key as keyof typeof priceLabels]}</span></button>
   )}</section>
   <div className="task-scope-actions">
    <button className="button secondary" type="button" onClick={()=>click('waiting')}>Ждут ответа сотрудника · {waiting}</button>
    <button className="button secondary" type="button" onClick={()=>click('risk')}>Риск потери клиента · {risk}</button>
   </div>
   <section className="panel">
    <div className="panel-heading"><div><h2>Крайние сроки · 7 дней</h2><p>Задачи в работе по московскому времени</p></div></div>
    <div className="deadline-chart">{days.map((day,i)=><button type="button" key={day} onClick={()=>click('day:'+day)} title={short(day)+': '+daily[i]+' задач'}>
     <strong>{daily[i]}</strong><span className="bar-space"><i style={{height:daily[i]/max*100+'%',minHeight:daily[i]?4:0}}/></span>
     <small>{i===0?'Сегодня':short(day)}</small>
    </button>)}</div>
   </section>
  </>}
 </div>;
}
