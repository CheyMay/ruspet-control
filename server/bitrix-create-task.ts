import {pool,transaction,type Db} from './db.js';
import {assert,AppError} from './domain.js';
import {lockDelegationChain} from './delegation-lock.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {bitrixId,remoteTask,stage} from './bitrix-sync.js';
import {fieldValue,fullSelection} from './bitrix-fields.js';
import {queueRefresh} from './bitrix-events.js';
import {ruspetTaskReference,withRuspetTaskReference} from './bitrix-task-reference.js';
import {taskPrice} from '../shared/pricing.js';
import type {Task} from '../shared/types.js';

type Creation={event_id:string;task_id:string;payload:{data:{after:Task}};created_external_id:string|null;attempts:number;state:string};
type Configuration={price_field:string|null};
const transientCodes=['QUERY_LIMIT_EXCEEDED','OPERATION_TIME_LIMIT','OVERLOAD_LIMIT'];

async function createFields(task:Task,cfg:Configuration){
 const {rows}=await pool.query<{user_id:string;external_id:string}>('SELECT user_id,external_id::text FROM bitrix_user_links WHERE user_id=ANY($1)',
  [[task.creator_id,task.assignee_id]]);
 const creator=rows.find(row=>row.user_id===task.creator_id)?.external_id;
 const assignee=rows.find(row=>row.user_id===task.assignee_id)?.external_id;
 assert(creator&&assignee,409,'Для создания в Битрикс24 свяжите профили постановщика и исполнителя.');
 const fields:Record<string,unknown>={TITLE:task.title,DESCRIPTION:withRuspetTaskReference(task.description,task.id),
  CREATED_BY:creator,RESPONSIBLE_ID:assignee,TASK_CONTROL:creator===assignee?'N':'Y'};
 if(task.deadline)fields.DEADLINE=task.deadline;
 if(task.planned_start&&task.planned_end){fields.START_DATE_PLAN=task.planned_start;fields.END_DATE_PLAN=task.planned_end;}
 if(task.priority==='high')fields.PRIORITY='2';
 if(task.parent_id){
  const link=(await pool.query('SELECT external_id::text FROM bitrix_task_links WHERE task_id=$1',[task.parent_id])).rows[0];
  if(link)fields.PARENT_ID=link.external_id;
 }
 const price=taskPrice(task);
 if(cfg.price_field&&price!==null){
  const type=(await pool.query('SELECT description FROM bitrix_field_catalog WHERE code=$1',[cfg.price_field])).rows[0]?.description.type;
  fields[cfg.price_field]=type==='money'?price+'|RUB':price;
 }
 return {fields,creator,assignee};
}

function rememberCreatedId(op:Creation,externalId:string){
 return pool.query(`UPDATE bitrix_operations SET created_external_id=$2,phase='confirming'
  WHERE event_id=$1 AND state IN ('processing','uncertain')`,[op.event_id,externalId]);
}

async function finishCreation(db:Db,portal:string,op:Creation,raw:Record<string,unknown>){
 const original=op.payload.data.after,remote=remoteTask(raw);
 await lockDelegationChain(db,op.task_id);
 const current=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[op.task_id])).rows[0];
 assert(current,409,'Исходная задача РУСПЭТ недоступна.');
 await stage(remote,db,raw);
 const baseline={title:original.title,description:original.description,deadline:original.deadline,
  planned_start:original.planned_start??null,planned_end:original.planned_end,completed_at:original.completed_at,
  status:original.status,price:taskPrice(original),assignee_id:original.assignee_id,creator_id:original.creator_id};
 await db.query(`INSERT INTO bitrix_task_links(task_id,external_id,baseline,linked_version,checked_at)
  VALUES($1,$2,$3,$4,now()) ON CONFLICT(task_id) DO NOTHING`,[op.task_id,remote.id,JSON.stringify({...baseline,inbound:baseline}),original.version]);
 const link=(await db.query('SELECT external_id::text FROM bitrix_task_links WHERE task_id=$1',[op.task_id])).rows[0];
 assert(link.external_id===remote.id,409,'Задача уже связана с другим номером Битрикс24.');
 const saved=await db.query(`UPDATE bitrix_operations SET state='sent',created_external_id=$2,phase='done',
  finished_at=now(),error=NULL,retry_at=NULL WHERE event_id=$1 AND state IN ('processing','uncertain')`,[op.event_id,remote.id]);
 assert(saved.rowCount,409,'Состояние отправки уже изменилось.');
 await db.query(`UPDATE task_sync_queue SET state='sent',attempts=attempts+1,retry_at=NULL
  WHERE task_id=$1 AND task_version=$2 AND state IN ('pending','failed')`,[op.task_id,original.version]);
 await queueRefresh(db,portal,'task_inbound',remote.id);
 await queueRefresh(db,portal,'task_inbound_comments',remote.id);
}

