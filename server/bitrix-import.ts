import {randomUUID} from 'node:crypto';
import type {Task} from '../shared/types.js';
import {pool,transaction} from './db.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {ensureBitrixPeople,getRemote,localValues,remoteValues} from './bitrix-sync.js';

/** Link existing source IDs, or import an actually new task after explicit enablement. */
export async function importBitrixTask(request:BitrixRequest,externalId:string){
 const remote=await getRemote(request,externalId);
 if(!remote.responsibleId||!remote.createdBy||remote.status===null)throw new BitrixError('Для импорта нужны исполнитель, постановщик и статус.');
 await ensureBitrixPeople(request,remote);
 const values=await remoteValues(remote);
 return transaction(async db=>{
  const linked=(await db.query('SELECT task_id FROM bitrix_task_links WHERE external_id=$1',[externalId])).rows[0];
  if(linked)return linked.task_id as string;
  const original=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[externalId])).rows[0];
  if(original){
   if(String(original.source_fields?.ID)!==externalId)throw new BitrixError('Совпавший локальный ID не подтверждён исходной выгрузкой.');
   const imported=(await db.query("SELECT data->'initialSnapshot' AS snapshot FROM task_events WHERE task_id=$1 AND kind='imported' ORDER BY created_at LIMIT 1",[externalId])).rows[0]?.snapshot as Task|undefined;
   if(!imported)throw new BitrixError('Нет исходного снимка для привязки без потери локальных изменений.');
   await db.query('INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,$2,$3,$4)',[externalId,externalId,JSON.stringify(localValues(imported,values)),imported.version]);
   return externalId;
  }
  const taskId='B-'+externalId;
  const task=(await db.query<Task>(`INSERT INTO tasks(id,title,description,deadline,assignee_id,creator_id,status,branch_id,
   original_deadline,priority,code,important,customer_risk,completed_at,source_status,price,planned_start,planned_end,accomplice_ids,auditor_ids)
   VALUES($1,$2,$3,$4,$5,$6,$7,(SELECT branch_id FROM users WHERE id=$5),NULL,$11,$8,$12,$13,$9,$10,$14,$15,$16,$17,$18) RETURNING *`,
   [taskId,values.title,values.description,values.deadline,values.assignee_id,values.creator_id,values.status,values.title.split(/\s/)[0],remote.closedDate,remote.status,values.priority??'normal',values.important??null,values.customer_risk??null,values.price??null,values.planned_start??null,values.planned_end??null,values.accomplice_ids??[],values.auditor_ids??[]])).rows[0];
  await db.query('INSERT INTO mock_provider_tasks(id,snapshot,revision) VALUES($1,$2,$3)',[task.id,JSON.stringify(task),task.version]);
  await db.query('INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,$2,$3,$4)',[task.id,externalId,JSON.stringify(values),task.version]);
  await db.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,'bitrix_imported','Задача получена из Битрикс24',$3)",[randomUUID(),task.id,JSON.stringify({after:task})]);
  return taskId;
 });
}
