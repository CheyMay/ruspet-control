import {pool,type Db} from './db.js';
import {assert,canSee} from './domain.js';
import type {Task,User} from '../shared/types.js';

export async function taskGroups(actor:User){
 const groups=(await pool.query<{id:string;name:string}>('SELECT id,name FROM task_groups WHERE user_id=$1 ORDER BY name,id',[actor.id])).rows;
 const items=(await pool.query<Task&{group_id:string}>(`SELECT t.*,i.group_id FROM task_group_items i
  JOIN tasks t ON t.id=i.task_id WHERE i.user_id=$1 AND (t.assignee_id=$1 OR t.creator_id=$1)`,[actor.id])).rows;
 const companyGroups=(await pool.query<{id:string;name:string}>('SELECT id,name FROM company_task_epics ORDER BY name,id')).rows;
 const companyItems=(await pool.query<Task&{epic_id:string}>(`SELECT t.*,i.epic_id FROM company_task_epic_items i JOIN tasks t ON t.id=i.task_id`)).rows;
 return {groups,items:Object.fromEntries(items.filter(task=>canSee(actor,task)).map(row=>[row.id,row.group_id])),
  companyGroups,companyItems:Object.fromEntries(companyItems.filter(task=>canSee(actor,task)).map(row=>[row.id,row.epic_id]))};
}
export async function createTaskGroup(actor:User,name:string,company=false){
 const key=name.normalize('NFC').toLocaleLowerCase('ru-RU');
 if(company){
  assert(actor.role==='admin',403,'Общие эпики создаёт администратор.');
  return (await pool.query<{id:string;name:string}>(`INSERT INTO company_task_epics(created_by,name,name_key)
   VALUES($1,$2,$3) ON CONFLICT(name_key) DO UPDATE SET name=company_task_epics.name RETURNING id,name`,[actor.id,name,key])).rows[0];
 }
 const row=(await pool.query<{id:string;name:string}>(`INSERT INTO task_groups(user_id,name,name_key) VALUES($1,$2,$3)
  ON CONFLICT(user_id,name_key) DO UPDATE SET name=task_groups.name RETURNING id,name`,[actor.id,name,key])).rows[0];
 return row;
}

export async function groupCompanyTask(actor:User,id:string,epicId:string|null,db:Db=pool,knownTask?:Task){
 const task=knownTask??(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 assert(task&&canSee(actor,task),404,'Задача недоступна.');
 assert(actor.role==='admin'||task.creator_id===actor.id,403,'Общий эпик задачи указывает постановщик или администратор.');
 if(!epicId)await db.query('DELETE FROM company_task_epic_items WHERE task_id=$1',[id]);
 else {
  const result=await db.query(`INSERT INTO company_task_epic_items(task_id,epic_id)
   SELECT $1,id FROM company_task_epics WHERE id=$2 ON CONFLICT(task_id) DO UPDATE SET epic_id=excluded.epic_id`,[id,epicId]);
  assert(result.rowCount,404,'Эпик недоступен.');
 }
 return {ok:true};
}
export async function groupTask(actor:User,id:string,groupId:string|null,db:Db=pool,knownTask?:Task){
 const task=knownTask??(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
 assert(task&&canSee(actor,task)&&(task.creator_id===actor.id||task.assignee_id===actor.id),404,'В подборку можно добавить свою задачу.');
 if(!groupId){
  await db.query('DELETE FROM task_group_items WHERE user_id=$1 AND task_id=$2',[actor.id,id]);
 }else{
  const result=await db.query(`INSERT INTO task_group_items(user_id,task_id,group_id)
   SELECT $1,$2,id FROM task_groups WHERE user_id=$1 AND id=$3
   ON CONFLICT(user_id,task_id) DO UPDATE SET group_id=excluded.group_id`,[actor.id,id,groupId]);
  assert(result.rowCount,404,'Подборка недоступна.');
 }
 return {ok:true};
}