async function confirmCreation(request:BitrixRequest,op:Creation,externalId:string,creator:string,assignee:string){
 assert(request.portal,409,'Для создания нужен настроенный портал Битрикс24.');
 const {task:raw}=await request<{task:Record<string,unknown>}>('tasks.task.get',{taskId:externalId,select:await fullSelection()});
 const remote=remoteTask(raw??{});
 assert(remote.id===externalId&&ruspetTaskReference(String(fieldValue(raw,'DESCRIPTION')))===op.task_id,
  409,'В Битрикс24 не найдено подтверждение связи с задачей РУСПЭТ.');
 assert(remote.createdBy===creator&&remote.responsibleId===assignee,409,'Битрикс24 указал другого постановщика или исполнителя. Проверьте назначение задачи.');
 await transaction(db=>finishCreation(db,request.portal!,op,raw));
}

export async function verifyBitrixCreation(request:BitrixRequest,op:Creation,cfg:Configuration){
 const {fields,creator,assignee}=await createFields(op.payload.data.after,cfg);
 let externalId=op.created_external_id;
 if(!externalId){
  const since=new Date(Date.parse(op.payload.data.after.created_at)-86400000).toISOString();
  const result=await request<{tasks:Record<string,unknown>[]}>('tasks.task.list',{
   filter:{TITLE:fields.TITLE,'>=CREATED_DATE':since},
   select:['ID','TITLE','DESCRIPTION'],order:{ID:'desc'},start:0
  });
  const matches=(result.tasks??[]).filter(raw=>ruspetTaskReference(String(fieldValue(raw,'DESCRIPTION')))===op.task_id);
  assert(matches.length===1,409,'Не удалось однозначно найти созданную задачу в Битрикс24. Повторная отправка заблокирована.');
  externalId=bitrixId(fieldValue(matches[0],'ID'));
  assert(externalId,409,'Битрикс24 не подтвердил номер созданной задачи.');
  await rememberCreatedId(op,externalId);
 }
 await confirmCreation(request,op,externalId,creator,assignee);
 return {state:'sent'};
}

// Runs under the live worker lock. An interrupted ADD may only be verified.
export async function tickBitrixCreations(request:BitrixRequest,cfg:Configuration,taskIds?:string[]){
 const {rows}=await pool.query<Creation>(`SELECT o.* FROM bitrix_operations o WHERE o.payload->>'kind'='created'
  AND (o.state IN ('pending','failed') AND (o.retry_at IS NULL OR o.retry_at<=now()) OR o.state='uncertain' AND o.retry_at<=now())
  AND ($1::text[] IS NULL OR o.task_id=ANY($1)) ORDER BY o.sequence LIMIT 5`,[taskIds??null]);
 let sent=0;
 for(const op of rows){
  let writing=false;
  try{
   if(op.state==='uncertain'){
    const claimed=await pool.query("UPDATE bitrix_operations SET retry_at=NULL WHERE event_id=$1 AND state='uncertain' AND retry_at IS NOT NULL",[op.event_id]);
    if(!claimed.rowCount)continue;
    await verifyBitrixCreation(request,op,cfg);
   }else{
    const claimed=await pool.query(`UPDATE bitrix_operations SET state='processing',phase='reading',attempts=attempts+1
     WHERE event_id=$1 AND state IN ('pending','failed') RETURNING event_id`,[op.event_id]);
    if(!claimed.rowCount)continue;
    const {fields,creator,assignee}=await createFields(op.payload.data.after,cfg);
    let externalId=op.created_external_id;
    if(!externalId){
     if((await pool.query('SELECT 1 FROM bitrix_task_links WHERE task_id=$1',[op.task_id])).rowCount){
      await pool.query("UPDATE bitrix_operations SET state='canceled',retry_at=NULL,error=NULL WHERE event_id=$1",[op.event_id]);
      continue;
     }
     assert(request.portal,409,'Для создания нужен настроенный портал Битрикс24.');
     const enabled=(await pool.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0]?.enabled;
     if(!enabled)throw new BitrixError('Обмен с Битрикс24 приостановлен.');
     await pool.query("UPDATE bitrix_operations SET phase='tasks.task.add' WHERE event_id=$1",[op.event_id]);
     writing=true;
     const result=await request<{task?:{id?:unknown}}>('tasks.task.add',{fields},undefined,{operationId:op.event_id});
     externalId=bitrixId(result?.task?.id);
     if(!externalId)throw new BitrixError('Битрикс24 не подтвердил номер новой задачи.','uncertain');
     await rememberCreatedId(op,externalId);
     op.created_external_id=externalId;
    }
    await confirmCreation(request,op,externalId,creator,assignee);
   }
   sent++;
  }catch(error){
   const rejected=error instanceof BitrixError&&error.disposition==='rejected';
   const quota=rejected&&transientCodes.includes(error.code??'');
   const uncertain=op.state==='uncertain'||writing&&!op.created_external_id&&!rejected;
   const state=uncertain?'uncertain':error instanceof AppError||writing&&rejected&&!quota?'blocked':'failed';
   const message=error instanceof BitrixError||error instanceof AppError?error.message:'Не удалось создать задачу в Битрикс24.';
   const retryAt=uncertain&&op.state==='uncertain'||state==='blocked'?null:
    new Date(Date.now()+Math.min(3600000,30000*2**Math.min(op.attempts,7))).toISOString();
   await pool.query(`UPDATE bitrix_operations SET state=$2,error=$3,retry_at=$4
    WHERE event_id=$1 AND state IN ('processing','uncertain')`,[op.event_id,state,message,retryAt]);
  }
 }
 return sent;
}
