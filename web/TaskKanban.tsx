import {useLayoutEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,CalendarDays,Columns3,List} from 'lucide-react';
import {taskBoard} from '../shared/task-board.js';
import {formatPrice,taskPrice} from '../shared/pricing.js';
import type {Task,User} from '../shared/types.js';

const timeZone='Europe/Moscow';
const shortDate=new Intl.DateTimeFormat('ru-RU',{timeZone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const fullDate=new Intl.DateTimeFormat('ru-RU',{timeZone,day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
const year=new Intl.DateTimeFormat('ru-RU',{timeZone,year:'numeric'});
const cardsPerLane=20;

export function TaskViewSwitch({board,change}:{board:boolean;change:(view:'list'|'board')=>void}){
 return <div className="task-view-switch" role="group" aria-label="Вид задач">
  <button type="button" aria-pressed={!board} onClick={()=>change('list')}><List size={16}/> Список</button>
  <button type="button" aria-pressed={board} onClick={()=>change('board')}><Columns3 size={16}/> Канбан</button>
 </div>;
}

function TaskBoardCard({task,names,now,open}:{task:Task;names:ReadonlyMap<string,string>;now:Date;open:(id:string)=>void}){
 const deadline=task.deadline?new Date(task.deadline):null;
 const valid=deadline&&Number.isFinite(+deadline);
 const due=valid?(year.format(now)===year.format(deadline)?shortDate:fullDate).format(deadline):null;
 return <button type="button" className="kanban-card" onClick={()=>open(task.id)}>
  <span className="kanban-card-reference"><span>#{task.id}</span>{taskPrice(task)!==null&&<span>{formatPrice(task)}</span>}</span>
  <strong>{task.title}</strong>
  {!!task.client_names?.length&&<span className="kanban-client">{task.client_names.join(' · ')}</span>}
  {due&&<span className="kanban-card-deadline"><CalendarDays size={15} aria-hidden="true"/><time dateTime={task.deadline!}>{due}</time></span>}
  <span className="kanban-card-people">
   <span><span>Исполнитель</span> {names.get(task.assignee_id)??task.assignee_id}</span>
   <span><span>Постановщик</span> {names.get(task.creator_id)??task.creator_id}</span>
  </span>
 </button>;
}

export function TaskKanban({tasks,users,now,pending,filtered,open}:{tasks:Task[];users:User[];now:Date;pending:ReadonlySet<string>;filtered:boolean;open:(id:string)=>void}){
 const board=useRef<HTMLDivElement>(null);
 const [limit,setLimit]=useState<Record<string,number>>({});
 const names=new Map(users.map(user=>[user.id,user.name]));
 const columns=taskBoard(tasks,now,pending);
 const firstMatch=filtered?columns.find(column=>column.tasks.length)?.id:undefined;
 useLayoutEffect(()=>{if(board.current)board.current.scrollLeft=columnLeft(board.current,firstMatch);},[firstMatch]);
 function columnLeft(track:HTMLDivElement,id?:string){
  return Array.from(track.children).find((child):child is HTMLElement=>child instanceof HTMLElement&&child.dataset.lane===id)?.offsetLeft??0;
 }
 function scroll(direction:number){
  const track=board.current;
  const column=track?.firstElementChild?.getBoundingClientRect();
  if(track&&column){
   const distance=column.width+parseFloat(getComputedStyle(track).columnGap);
   const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
   track.scrollBy({left:direction*distance,behavior:reduceMotion?'instant':'smooth'});
  }
 }
 return <section className="task-kanban" aria-label="Канбан задач по крайним срокам">
  <div className="kanban-toolbar">
   <span>Крайние сроки · МСК</span>
   <div className="kanban-scroll-controls">
    <select aria-label="Перейти к колонке" value="" onChange={event=>{if(board.current&&event.target.value)board.current.scrollLeft=columnLeft(board.current,event.target.value);}}>
     <option value="">К колонке</option>{columns.map(column=><option key={column.id} value={column.id}>{column.title} · {column.tasks.length}</option>)}
    </select>
    <button type="button" className="icon-button" onClick={()=>scroll(-1)} aria-label="Предыдущие колонки"><ArrowLeft size={18}/></button>
    <button type="button" className="icon-button" onClick={()=>scroll(1)} aria-label="Следующие колонки"><ArrowRight size={18}/></button>
   </div>
  </div>
  {!tasks.length&&<p className="kanban-empty">По выбранным фильтрам задач нет.</p>}
  <div className="kanban-track" ref={board} tabIndex={0} role="region" aria-label="Колонки по срокам и состоянию">
   {columns.map(({id,title,tasks:columnTasks})=>{
    const shown=limit[id]??cardsPerLane;
    return <section className="kanban-lane" key={id} data-lane={id} aria-label={title}>
     <header className="kanban-lane-header"><h3>{title}</h3><span>{columnTasks.length}</span></header>
     <div className="kanban-lane-content">
      <ul>{columnTasks.slice(0,shown).map(task=><li key={task.id}><TaskBoardCard task={task} names={names} now={now} open={open}/></li>)}</ul>
      {shown<columnTasks.length&&<button className="text-button kanban-more" type="button" onClick={()=>setLimit(previous=>({...previous,[id]:shown+cardsPerLane}))}>Показать ещё {Math.min(cardsPerLane,columnTasks.length-shown)}</button>}
     </div>
    </section>;
   })}
  </div>
 </section>;
}
