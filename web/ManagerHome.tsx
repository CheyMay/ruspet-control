import {ArrowRight,Bell,CalendarDays,Clock3,ListTodo} from 'lucide-react';
import {actionItems,activeTaskApproval,canComplete,taskNextAction} from '../shared/actions.js';
import {TaskPeople} from './TaskPeople.js';
import {elapsedToday,taskQueue} from '../shared/queues.js';
import type {Bootstrap,Task} from '../shared/types.js';

type Props={data:Bootstrap;open:(id:string,tab?:string)=>void;tasks:(filter:string)=>void;actions:()=>void;team?:()=>void;reports?:()=>void;complete?:(task:Task)=>void;busy?:boolean};
const timestamp=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});

export function ManagerHome({data,open,tasks,actions,team,reports,complete,busy=false}:Props){
 const now=new Date(data.serverTime);
 const own=data.tasks.filter(task=>task.assignee_id===data.user.id&&task.status!=='completed');
 const urgent=own.filter(task=>taskQueue(task,now)==='overdue');
 const today=own.filter(task=>taskQueue(task,now)==='today');
 const queue=actionItems(data).filter(item=>item.mine);
 const next=queue.filter((item,index)=>queue.findIndex(other=>other.taskId===item.taskId)===index);
 const approvals=new Map(data.approvals.filter(a=>a.state==='pending'&&!a.canceled_at).map(a=>[a.task_id,a]));
 const focus=[...urgent,...today].filter(task=>taskNextAction(task,approvals.get(task.id),data.approvalScope)?.userId===data.user.id)
  .sort((a,b)=>(a.deadline||'').localeCompare(b.deadline||''));
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
    {title:'Нужны мои решения и ответы',n:next.length,Icon:Bell,go:actions},
    {title:'Просрочены с прошлых дней',n:urgent.length,Icon:Clock3,go:()=>tasks('overdue')},
    {title:'Срок сегодня',n:today.length,Icon:CalendarDays,go:()=>tasks('today')},
    {title:'Ожидают приёмки',n:own.filter(task=>task.status==='review').length,Icon:ListTodo,go:()=>tasks('review')}
   ].map(({title,n,Icon,go})=><button type="button" key={title} onClick={go}><Icon size={19}/><strong>{n}</strong><span>{title}</span><ArrowRight size={15}/></button>)}
  </div>
  <section className="panel personal-focus">
   <div className="panel-heading"><div><h2>Мои задачи к сроку</h2><p>Просрочки и сроки на сегодня, по которым сейчас ход за вами.</p></div></div>
   {focus.length?focus.slice(0,5).map(task=>{
    const approval=approvals.get(task.id),pending=approval&&activeTaskApproval(task,approval);
    const label=pending?taskNextAction(task,approval,data.approvalScope)?.label:taskQueue(task,now)==='overdue'?'Просрочена':elapsedToday(task,now)?'Срок истёк сегодня':'Крайний срок сегодня';
    return <div className="personal-task-row" key={task.id}><button type="button" className="focus-task" onClick={()=>open(task.id)}>
     <span className="focus-task-id">#{task.id}</span>
     <div><strong>{task.title}</strong><TaskPeople task={task} users={data.users}/><small>{label}{task.deadline?' · '+timestamp.format(new Date(task.deadline))+' МСК':''}</small></div>
     <ArrowRight size={17}/>
    </button>{complete&&canComplete(data.user,task,data.approvalScope)&&!pending&&
     <button type="button" className="button secondary" disabled={busy} onClick={()=>complete(task)}>Завершить</button>}</div>;
   }):<p className="personal-empty">На сегодня по вашим срокам действий нет.</p>}
   {focus.length>5&&<div className="personal-empty"><button className="text-button" onClick={()=>tasks('my_due')}>Показать все мои сроки</button></div>}
  </section>
 </div>;
}
