import type { Task } from './types.js';
export function businessDay(value:Date|string):string { return new Date(new Date(value).getTime()+10800000).toISOString().slice(0,10); }
/** GAS overdue/main.ts uses the start of the day and excludes waiting-control tasks. */
export function taskQueue(t:Task, now=new Date()):'overdue'|'today'|'upcoming'|'no_deadline'|'review'|'completed' {
 if(t.status==='completed'||t.status==='review')return t.status;
 if(!t.deadline)return 'no_deadline';
 const due=businessDay(t.deadline),today=businessDay(now);
 return due<today?'overdue':due===today?'today':'upcoming';
}
export const elapsedToday=(t:Task,now=new Date())=>taskQueue(t,now)==='today'&&new Date(t.deadline!)<now;
export function plannedToday(t:Task,now=new Date()){
 if(t.status!=='active')return false;
 const raw=t.planned_start!==undefined?t.planned_start:t.source_fields?.['Планируемая дата начала'];if(!raw||!t.planned_end)return false;
 const text=String(raw).replace(' ','T'),start=new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text)?text:text+'+03:00'),end=new Date(t.planned_end);
 const dayStart=new Date(businessDay(now)+'T00:00:00+03:00');
 return !isNaN(start.getTime())&&end>start&&start.getTime()<dayStart.getTime()+86400000&&end>dayStart;
}
export function taskCode(title:string){
 const name=title.replace(/копия/gi,'').replace(/\s+/g,' ').trim().toUpperCase();
 const match=name.match(/^([^*#]*)([*#])/),code=match?.[0]||'';
 return {code,legacy:code.endsWith('#'),valid:code.endsWith('#')||/^[РЕ][ЗПОВ][БМ]\*$/.test(code)};
}
