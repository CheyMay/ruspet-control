import {businessDay,elapsedToday,taskQueue} from './queues.js';
import type {Task} from './types.js';

export const taskLanes=[
 {id:'overdue',title:'Просрочено'},
 {id:'today',title:'Сегодня'},
 {id:'week',title:'На этой неделе'},
 {id:'nextWeek',title:'На следующей неделе'},
 {id:'later',title:'Позже'},
 {id:'noDeadline',title:'Без срока'},
 {id:'pending',title:'На согласовании'},
 {id:'review',title:'На приёмке'},
 {id:'completed',title:'Завершены'},
] as const;
export type TaskLaneId=(typeof taskLanes)[number]['id'];
const dayMs=86400000;
const dayAt=(stamp:number)=>new Date(stamp).toISOString().slice(0,10);
function boardWeek(now:Date){
 const today=new Date(businessDay(now)+'T00:00:00Z');
 return {today:+today,sunday:+today+((7-today.getUTCDay())%7)*dayMs};
}

export function suggestedBoardDeadline(lane:TaskLaneId,now:Date){
 const {today,sunday}=boardWeek(now);
 if(lane==='week'&&today<sunday)return dayAt(today+dayMs)+'T18:00';
 if(lane==='nextWeek')return dayAt(sunday+dayMs)+'T18:00';
 if(lane==='later')return dayAt(sunday+8*dayMs)+'T18:00';
 if(lane!=='today')return undefined;
 const evening=Date.parse(dayAt(today)+'T18:00:00+03:00');
 const lastMinute=Date.parse(dayAt(today)+'T23:59:00+03:00');
 const candidate=Math.min(lastMinute,Math.max(evening,Math.ceil((+now+3600000)/60000)*60000));
 if(candidate<=+now)return undefined;
 return new Date(candidate+10800000).toISOString().slice(0,16);
}

export function taskBoard<T extends Pick<Task,'id'|'status'|'deadline'>>(tasks:readonly T[],now:Date,pending:ReadonlySet<string>){
 const {sunday}=boardWeek(now);
 const endOfWeek=dayAt(sunday);
 const endOfNextWeek=dayAt(sunday+7*dayMs);
 const groups=new Map<TaskLaneId,T[]>(taskLanes.map(({id})=>[id,[]]));

 function lane(task:T):TaskLaneId{
  if(task.status==='completed')return 'completed';
  if(pending.has(task.id))return 'pending';
  if(task.status==='review')return 'review';
  if(!task.deadline||!Number.isFinite(Date.parse(task.deadline)))return 'noDeadline';
  const queue=taskQueue(task,now);
  if(queue==='overdue'||elapsedToday(task,now))return 'overdue';
  if(queue==='today')return 'today';
  const due=businessDay(task.deadline);
  return due<=endOfWeek?'week':due<=endOfNextWeek?'nextWeek':'later';
 }

 for(const task of tasks)groups.get(lane(task))!.push(task);
 return taskLanes.map(column=>({...column,tasks:groups.get(column.id)!}));
}
