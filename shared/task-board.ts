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
type LaneId=(typeof taskLanes)[number]['id'];

export function taskBoard<T extends Pick<Task,'id'|'status'|'deadline'>>(tasks:readonly T[],now:Date,pending:ReadonlySet<string>){
 const today=new Date(businessDay(now)+'T00:00:00Z');
 const untilSunday=(7-today.getUTCDay())%7;
 const endOfWeek=new Date(+today+untilSunday*86400000).toISOString().slice(0,10);
 const endOfNextWeek=new Date(+today+(untilSunday+7)*86400000).toISOString().slice(0,10);
 const groups=new Map<LaneId,T[]>(taskLanes.map(({id})=>[id,[]]));

 function lane(task:T):LaneId{
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
