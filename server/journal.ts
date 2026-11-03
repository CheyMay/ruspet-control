import {transaction} from './db.js';
import {visibleTasks} from './service.js';
import {assert,globalAccess} from './domain.js';
import type {User} from '../shared/types.js';
export async function listJournal(u:User,p:{from?:string;to?:string;actor?:string;kind?:string;q?:string;page:number}){
 return transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert(!p.from||!p.to||p.from<=p.to,400,'Начало периода позже окончания.');
  const ids=(await visibleTasks(u,db)).map(t=>t.id);
  const args=[ids,globalAccess(u),p.from?p.from+'T00:00:00+03:00':null,p.to?p.to+'T23:59:59.999+03:00':null,p.actor||null,p.kind||null,p.q?'%'+p.q+'%':null];
  const where="(e.task_id=ANY($1) OR (e.task_id IS NULL AND $2)) AND ($3::timestamptz IS NULL OR e.created_at>=$3) AND ($4::timestamptz IS NULL OR e.created_at<=$4) AND ($5::text IS NULL OR e.actor_id=$5) AND ($6::text IS NULL OR e.kind=$6) AND ($7::text IS NULL OR concat_ws(' ',e.message,e.task_id,t.title,e.data->>'body',e.data->>'comment',e.data->>'reason') ILIKE $7)";
  const total=(await db.query('SELECT count(*)::int n FROM task_events e LEFT JOIN tasks t ON t.id=e.task_id WHERE '+where,args)).rows[0].n;
  const items=(await db.query('SELECT e.*,t.title task_title,u.name actor_name,EXISTS(SELECT 1 FROM event_retractions r WHERE r.event_id=e.id) retracted FROM task_events e LEFT JOIN tasks t ON t.id=e.task_id LEFT JOIN users u ON u.id=e.actor_id WHERE '+where+' ORDER BY e.created_at DESC,e.id DESC LIMIT 50 OFFSET $8',[...args,p.page*50])).rows;
  return {items,total,page:p.page,pageSize:50};
 });
}
