import {taskNumber} from '../shared/task-number.js';
import {useEffect,useLayoutEffect,useRef,useState,type DragEvent} from 'react';
import {ArrowLeft,ArrowRight,CalendarClock,CalendarDays,Columns3,List} from 'lucide-react';
import {suggestedBoardDeadline,taskBoard,type TaskLaneId} from '../shared/task-board.js';
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

function TaskBoardCard({task,names,now,open,startDrag,endDrag}:{task:Task;names:ReadonlyMap<string,string>;now:Date;open:(id:string)=>void;
 startDrag?: (event:DragEvent<HTMLButtonElement>)=>void;endDrag:()=>void}){
 const deadline=task.deadline?new Date(task.deadline):null;
 const valid=deadline&&Number.isFinite(+deadline);
 const due=valid?(year.format(now)===year.format(deadline)?shortDate:fullDate).format(deadline):null;
 return <button type="button" className="kanban-card" draggable={!!startDrag} onDragStart={startDrag} onDragEnd={endDrag} onClick={()=>open(task.id)}>
  <span className="kanban-card-reference"><span>#{taskNumber(task)}</span>{taskPrice(task)!==null&&<span>{formatPrice(task)}</span>}</span>
  <strong>{task.title}</strong>
  {(task.assignment_pending||task.priority==='high'||task.critical)&&<span className="task-flags">
   {task.assignment_pending&&<small>Не принята</small>}{task.priority==='high'&&<small>Высокий приоритет</small>}{task.critical&&<small>Критичная</small>}
  </span>}
  {!!task.client_names?.length&&<span className="kanban-client">{task.client_names.join(' · ')}</span>}
  {due&&<span className="kanban-card-deadline"><CalendarDays size={15} aria-hidden="true"/><time dateTime={task.deadline!}>{due}</time></span>}
  <span className="kanban-card-people">
   <span><span>Исполнитель</span> {names.get(task.assignee_id)??task.assignee_id}</span>
   <span><span>Постановщик</span> {names.get(task.creator_id)??task.creator_id}</span>
  </span>
 </button>;
}

export function TaskKanban({tasks,users,now,pending,filtered,open,canMove,move}:{tasks:Task[];users:User[];now:Date;
 pending:ReadonlySet<string>;filtered:boolean;open:(id:string)=>void;canMove:(task:Task)=>boolean;move:(task:Task,deadline?:string)=>void}){
 const board=useRef<HTMLDivElement>(null);
 const edge=useRef(0);
 const [limit,setLimit]=useState<Record<string,number>>({});
 const [drag,setDrag]=useState<{task:Task;from:TaskLaneId}|null>(null);
 const [hovered,setHovered]=useState<TaskLaneId>();
 const names=new Map(users.map(user=>[user.id,user.name]));
 const columns=taskBoard(tasks,now,pending);
 const firstMatch=filtered?columns.find(column=>column.tasks.length)?.id:undefined;
 useLayoutEffect(()=>{if(board.current)board.current.scrollLeft=columnLeft(board.current,firstMatch);},[firstMatch]);
 useEffect(()=>{
  const track=board.current;
  if(!track)return;
  function shiftScroll(event:WheelEvent){
   if(!event.shiftKey||!track||track.scrollWidth<=track.clientWidth)return;
   event.preventDefault();
   const delta=event.deltaX||event.deltaY;
   track.scrollLeft+=delta*(event.deltaMode===1?18:event.deltaMode===2?track.clientWidth:1);
  }
  track.addEventListener('wheel',shiftScroll,{passive:false});
  return()=>track.removeEventListener('wheel',shiftScroll);
 },[]);
 useEffect(()=>{
  if(!drag)return;
  let frame:number;
  const scrollAtEdge=()=>{
   if(edge.current&&board.current)board.current.scrollLeft+=edge.current*8;
   frame=requestAnimationFrame(scrollAtEdge);
  };
  frame=requestAnimationFrame(scrollAtEdge);
  return()=>cancelAnimationFrame(frame);
 },[drag]);
 const suggested=(id:TaskLaneId)=>drag&&drag.from!==id?suggestedBoardDeadline(id,now):undefined;
 function endDrag(){edge.current=0;setDrag(null);setHovered(undefined);}
 function showDrop(event:DragEvent<HTMLDivElement>){
  if(!drag)return;
  const track=event.currentTarget.getBoundingClientRect();
  edge.current=event.clientX<track.left+36?-1:event.clientX>track.right-36?1:0;
  const lane=event.target instanceof Element?event.target.closest<HTMLElement>('[data-lane]')?.dataset.lane as TaskLaneId|undefined:undefined;
  const allowed=lane&&suggested(lane);
  setHovered(allowed?lane:undefined);
  if(allowed){event.preventDefault();event.dataTransfer.dropEffect='move';}
 }
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
   <div className="kanban-controls-label"><span>Крайние сроки · МСК</span><small>{drag?'Отпустите карточку в подсвеченной колонке':'Shift + колёсико для прокрутки вбок'}</small></div>
   <div className="kanban-scroll-controls">
    <select aria-label="Перейти к колонке" value="" onChange={event=>{if(board.current&&event.target.value)board.current.scrollLeft=columnLeft(board.current,event.target.value);}}>
     <option value="">К колонке</option>{columns.map(column=><option key={column.id} value={column.id}>{column.title} · {column.tasks.length}</option>)}
    </select>
    <button type="button" className="icon-button" onClick={()=>scroll(-1)} aria-label="Предыдущие колонки"><ArrowLeft size={18}/></button>
    <button type="button" className="icon-button" onClick={()=>scroll(1)} aria-label="Следующие колонки"><ArrowRight size={18}/></button>
   </div>
  </div>
  {!tasks.length&&<p className="kanban-empty">По выбранным фильтрам задач нет.</p>}
  <div className="kanban-track" ref={board} tabIndex={0} role="region" aria-label="Колонки по срокам и состоянию"
   onDragOver={showDrop} onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget)){edge.current=0;setHovered(undefined);}}}>
   {columns.map(({id,title,tasks:columnTasks})=>{
    const shown=limit[id]??cardsPerLane;
    return <section className="kanban-lane" key={id} data-lane={id} aria-label={title} data-drop={hovered===id?'active':suggested(id)?'ready':undefined}
     onDrop={event=>{const deadline=suggested(id);if(!deadline||!drag)return;event.preventDefault();move(drag.task,deadline);endDrag();}}>
     <header className="kanban-lane-header"><h3>{title}</h3><span>{columnTasks.length}</span></header>
     <div className="kanban-lane-content">
      <ul>{columnTasks.slice(0,shown).map(task=>{
       const movable=canMove(task);
       return <li key={task.id} data-movable={movable||undefined} data-dragging={drag?.task.id===task.id||undefined}>
        <TaskBoardCard task={task} names={names} now={now} open={open} endDrag={endDrag}
         startDrag={movable?event=>{event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',task.id);setDrag({task,from:id});}:undefined}/>
        {movable&&<button type="button" className="icon-button kanban-move" title="Перенести срок"
         aria-label={'Перенести срок задачи '+task.id} onClick={()=>move(task)}><CalendarClock size={17}/></button>}
       </li>;
      })}</ul>
      {shown<columnTasks.length&&<button className="text-button kanban-more" type="button" onClick={()=>setLimit(previous=>({...previous,[id]:shown+cardsPerLane}))}>Показать ещё {Math.min(cardsPerLane,columnTasks.length-shown)}</button>}
     </div>
    </section>;
   })}
  </div>
 </section>;
}
