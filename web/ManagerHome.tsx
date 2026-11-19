import {ArrowRight,CalendarDays,Clock3,ListTodo} from 'lucide-react';
import {canComplete} from '../shared/actions.js';
import {TaskPeople} from './TaskPeople.js';
import {workLabels,type WorkBucket,type WorkQueue} from '../shared/work-queue.js';
import type {Bootstrap,Task} from '../shared/types.js';

type Props={data:Bootstrap;queue:WorkQueue;open:(id:string,tab?:string)=>void;tasks:(filter:string)=>void;placed:()=>void;
 actions:(bucket?:WorkBucket)=>void;team?:()=>void;calendar?:()=>void;complete?:(task:Task)=>void;busy?:boolean};
const timestamp=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});

export function ManagerHome({data,queue,open,tasks,placed,actions,team,calendar,complete,busy=false}:Props){
 const own=data.tasks.filter(task=>task.assignee_id===data.user.id&&task.status!=='completed');
 const focus=[...queue.overdue,...queue.today];
 const metrics=[{bucket:'overdue',Icon:Clock3},{bucket:'today',Icon:CalendarDays},{bucket:'next',Icon:ListTodo},{bucket:'waiting',Icon:Clock3}] as const;
 return <div className="personal-workspace">
  <section className="panel personal-intro">
   <div><h2>Мой рабочий день</h2><p>Незавершённые задачи: {own.length}</p></div>
   <div className="task-scope-actions">
    <button className="button secondary" onClick={()=>tasks('all')}>Мои задачи <ArrowRight size={16}/></button>
    <button className="button secondary" onClick={placed}>Я постановщик</button>
    {team&&<button className="button secondary" onClick={team}>Задачи команды</button>}
    {calendar&&!!data.pendingAssignments&&<button className="button primary" onClick={calendar}>Принять и запланировать · {data.pendingAssignments}</button>}
   </div>
  </section>
  <div className="personal-metrics">
   {metrics.map(({bucket,Icon})=><button type="button" key={bucket} onClick={()=>actions(bucket)}>
    <Icon size={19}/><strong>{queue[bucket].length}</strong><span>{workLabels[bucket]}</span><ArrowRight size={15}/></button>)}
  </div>
  <section className="panel personal-focus">
   <div className="panel-heading"><div><h2>С чего начать</h2><p>Ближайшие задачи, по которым сейчас ход за вами.</p></div>
    <button type="button" className="text-button" onClick={()=>actions()}>Все сроки и действия <ArrowRight size={15}/></button></div>
   {focus.length?focus.slice(0,3).map(item=>{
    const task=item.task;
    const label=item.needsAcceptance?'Принять назначение':item.action?.label??(item.deadlineState==='earlier'?'Просрочена':item.deadlineState==='expired'?'Срок истёк сегодня':'Крайний срок сегодня');
    return <div className="personal-task-row" key={task.id}><button type="button" className="focus-task" onClick={()=>open(task.id,item.tab)}>
     <span className="focus-task-id">#{task.id}</span>
     <div><strong>{task.title}</strong><TaskPeople task={task} users={data.users}/><small>{label}{task.deadline?' · '+timestamp.format(new Date(task.deadline))+' МСК':''}</small></div>
     <ArrowRight size={17}/>
    </button>{complete&&canComplete(data.user,task,data.approvalScope)&&!item.pendingApproval&&!item.needsAcceptance&&!item.action&&
     <button type="button" className="button secondary" disabled={busy} onClick={()=>complete(task)}>Завершить</button>}</div>;
   }):<p className="personal-empty">На сегодня по вашим срокам действий нет.</p>}
  </section>
 </div>;
}
