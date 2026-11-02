import type { Db } from './db.js';
import type { Task } from '../shared/types.js';
import { assert } from './domain.js';
/** Internal application contract. These names are NOT Bitrix24 REST methods/events.
 * Real REST/event delivery needs a separate outbox worker, reconciliation and documented mappings.
 * The transaction parameter is supported only by the local mock adapter. */
export interface TaskProvider {
 readonly mode: 'mock' | 'real';
 listTasks(db:Db): Promise<Task[]>;
 getTask(db:Db,id:string):Promise<Task|null>;
 applyApprovedChange(db:Db, task:Task, previousVersion:number):Promise<void>;
}
export class MockTaskProvider implements TaskProvider {
 readonly mode='mock' as const;
 async listTasks(db:Db) { return (await db.query('SELECT snapshot FROM mock_provider_tasks ORDER BY id')).rows.map(r=>r.snapshot); }
 async getTask(db:Db,id:string) { return (await db.query('SELECT snapshot FROM mock_provider_tasks WHERE id=$1',[id])).rows[0]?.snapshot || null; }
 async applyApprovedChange(db:Db,task:Task,previousVersion:number) {
  const result=await db.query('UPDATE mock_provider_tasks SET snapshot=$2,revision=$3 WHERE id=$1 AND revision=$4',[task.id,JSON.stringify(task),task.version,previousVersion]);
  assert(result.rowCount===1,409,'Источник задачи изменился. Обновите данные и создайте новый запрос.');
 }
}
export interface NotificationAdapter { readonly mode:'mock'|'real'; dispatch(db:Db):Promise<number> }
export class MockTelegramAdapter implements NotificationAdapter {
 readonly mode='mock' as const;
 async dispatch(db:Db) { return (await db.query("UPDATE outbox SET state='simulated' WHERE state='queued'")).rowCount || 0; }
}
export function providers() {
 assert(!process.env.TASK_PROVIDER || process.env.TASK_PROVIDER==='mock',503,'Real Bitrix24 provider is not implemented.');
 assert(!process.env.TELEGRAM_MODE || process.env.TELEGRAM_MODE==='mock',503,'Real Telegram adapter is not implemented.');
 return { tasks:new MockTaskProvider(),telegram:new MockTelegramAdapter() };
}
