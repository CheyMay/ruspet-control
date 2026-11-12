import {randomUUID} from 'node:crypto';
import {transaction} from './db.js';
import {MockTaskProvider} from './providers.js';
import type {Task} from '../shared/types.js';
export async function markBitrixTaskDeleted(taskId:string){
 await transaction(async db=>{
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  if(!task||task.bitrix_deleted_at)return;
  const next=(await db.query<Task>('UPDATE tasks SET bitrix_deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[taskId])).rows[0];
  await new MockTaskProvider().applyApprovedChange(db,next,task.version);
  await db.query("UPDATE bitrix_task_links SET conflict='Задача удалена в Битрикс24. Требуется решение руководителя.',checked_at=now() WHERE task_id=$1",[taskId]);
  await db.query("UPDATE approvals SET state='stale' WHERE task_id=$1 AND state='pending'",[taskId]);
  await db.query('UPDATE task_alerts SET canceled_at=now() WHERE task_id=$1 AND acknowledged_at IS NULL AND canceled_at IS NULL',[taskId]);
  await db.query('UPDATE outbox o SET withdrawn_at=now() WHERE o.task_id=$1 AND o.withdrawn_at IS NULL AND NOT EXISTS(SELECT 1 FROM telegram_delivery d WHERE d.outbox_ids ? o.id::text)',[taskId]);
  await db.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,'bitrix_task_deleted','Получено событие удаления задачи в Битрикс24; данные сохранены в архиве',$3)",[randomUUID(),taskId,JSON.stringify({before:task,after:next})]);
 });
}
