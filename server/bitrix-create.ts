import {customCreationFields} from './bitrix-custom-fields.js';
import {parsePrice} from '../shared/pricing.js';
import {randomUUID} from 'node:crypto';
import type {Task} from '../shared/types.js';
import {pool,transaction} from './db.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {bitrixId,getRemote,localValues,remoteValues,planFields} from './bitrix-sync.js';

/** Common Bitrix worker lock required. Ambiguous creates are never blindly retried. */
export async function processBitrixCreation(request:BitrixRequest){
 if(process.env.BITRIX_WRITE_ENABLED!=='true'||process.env.BITRIX_CREATE_ENABLED!=='true')return false;
 let intent=(await pool.query("SELECT * FROM bitrix_task_creations WHERE state='confirming' AND (retry_at IS NULL OR retry_at<=now()) ORDER BY attempted_at LIMIT 1")).rows[0];
 if(!intent){
  const task=(await pool.query<Task>(`SELECT t.* FROM tasks t WHERE
   NOT EXISTS(SELECT 1 FROM bitrix_task_links l WHERE l.task_id=t.id)
   AND NOT EXISTS(SELECT 1 FROM bitrix_task_creations c WHERE c.task_id=t.id)
   AND EXISTS(SELECT 1 FROM task_sync_queue q WHERE q.task_id=t.id AND q.payload->>'kind'='created' AND q.state IN ('pending','failed') AND (q.retry_at IS NULL OR q.retry_at<=now()))
   AND EXISTS(SELECT 1 FROM bitrix_user_links u WHERE u.user_id=t.assignee_id)
   AND EXISTS(SELECT 1 FROM bitrix_user_links u WHERE u.user_id=t.creator_id)
   ORDER BY t.created_at,t.id LIMIT 1`)).rows[0];
  if(!task)return false;
  const people=(await pool.query('SELECT user_id,external_id FROM bitrix_user_links WHERE user_id=ANY($1)',[[task.assignee_id,task.creator_id]])).rows;
  const external=(id:string)=>String(people.find(p=>p.user_id===id)!.external_id);
  let custom:Record<string,unknown>;
  try{custom=await customCreationFields(task);}catch(e){
   await pool.query("UPDATE task_sync_queue SET state='failed',retry_at=now()+interval '1 minute',last_error=$2 WHERE task_id=$1 AND payload->>'kind'='created' AND state IN ('pending','failed')",[task.id,e instanceof BitrixError?e.message:'Ошибка сопоставления полей новой задачи.']);
   return true;
  }
  const operationKey=randomUUID();
  // Commit intent BEFORE the external side effect. A crash after this point requires confirmation.
  intent=(await pool.query(`INSERT INTO bitrix_task_creations(task_id,operation_key,snapshot,state)
   VALUES($1,$2,$3,'uncertain') RETURNING *`,[task.id,operationKey,JSON.stringify(task)])).rows[0];
  await pool.query("UPDATE task_sync_queue SET attempts=attempts+1 WHERE task_id=$1 AND task_version<=$2 AND state IN ('pending','failed')",[task.id,task.version]);
  const fields:Record<string,unknown>={...custom,TITLE:task.title,DESCRIPTION:task.description,DEADLINE:task.deadline??'',
   RESPONSIBLE_ID:external(task.assignee_id),CREATED_BY:external(task.creator_id),
   STATUS:{active:2,review:4,completed:5}[task.status],TASK_CONTROL:'Y',XML_ID:'ruspet:'+operationKey,PRIORITY:task.priority==='high'?2:1};
  if(task.planned_start||task.planned_end){fields.START_DATE_PLAN=task.planned_start??'';fields.END_DATE_PLAN=task.planned_end??'';}
  for(const map of (await pool.query('SELECT * FROM bitrix_field_map')).rows){
   const value=task[map.local_key as 'price'|'important'|'customer_risk'];
   fields[map.external_code]=map.local_key==='price'?parsePrice(value)??'':value==null?'':value?'1':'0';
  }
  try{
   const result=await request<{task:{id:unknown}}>('tasks.task.add',{fields});
   const id=bitrixId(result?.task?.id);
   if(!id)throw new BitrixError('Создание не подтверждено ID. Проверьте портал перед повтором.');
   intent=(await pool.query("UPDATE bitrix_task_creations SET external_id=$2,state='confirming' WHERE task_id=$1 RETURNING *",[task.id,id])).rows[0];
  }catch{
   await pool.query('UPDATE bitrix_task_creations SET last_error=$2 WHERE task_id=$1',[task.id,'Не подтверждено создание. Автоповтор заблокирован; проверьте XML_ID ruspet:'+operationKey+' в Битрикс24.']);
   return true;
  }
 }
 try{
  const remote=await getRemote(request,String(intent.external_id));
  const created=intent.snapshot as Task;
  const values=await remoteValues(remote,pool,created);
  if(created.custom_fields?.length&&!values.custom_fields)throw new BitrixError('Дополнительные поля созданной задачи не подтверждены чтением.');
  const baseline=localValues(created,values);
  if(planFields(baseline,baseline,values).inbound.length>0)throw new BitrixError('Созданная задача отличается от отправленной. Нужна сверка.');
  await transaction(async db=>{
   await db.query('INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version) VALUES($1,$2,$3,$4)',[created.id,remote.id,JSON.stringify(baseline),created.version]);
   await db.query("UPDATE task_sync_queue SET state='sent',retry_at=NULL WHERE task_id=$1 AND task_version<=$2 AND state IN ('pending','failed')",[created.id,created.version]);
   await db.query("UPDATE bitrix_task_creations SET state='linked',last_error=NULL,retry_at=NULL WHERE task_id=$1",[created.id]);
   await db.query("UPDATE bitrix_event_queue SET blocked=false,processed_at=NULL,available_at=now(),last_error=NULL WHERE external_id=$1 AND event<>'ONTASKDELETE'",[remote.id]);
  });
 }catch(e){
  await pool.query("UPDATE bitrix_task_creations SET retry_at=now()+interval '1 minute',last_error=$2 WHERE task_id=$1",[intent.task_id,e instanceof BitrixError?e.message:'Ошибка проверки созданной задачи.']);
 }
 return true;
}
