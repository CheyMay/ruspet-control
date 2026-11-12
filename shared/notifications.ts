import type {Notification} from './types.js';

export function groupNotifications<T extends Pick<Notification,'id'|'task_id'|'created_at'>>(items:T[]){
 const groups=new Map<string,T[]>();
 for(const item of [...items].sort((a,b)=>b.created_at.localeCompare(a.created_at))){
  const key=item.task_id?'task:'+item.task_id:'notice:'+item.id;
  const group=groups.get(key);
  if(group)group.push(item);else groups.set(key,[item]);
 }
 return [...groups.values()];
}
