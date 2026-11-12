import {businessDay,taskQueue} from '../shared/queues.js';
import type {Task} from '../shared/types.js';

/** Preserve the complete text. Chunk boundaries prefer paragraphs, lines, then words. */
export function botTextPages(text:string,size=2400):string[]{
 const pages:string[]=[];let rest=text;
 while(rest.length>size){
  let cut=rest.lastIndexOf('\n\n',size);
  if(cut<size/2)cut=rest.lastIndexOf('\n',size);
  if(cut<size/2)cut=rest.lastIndexOf(' ',size);
  if(cut<size/2)cut=size;
  if(/[\uD800-\uDBFF]/.test(rest[cut-1]))cut--;
  pages.push(rest.slice(0,cut));rest=rest.slice(cut);
 }
 return [...pages,rest];
}

export function botDue(task:Task,now:Date){
 if(task.status==='completed')return 'Завершена';
 if(!task.deadline)return 'Без срока';
 const day=businessDay(task.deadline),today=businessDay(now);
 const time=new Date(task.deadline).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
 if(day===today)return 'Сегодня '+time+(new Date(task.deadline)<now?' · срок прошёл':'');
 const date=new Date(task.deadline).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',...(day.slice(0,4)!==today.slice(0,4)?{year:'numeric' as const}:{})});
 return (day<today&&task.status==='active'?'Просрочена · ':'Срок ')+date;
}

export function sortBotTasks(tasks:Task[],now:Date){
 const rank={overdue:0,today:1,review:2,upcoming:3,no_deadline:4,completed:5};
 return [...tasks].sort((a,b)=>rank[taskQueue(a,now)]-rank[taskQueue(b,now)]||
  (a.deadline??'9999').localeCompare(b.deadline??'9999')||a.id.localeCompare(b.id,'ru',{numeric:true}));
}
