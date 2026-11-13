import {ArrowRight,Bell,CalendarDays,Clock3,ListTodo} from 'lucide-react';
import {actionItems} from '../shared/actions.js';
import {taskQueue} from '../shared/queues.js';
import type {Bootstrap} from '../shared/types.js';

type Props={data:Bootstrap;open:(id:string,tab?:string)=>void;tasks:(filter:string)=>void;actions:()=>void;team?:()=>void;reports?:()=>void};
const timestamp=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});

export function ManagerHome({data,open,tasks,actions,team,reports}:Props){
 const now=new Date(data.serverTime);
 const own=data.tasks.filter(task=>task.assignee_id===data.user.id&&task.status!=='completed');
 const urgent=own.filter(task=>taskQueue(task,now)==='overdue');
 const today=own.filter(task=>taskQueue(task,now)==='today');
 const byTask=new Map(data.tasks.map(task=>[task.id,task]));
 const queue=actionItems(data).filter(item=>item.mine);
 const next=queue.filter((item,index)=>queue.findIndex(other=>other.taskId===item.taskId)===index);
 const fallback=[...urgent,...today].sort((a,b)=>(a.deadline||'').localeCompare(b.deadline||''));
 const focus=fallback.map(task=>({id:task.id,title:task.title,label:taskQueue(task,now)==='overdue'?'Просрочена':'Крайний срок сегодня'}));
 return <div className="personal-workspace">
  <section className="panel personal-intro">
   <div><h2>Мой рабочий день</h2><p>Незавершённые задачи: {own.length}</p></div>
   <div className="task-scope-actions">
    <button className="button secondary" onClick={()=>tasks('all')}>Мои задачи <ArrowRight size={16}/></button>
    {team&&<button className="button secondary" onClick={team}>Задачи команды</button>}
    {reports&&<button className="button secondary" onClick={reports}>Мой отчёт</button>}
   </div>
  </section>
  <div className="personal-metrics">
   {[
    {title:'Нужно действие',n:next.length,Icon:Bell,go:actions},
    {title:'Просрочены',n:urgent.length,Icon:Clock3,go:()=>tasks('overdue')},
    {title:'Срок сегодня',n:today.length,Icon:CalendarDays,go:()=>tasks('today')},
    {title:'Ожидают приёмки',n:own.filter(task=>task.status==='review').length,Icon:ListTodo,go:()=>tasks('review')}
   ].map(({title,n,Icon,go})=><button type="button" key={title} onClick={go}><Icon size={19}/><strong>{n}</strong><span>{title}</span><ArrowRight size={15}/></button>)}
  </div>
  <section className="panel personal-focus">
   <div className="panel-heading"><div><h2>Мои задачи к сроку</h2><p>Просрочки и задачи со сроком сегодня.</p></div></div>
   {focus.length?focus.slice(0,5).map(item=>{
    const task=byTask.get(item.id);
    return <button type="button" className="focus-task" key={item.id} onClick={()=>open(item.id)}>
     <span className="focus-task-id">#{item.id}</span>
     <div><strong>{item.title}</strong><small>{item.label}{task?.deadline?' · '+timestamp.format(new Date(task.deadline))+' МСК':''}</small></div>
     <ArrowRight size={17}/>
    </button>;
   }):<p className="personal-empty">Просроченных задач и задач со сроком сегодня нет.</p>}
   {focus.length>5&&<div className="personal-empty"><button className="text-button" onClick={()=>tasks('active')}>Показать остальные</button></div>}
  </section>
 </div>;
}
