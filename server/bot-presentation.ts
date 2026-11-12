import {businessDay,elapsedToday,taskQueue} from '../shared/queues.js';
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

export function botTaskStatus(task:Task,now:Date,pending=false){
 if(task.status==='completed')return 'Завершена';
 if(pending)return 'На согласовании';
 if(task.status==='review')return 'На приёмке';
 if(taskQueue(task,now)==='overdue')return 'Просрочена';
 if(elapsedToday(task,now))return 'Срок сегодня прошёл';
 return 'В работе';
}

export function botDue(task:Task,now:Date){
 if(!task.deadline)return 'Без срока';
 const day=businessDay(task.deadline),today=businessDay(now);
 const deadline=new Date(task.deadline);
 if(day===today)return 'Сегодня '+deadline.toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});
 return deadline.toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',...(day.slice(0,4)!==today.slice(0,4)?{year:'numeric' as const}:{})});
}

export function botExcerpt(text:string,limit:number){
 const line=text.replace(/\s+/gu,' ').trim();
 if(line.length<=limit)return line;
 const head=line.slice(0,limit-1).replace(/[\uD800-\uDBFF]$/u,'');
 const wordEnd=head.lastIndexOf(' ');
 return (wordEnd>=limit*.65?head.slice(0,wordEnd):head)+'…';
}

export function sortBotTasks(tasks:Task[],now:Date){
 const rank={overdue:0,today:1,review:2,upcoming:3,no_deadline:4,completed:5};
 return [...tasks].sort((a,b)=>rank[taskQueue(a,now)]-rank[taskQueue(b,now)]||
  (a.deadline??'9999').localeCompare(b.deadline??'9999')||a.id.localeCompare(b.id,'ru',{numeric:true}));
}
