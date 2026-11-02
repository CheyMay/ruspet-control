import {businessDay,taskQueue,elapsedToday} from './queues.js';
import type {Task} from './types.js';
export const queueLabels={overdue:'Просрочены ранее',today:'Сегодня последний день',upcoming:'Срок впереди',no_deadline:'Без срока',review:'Ожидают приёмки',completed:'Завершены'};
export function summarize(tasks:Task[],now=new Date()){
 const counts={overdue:0,today:0,upcoming:0,no_deadline:0,review:0,completed:0};
 for(const t of tasks)counts[taskQueue(t,now)]++;
 return {...counts,total:tasks.length,unfinished:tasks.length-counts.completed,elapsedToday:tasks.filter(t=>elapsedToday(t,now)).length};
}
export function sourceTime(raw:unknown):string|null{
 if(!raw)return null;const value=String(raw).replace(' ','T');const date=new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value)?value:value+'+03:00');return isNaN(date.getTime())?null:date.toISOString();
}
export function plannedInterval(t:Task){return {start:t.planned_start!==undefined?t.planned_start:sourceTime(t.source_fields?.['Планируемая дата начала']),end:t.planned_end};}
export function plannedMinutesOn(t:Task,day:string):number|null{
 const {start,end}=plannedInterval(t);if(!start||!end)return null;
 const a=new Date(start).getTime(),b=new Date(end).getTime();if(b<a)return null;
 const from=new Date(day+'T00:00:00+03:00').getTime();return Math.max(0,Math.min(b,from+86400000)-Math.max(a,from))/60000;
}
export function daysFrom(now:Date,count:number){const first=businessDay(now);return Array.from({length:count},(_,i)=>new Date(new Date(first+'T12:00:00+03:00').getTime()+i*86400000).toISOString().slice(0,10));}
