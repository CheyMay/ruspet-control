import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {transaction,type Db} from './db.js';
import {assert,canSee} from './domain.js';
import type {User,Task} from '../shared/types.js';
export type ActionState={task:Task;approvals:any[];submissions:any[];controls:any[];events:any[];comments:any[];decisions:any[];outbox:any[];rules:number};
export async function recordTaskBarrier(db:Db,u:User,id:string,label:string){await db.query("INSERT INTO undo_actions(id,task_id,actor_id,label,before_state,after_state,supported) VALUES($1,$2,$3,$4,'{}','{}',false)",[randomUUID(),id,u.id,label]);}
export async function actionState(db:Db,id:string):Promise<ActionState>{
 const task=(await db.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 const rows=async(table:string,where='task_id=$1')=>(await db.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`,[id])).rows;
 return {task,approvals:await rows('approvals'),submissions:await rows('task_submissions','task_id=$1 AND withdrawn_at IS NULL'),controls:await rows('control_requests'),events:(await db.query('SELECT id,actor_id FROM task_events WHERE task_id=$1 ORDER BY id',[id])).rows,comments:(await db.query('SELECT id FROM comments WHERE task_id=$1 AND withdrawn_at IS NULL ORDER BY id',[id])).rows,decisions:(await db.query('SELECT d.id FROM decisions d JOIN approvals a ON a.id=d.approval_id WHERE a.task_id=$1 ORDER BY d.id',[id])).rows,outbox:(await db.query('SELECT id FROM outbox WHERE task_id=$1 ORDER BY id',[id])).rows,rules:(await db.query('SELECT max(version)::int version FROM rule_versions')).rows[0].version};
}
export function sameState(a:ActionState,b:ActionState){
 // Notification delivery status is independent of task state. New task events,
 // changed controls, routes or submissions still prevent an unsafe undo.
 const stable=({outbox,task,...rest}:ActionState)=>({...rest,task:{...task,custom_fields:task.custom_fields??[],company_id:task.company_id??null,delegated_from_id:task.delegated_from_id??null}});return isDeepStrictEqual(stable(a),stable(b));
}
export async function recordTaskAction<T>(u:User,id:string,label:string,run:()=>Promise<T>):Promise<T>{
 return transaction(async db=>{
  const task=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0] as Task;assert(task&&canSee(u,task),404,'Задача недоступна.');
  const before=await actionState(db,id),result=await run(),after=await actionState(db,id);
  const known=new Set(before.events.map(e=>e.id)),added=after.events.filter(e=>!known.has(e.id));
  assert(added.every(e=>e.actor_id===u.id),409,'Параллельно произошло другое действие. Обновите задачу.');
  if(added.length)await db.query('INSERT INTO undo_actions(id,task_id,actor_id,label,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,u.id,label,JSON.stringify(before),JSON.stringify(after)]);
  return result;
 });
}
