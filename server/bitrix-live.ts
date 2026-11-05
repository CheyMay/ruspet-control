import {delegatedTaskAccepted} from './delegation-review.js';
import {lockDelegationChain,requireAcceptedDelegations} from './delegation-lock.js';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {pool,transaction,type Db} from './db.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {fieldValue,fullSelection} from './bitrix-fields.js';
import {bitrixId,remoteTask} from './bitrix-sync.js';
import {parsePrice,taskPrice} from '../shared/pricing.js';
import {MockTaskProvider} from './providers.js';
import {assert} from './domain.js';
import type {Task} from '../shared/types.js';

type Values={title:string;description:string;deadline:string|null;assignee_id:string;creator_id:string;price:number;status:Task['status']};
type Config={enabled:boolean;group_id:string;price_field:string};
const changeFields=['title','description','deadline','assignee_id','price','status'] as const;
const same=(a:unknown,b:unknown)=>equal(a??null,b??null);
const localValues=(task:Task):Values=>({...task,price:taskPrice(task)!});
export async function configureLive(groupId:string,priceField:string){
 assert(bitrixId(groupId)&&/^UF_[A-Z0-9_]+$/.test(priceField),400,'Укажите ID проекта и точный код поля цены UF_….');
 const field=(await pool.query('SELECT description FROM bitrix_field_catalog WHERE code=$1',[priceField])).rows[0];
 assert(field,400,'Сначала прочитайте справочник полей; поле цены не найдено.');
 assert(['integer','double','money','string'].includes(field.description.type),400,'Для цены нужно числовое поле или проверяемое числовое значение.');
 assert(!(await pool.query('SELECT 1 FROM bitrix_task_links WHERE live_enabled')).rowCount,409,'Настройки полей и проекта нельзя менять при активированных задачах.');
 await pool.query('UPDATE bitrix_live_config SET group_id=$1,price_field=$2,updated_at=now() WHERE id=1',[groupId,priceField]);
}
async function config():Promise<Config>{
 const cfg=(await pool.query('SELECT * FROM bitrix_live_config WHERE id=1')).rows[0];
 assert(cfg.group_id&&cfg.price_field,409,'Не настроены проект и поле цены пилота.');return cfg;
}
export async function readLiveTask(request:BitrixRequest,externalId:string){
 const response=await request<{task:Record<string,unknown>}>('tasks.task.get',{taskId:externalId,select:await fullSelection()});
 const raw=response.task,normalized=remoteTask(raw||{});
 assert(normalized.id===externalId,409,'Битрикс24 вернул другой ID задачи.');
 await pool.query(`INSERT INTO bitrix_task_snapshots(external_id,snapshot,raw) VALUES($1,$2,$3)
 ON CONFLICT(external_id) DO UPDATE SET snapshot=excluded.snapshot,raw=excluded.raw,fetched_at=now()`,[externalId,JSON.stringify(normalized),JSON.stringify(raw)]);
 return raw;
}
async function remoteValues(raw:Record<string,unknown>,cfg:Config):Promise<Values>{
 assert(String(fieldValue(raw,'GROUP_ID'))===String(cfg.group_id),409,'Задача находится вне выбранного проекта пилота.');
 const status=String(fieldValue(raw,'STATUS')),state=({2:'active',3:'active',4:'review',5:'completed'} as const)[status as '2'];
 assert(state,409,'Этот статус Битрикс24 ещё не поддержан в пилоте: '+status);
 const priceRaw=fieldValue(raw,cfg.price_field),amount=typeof priceRaw==='string'&&priceRaw.includes('|')?priceRaw.split('|'):null;
 assert(!Array.isArray(priceRaw),409,'Множественное поле цены требует отдельного сопоставления.');
 assert(!amount||amount.length===2&&amount[1]==='RUB',409,'Цена задачи должна быть в рублях.');
 const price=parsePrice(amount?amount[0]:priceRaw);assert(price!==null,409,'В Битрикс24 отсутствует корректная обязательная цена задачи.');
 const assignee=String(fieldValue(raw,'RESPONSIBLE_ID')),creator=String(fieldValue(raw,'CREATED_BY'));
 const people=(await pool.query('SELECT user_id,external_id FROM bitrix_user_links WHERE external_id=ANY($1::bigint[])',[[assignee,creator].filter(id=>bitrixId(id))])).rows;
 const owner=people.find(p=>String(p.external_id)===assignee),author=people.find(p=>String(p.external_id)===creator);
 assert(owner&&author,409,'Не сопоставлен исполнитель или постановщик с пользователем Битрикс24.');
 const participants=(await pool.query('SELECT user_id FROM bitrix_pilot_members WHERE user_id=ANY($1)',[[owner.user_id,author.user_id]])).rows;
 assert(new Set(participants.map(p=>p.user_id)).size===new Set([owner.user_id,author.user_id]).size,409,'Исполнитель или постановщик находятся вне состава пилота.');
 const task=remoteTask(raw);
 return {title:task.title,description:task.description,deadline:task.deadline,price,assignee_id:owner.user_id,creator_id:author.user_id,status:state};
}
async function applyInbound(db:Db,task:Task,next:Values,raw:Record<string,unknown>,initial=false){
 if(next.status!==task.status&&next.status!=='active')await requireAcceptedDelegations(db,task.id);
 const owner=(await db.query('SELECT branch_id FROM users WHERE id=$1',[next.assignee_id])).rows[0];
 const changed:string[]=[...changeFields,'creator_id' as const].filter(k=>!same(localValues(task)[k],next[k]));
 if(owner.branch_id!==task.branch_id)changed.push('branch_id');if(!changed.length)return;
 const closed=fieldValue(raw,'CLOSED_DATE');
 const updated=(await db.query<Task>(`UPDATE tasks SET title=$2,description=$3,deadline=$4,assignee_id=$5,price=$6,status=$7,
 creator_id=$8,code=$9,branch_id=$10,version=version+1,updated_at=now(),
 transfer_count=transfer_count+CASE WHEN NOT $13 AND deadline IS DISTINCT FROM $4::timestamptz THEN 1 ELSE 0 END,
 completed_at=CASE WHEN $7='completed' THEN $11::timestamptz ELSE NULL END,source_status=$12 WHERE id=$1 RETURNING *`,
 [task.id,next.title,next.description,next.deadline,next.assignee_id,next.price,next.status,next.creator_id,next.title.split(/\s/)[0],owner.branch_id,typeof closed==='string'&&Number.isFinite(Date.parse(closed))?closed:null,String(fieldValue(raw,'STATUS')),initial])).rows[0];
 await new MockTaskProvider().applyApprovedChange(db,updated,task.version);
 await db.query("UPDATE approvals SET state='stale' WHERE task_id=$1 AND state='pending'",[task.id]);
 if(next.status==='completed'||task.assignee_id!==next.assignee_id)await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[task.id]);
 await db.query("INSERT INTO task_events(id,task_id,kind,message,data) VALUES($1,$2,'bitrix_change','Обновлены поля из Битрикс24',$3)",[randomUUID(),task.id,JSON.stringify({before:task,after:updated,fields:changed})]);
 if(!initial&&task.status!==updated.status){
  if(updated.status==='completed'){
   await db.query("UPDATE task_submissions SET state='accepted',remark='Приёмка зафиксирована в Битрикс24',decided_at=now() WHERE task_id=$1 AND state='review' AND withdrawn_at IS NULL",[task.id]);
   await delegatedTaskAccepted(db,task.id);
  }else if(updated.status==='active')await db.query("UPDATE task_submissions SET state='returned',remark='Возврат зафиксирован в Битрикс24',decided_at=now() WHERE task_id=$1 AND state='review' AND withdrawn_at IS NULL",[task.id]);
 }
 const {refreshTaskFindings}=await import('./service.js');const actor=(await db.query('SELECT * FROM users WHERE id=$1',[next.creator_id])).rows[0];await refreshTaskFindings(db,updated,actor);
}
export async function activateLiveTask(request:BitrixRequest,id:string,acceptBitrix=false){
 const cfg=await config(),link=(await pool.query('SELECT * FROM bitrix_task_links WHERE task_id=$1',[id])).rows[0];assert(link,404,'Сначала свяжите локальную задачу с ID Битрикс24.');
 assert(!link.live_enabled,409,'Задача уже включена в пилот. Повторная активация не сбрасывает очередь.');
 const raw=await readLiveTask(request,String(link.external_id)),remote=await remoteValues(raw,cfg);
 assert(['Y',true].includes(fieldValue(raw,'TASK_CONTROL') as 'Y'),409,'Для пилота включите контроль после завершения задачи в Битрикс24.');
 return transaction(async db=>{
  await lockDelegationChain(db,id);
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const members=(await db.query('SELECT user_id FROM bitrix_pilot_members WHERE user_id=ANY($1)',[[remote.assignee_id,remote.creator_id]])).rows;
  assert(new Set(members.map(p=>p.user_id)).size===new Set([remote.assignee_id,remote.creator_id]).size,409,'Исполнитель и постановщик должны быть в подтверждённом составе пилота.');
  const differences:string[]=[...changeFields,'creator_id' as const].filter(k=>!same(localValues(task)[k],remote[k]));
  const owner=(await db.query('SELECT branch_id FROM users WHERE id=$1',[remote.assignee_id])).rows[0];if(owner.branch_id!==task.branch_id)differences.push('branch_id');
  if(differences.length&&!acceptBitrix)return {activated:false,differences};
  assert(!(await db.query("SELECT 1 FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rowCount,409,'Перед активацией завершите текущие локальные согласования.');
  if(differences.length)await applyInbound(db,task,remote,raw,true);
  const result=await db.query('UPDATE bitrix_task_links SET live_enabled=true,live_baseline=$2,checked_at=now(),conflict=NULL WHERE task_id=$1 AND NOT live_enabled',[id,JSON.stringify(remote)]);assert(result.rowCount,409,'Задача уже активирована другим процессом.');
  return {activated:true,differences};
 });
}
export async function deactivateLiveTask(id:string){return transaction(async db=>{
 await lockDelegationChain(db,id);
 assert(!(await db.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0].enabled,409,'Сначала приостановите пилот.');
 assert(!(await db.query("SELECT 1 FROM bitrix_operations WHERE task_id=$1 AND state NOT IN ('sent','canceled')",[id])).rowCount,409,'Сначала завершите или сверьте очередь задачи.');
 const result=await db.query('UPDATE bitrix_task_links SET live_enabled=false WHERE task_id=$1 AND live_enabled',[id]);assert(result.rowCount,404,'Активная связь не найдена.');return {deactivated:true};
});}
export async function enqueueBitrixOperation(db:Db,eventId:string,taskId:string,kind:string,message:string,data:Record<string,unknown>,actorId:string|null){
 const supported=['task_edited','review_submitted','review_returned','task_completed','deadline_changed','action_undone','comment','explanation','approval_requested','approval_rejected','approval_later','approval_clarification_requested','approval_clarification_answered','step_approved'];
 if(!supported.includes(kind))return;
 const linked=(await db.query('SELECT 1 FROM bitrix_task_links WHERE task_id=$1 AND live_enabled',[taskId])).rowCount;if(!linked)return;
 const after=data.after as Task|undefined;
 if(after){const people=(await db.query('SELECT user_id FROM bitrix_pilot_members WHERE user_id=ANY($1)',[[after.assignee_id,after.creator_id]])).rows;assert(new Set(people.map(p=>p.user_id)).size===new Set([after.assignee_id,after.creator_id]).size,409,'Для связанной задачи выбирайте исполнителя и постановщика из участников пилота.');}
 await db.query(`INSERT INTO bitrix_operations(event_id,task_id,payload) SELECT $1,$2,$3 FROM bitrix_task_links WHERE task_id=$2 AND live_enabled`,[eventId,taskId,JSON.stringify({kind,message,data,actorId})]);
}
async function outboundFields(before:Task,after:Task,raw:Record<string,unknown>,cfg:Config){
 const remote=await remoteValues(raw,cfg),old=localValues(before),next=localValues(after),changed=changeFields.filter(k=>!same(old[k],next[k]));
 const conflicts=changed.filter(k=>!same(remote[k],old[k])&&!same(remote[k],next[k]));
 assert(!conflicts.length,409,'Одновременно изменены поля: '+conflicts.join(', '));
 assert(next.creator_id===old.creator_id,409,'Смена постановщика не поддержана пилотом.');
 assert(remote.creator_id===old.creator_id,409,'Постановщик изменился в Битрикс24. Сначала сверьте права.');
 const fields:Record<string,unknown>={};
 for(const key of changed){
  if(key==='status'||same(remote[key],next[key]))continue;
  if(key==='assignee_id'){
   const person=(await pool.query('SELECT external_id FROM bitrix_user_links WHERE user_id=$1',[next.assignee_id])).rows[0];assert(person,409,'Новый исполнитель не сопоставлен с Битрикс24.');fields.RESPONSIBLE_ID=String(person.external_id);
  }else if(key==='price'){
   assert(next.price!==null,409,'Цена обязательна.');const type=(await pool.query('SELECT description FROM bitrix_field_catalog WHERE code=$1',[cfg.price_field])).rows[0]?.description.type;
   fields[cfg.price_field]=type==='money'?`${next.price}|RUB`:next.price;
  }else fields[key.toUpperCase()]=next[key];
 }
 return {fields,remote,next,changed};
}
async function changeStatus(request:BitrixRequest,externalId:string,raw:Record<string,unknown>,desired:Task['status'],write:(method:Parameters<BitrixRequest>[0],body:object)=>Promise<unknown>){
 let status=String(fieldValue(raw,'STATUS'));
 if(desired==='active'){
  if(status==='4')await write('tasks.task.disapprove',{taskId:externalId});
  else if(status==='5')await write('tasks.task.renew',{taskId:externalId});
 }else if(desired==='review'&&status!=='4'){
  assert(status!=='5'&&['Y',true].includes(fieldValue(raw,'TASK_CONTROL') as 'Y'),409,'Сдача на приёмку требует активной задачи с включённым контролем в Битрикс24.');
  await write('tasks.task.complete',{taskId:externalId});
 }else if(desired==='completed'&&status!=='5'){
  if(status!=='4'){await write('tasks.task.complete',{taskId:externalId});raw=await readLiveTask(request,externalId);status=String(fieldValue(raw,'STATUS'));}
  if(status==='4')await write('tasks.task.approve',{taskId:externalId});
 }
}
function operationComment(op:any,actorName:string){
 const data=op.payload.data||{},parts=[op.payload.message];
 const labels={body:'Комментарий',comment:'Решение / замечание',reason:'Причина',progress:'Сделано',plan:'План',answer:'Ответ',question:'Уточнение',newDeadline:'Новый срок'};
 for(const [key,label] of Object.entries(labels))if(typeof data[key]==='string'&&data[key].trim())parts.push(label+': '+data[key]);
 return `РУСПЭТ · ${actorName}\n${parts.join('\n')}\n[ruspet:${op.event_id}]`;
}
export async function tickLiveSync(request:BitrixRequest){
 const lock=await pool.connect();let acquired=false;
 try{
  acquired=(await lock.query('SELECT pg_try_advisory_lock(431025) ok')).rows[0].ok;if(!acquired)return {sent:0,paused:true};
  const cfg=await config();if(!cfg.enabled||process.env.BITRIX_WRITE_ENABLED!=='true')return {sent:0,paused:true};
  // A previous process may have died after the portal accepted a request.
  await pool.query("UPDATE bitrix_operations SET state='uncertain',error='Обработчик прерван. Требуется сверка с Битрикс24.' WHERE state='processing'");
  let sent=0;
  const links=(await pool.query(`SELECT l.* FROM bitrix_task_links l LEFT JOIN LATERAL
   (SELECT state,retry_at FROM bitrix_operations WHERE task_id=l.task_id AND state NOT IN ('sent','canceled') ORDER BY sequence LIMIT 1) q ON true
   WHERE l.live_enabled ORDER BY coalesce(q.state IN ('pending','failed') AND (q.retry_at IS NULL OR q.retry_at<=now()),false) DESC,l.live_polled_at NULLS FIRST,l.task_id LIMIT 20`)).rows;
  for(const link of links){
   const id=link.task_id,externalId=String(link.external_id);
   await pool.query('UPDATE bitrix_task_links SET live_polled_at=now() WHERE task_id=$1',[id]);
   const op=await transaction(async db=>{
    await lockDelegationChain(db,id);
    const candidate=(await db.query("SELECT * FROM bitrix_operations WHERE task_id=$1 AND state NOT IN ('sent','canceled') ORDER BY sequence LIMIT 1 FOR UPDATE",[id])).rows[0];
    if(!candidate||!['pending','failed'].includes(candidate.state)||candidate.retry_at&&Date.parse(candidate.retry_at)>Date.now())return candidate?{...candidate,skip:true}:null;
    await db.query("UPDATE bitrix_operations SET state='processing',phase='reading',attempts=attempts+1 WHERE event_id=$1",[candidate.event_id]);return candidate;
   });
   if(op?.skip)continue;
   let writing=false;
   try{
    let raw=await readLiveTask(request,externalId),remote=await remoteValues(raw,cfg);
    if(!op){
     await transaction(async db=>{
      await lockDelegationChain(db,id);
      const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if((await db.query("SELECT 1 FROM bitrix_operations WHERE task_id=$1 AND state NOT IN ('sent','canceled')",[id])).rowCount)return;
      const changed=changeFields.filter(k=>!same(localValues(task)[k],link.live_baseline?.[k]));assert(!changed.length,409,'Локальные поля изменены вне подтверждённой очереди: '+changed.join(', '));
      assert(task.creator_id===remote.creator_id,409,'Постановщик изменился в Битрикс24. Требуется сверка прав.');
      await applyInbound(db,task,remote,raw);await db.query('UPDATE bitrix_task_links SET live_baseline=$2,checked_at=now(),conflict=NULL WHERE task_id=$1',[id,JSON.stringify(remote)]);
     });continue;
    }
    const write=async(method:Parameters<BitrixRequest>[0],body:object)=>{
     if(!(await pool.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0].enabled)throw new BitrixError('Запись приостановлена администратором.');
     await pool.query('UPDATE bitrix_operations SET phase=$2 WHERE event_id=$1',[op.event_id,method]);writing=true;
     return request(method,body);
    };
    const data=op.payload.data||{},before=data.before as Task|undefined,after=data.after as Task|undefined;
    if(after){
     assert(before,409,'У операции нет исходного состояния для безопасной сверки.');
     const plan=await outboundFields(before,after,raw,cfg);
     if(Object.keys(plan.fields).length)await write('tasks.task.update',{taskId:externalId,fields:plan.fields});
     if(plan.changed.includes('status'))await changeStatus(request,externalId,raw,after.status,write);
     raw=await readLiveTask(request,externalId);remote=await remoteValues(raw,cfg);
     assert(plan.changed.every(k=>same(remote[k],plan.next[k])),409,'Контрольное чтение не подтвердило изменения задачи.');
    }
    const actor=(await pool.query('SELECT name FROM users WHERE id=$1',[op.payload.actorId])).rows[0];
    const text=operationComment(op,actor?.name||'Система');
    const ack=process.env.BITRIX_LEGACY_COMMENTS==='true'?
     await write('task.commentitem.add',{TASKID:externalId,FIELDS:{POST_MESSAGE:text}}):
     await write('tasks.task.chat.message.send',{fields:{taskId:externalId,text}});
    assert((typeof ack==='number'||typeof ack==='string')&&!!bitrixId(ack)||typeof ack==='object'&&ack!==null&&(ack as any).result===true,502,'Отправка комментария не подтверждена.');
    await transaction(async db=>{
     await lockDelegationChain(db,id);
     const current=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
     assert(current.creator_id===remote.creator_id,409,'Постановщик изменился во время отправки. Требуется сверка.');
     await db.query("UPDATE bitrix_operations SET state='sent',phase='done',error=NULL,finished_at=now() WHERE event_id=$1",[op.event_id]);
     if(!(await db.query("SELECT 1 FROM bitrix_operations WHERE task_id=$1 AND state NOT IN ('sent','canceled')",[id])).rowCount)await applyInbound(db,current,remote,raw);
     await db.query('UPDATE bitrix_task_links SET live_baseline=$2,checked_at=now(),conflict=NULL WHERE task_id=$1',[id,JSON.stringify(remote)]);
     if(after)await db.query("UPDATE task_sync_queue SET state='sent',attempts=attempts+1,retry_at=NULL WHERE task_id=$1 AND task_version=$2 AND state IN ('pending','failed')",[id,after.version]);
    });sent++;
   }catch(error){
    const message=error instanceof BitrixError||error instanceof Error&&'status' in error?error.message:'Не удалось сверить задачу с Битрикс24.';
    if(op){
     const uncertain=writing&&(!(error instanceof BitrixError)||error.disposition==='uncertain');
     const state=uncertain?'uncertain':error instanceof Error&&'status' in error?'blocked':'failed';
     await pool.query('UPDATE bitrix_operations SET state=$2,error=$3,retry_at=$4 WHERE event_id=$1',[op.event_id,state,message,new Date(Date.now()+Math.min(3600000,30000*2**Math.min(op.attempts,7))).toISOString()]);
    }
    await pool.query('UPDATE bitrix_task_links SET conflict=$2,checked_at=now() WHERE task_id=$1',[id,message]);
   }
  }
  return {sent,paused:false};
 }finally{if(acquired)await lock.query('SELECT pg_advisory_unlock(431025)');lock.release();}
}

/** Retrying an uncertain comment is forbidden without positive portal evidence. */
export async function recoverOperation(request:BitrixRequest,id:string,mode:'retry'|'verify'){
 const op=(await pool.query('SELECT o.*,l.external_id FROM bitrix_operations o JOIN bitrix_task_links l USING(task_id) WHERE event_id=$1',[id])).rows[0];assert(op,404,'Операция не найдена.');
 if(mode==='retry'){
  assert(['failed','blocked'].includes(op.state),409,'Повтор неизвестного результата запрещён: используйте verify после сверки.');
  const result=await pool.query("UPDATE bitrix_operations SET state='pending',retry_at=NULL,error=NULL WHERE event_id=$1 AND state IN ('failed','blocked')",[id]);assert(result.rowCount,409,'Операция уже изменилась.');return {state:'pending'};
 }
 assert(op.state==='uncertain',409,'Сверка требуется операции с неизвестным результатом.');
 const cfg=await config(),raw=await readLiveTask(request,String(op.external_id)),remote=await remoteValues(raw,cfg),before=op.payload.data.before as Task|undefined,after=op.payload.data.after as Task|undefined;
 if(op.phase!=='reading'&&after){const changed=changeFields.filter(k=>!same(localValues(before!)[k],localValues(after)[k]));assert(changed.every(k=>same(remote[k],localValues(after)[k])),409,'Битрикс24 пока не подтверждает все поля операции. Сверьте её вручную.');}
 const commentPhase=['tasks.task.chat.message.send','task.commentitem.add'].includes(op.phase);
 if(commentPhase){
  const {syncActivity}=await import('./bitrix-sync.js');await syncActivity(request,op.task_id);
  const found=(await pool.query("SELECT 1 FROM bitrix_task_activity WHERE task_id=$1 AND kind='comment' AND position($2 in body)>0",[op.task_id,`[ruspet:${op.event_id}]`])).rowCount;
  assert(found,409,'Комментарий с маркером операции не найден в загруженном обсуждении. Автоповтор запрещён. Проверьте чат и при необходимости загрузите старшие страницы.');
 }
 await transaction(async db=>{
  await lockDelegationChain(db,op.task_id);
  const result=await db.query("UPDATE bitrix_operations SET state=$2,error=NULL,retry_at=NULL,finished_at=CASE WHEN $2='sent' THEN now() ELSE NULL END WHERE event_id=$1 AND state='uncertain'",[id,commentPhase?'sent':'pending']);assert(result.rowCount,409,'Операция уже изменена.');
  if(commentPhase){
   const current=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[op.task_id])).rows[0];assert(current.creator_id===remote.creator_id,409,'Постановщик изменился. Требуется сверка.');
   if(!(await db.query("SELECT 1 FROM bitrix_operations WHERE task_id=$1 AND state NOT IN ('sent','canceled')",[op.task_id])).rowCount)await applyInbound(db,current,remote,raw);
   await db.query('UPDATE bitrix_task_links SET live_baseline=$2,conflict=NULL,checked_at=now() WHERE task_id=$1',[op.task_id,JSON.stringify(remote)]);if(after)await db.query("UPDATE task_sync_queue SET state='sent',attempts=attempts+1,retry_at=NULL WHERE task_id=$1 AND task_version=$2",[op.task_id,after.version]);
  }
 });
 return {state:commentPhase?'sent':'pending'};
}
