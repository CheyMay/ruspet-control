import {pool,transaction,type Db} from './db.js';
import {assert} from './domain.js';
import {event} from './service.js';
import type {User} from '../shared/types.js';

export async function staffWorkIds(db:Db){
 return (await db.query<{ids:string[]|null}>('SELECT staff_work_ids() AS ids')).rows[0].ids;
}
export async function staffRolloutStatus(actor:User){
 assert(actor.role==='admin',403,'Подключение сотрудников видит администратор.');
 const settings=(await pool.query<{enabled:boolean}>('SELECT enabled FROM staff_rollout')).rows[0];
 const missing=(await pool.query(`SELECT s.id,s.name,s.organisation,s.department FROM staff_directory s
  WHERE s.enabled AND s.user_id IS NULL AND staff_normalized_label(s.department) IN
  ('преформа','aquas','продажи','аналитики','бизнес-аналитика','аналитика','! рук филиала') ORDER BY s.name`)).rows;
 return {enabled:settings.enabled,missing};
}

async function removeOpenChecks(db:Db,ids:string[]){
 if(!ids.length)return;
 await db.query(`UPDATE outbox o SET withdrawn_at=now() FROM control_requests c
  WHERE c.assignee_id=ANY($1) AND c.state IN ('waiting','escalated')
   AND o.withdrawn_at IS NULL AND (o.dedupe_key='control:'||c.id OR o.dedupe_key LIKE 'remind:'||c.id||':%')`,[ids]);
 await db.query("UPDATE control_requests SET state='resolved' WHERE assignee_id=ANY($1) AND state IN ('waiting','escalated')",[ids]);
 await db.query("UPDATE findings f SET status='resolved' FROM tasks t WHERE t.id=f.task_id AND t.assignee_id=ANY($1) AND f.status='open'",[ids]);
}

export async function setStaffRollout(actor:User,enabled:boolean){
 assert(actor.role==='admin'&&actor.root_access,403,'Общий запуск меняет владелец.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431002)');
  const previous=await staffWorkIds(db);
  const updated=await db.query('UPDATE staff_rollout SET enabled=$1 WHERE id=1 AND enabled<>$1',[enabled]);
  const ids=await staffWorkIds(db);
  if(updated.rowCount){
   if(ids){
    const excluded=previous??(await db.query<{id:string}>('SELECT id FROM users')).rows.map(person=>person.id);
    await removeOpenChecks(db,excluded.filter(id=>!ids.includes(id)));
   }
   await event(db,null,actor.id,'staff_rollout_changed','Изменён охват рабочей группы',{enabled,count:ids?.length??null});
  }
  return {enabled,count:ids?.length??null};
 });
}

export async function setStaffWorkOverride(actor:User,id:string,enabled:boolean|null){
 assert(actor.role==='admin',403,'Участие меняет администратор.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431002)');
  const person=(await db.query('SELECT user_id,work_control_override FROM staff_work_groups WHERE user_id=$1',[id])).rows[0];
  assert(person,404,'Рабочий профиль сотрудника не найден.');
  if(person.work_control_override!==enabled){
   const previous=await staffWorkIds(db);
   await db.query('UPDATE users SET work_control_override=$2,version=version+1 WHERE id=$1',[id,enabled]);
   const next=await staffWorkIds(db);
   if((!previous||previous.includes(id))&&next&&!next.includes(id))await removeOpenChecks(db,[id]);
   await event(db,null,actor.id,'staff_work_scope_changed','Изменено участие сотрудника в контроле сроков',
    {userId:id,previous:person.work_control_override,enabled});
  }
  return {ok:true};
 });
}
