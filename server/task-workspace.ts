import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {pool} from './db.js';
import {assert,globalAccess} from './domain.js';
import {getCompany} from './okb.js';
import {customFieldsInput,taskInput} from './task-input.js';
import {visibleTasksForCompany} from './service.js';
import type {User} from '../shared/types.js';

export async function companyWork(actor:User,id:string){
 await getCompany(actor,id);
 const tasks=await visibleTasksForCompany(actor,id);
 const history=(await pool.query(`SELECT id,task_id,actor_id,message,created_at FROM task_events WHERE task_id=ANY($1)
  AND NOT EXISTS(SELECT 1 FROM event_retractions WHERE event_id=task_events.id)
  ORDER BY created_at DESC,id DESC LIMIT 25`,[tasks.map(t=>t.id)])).rows;
 return {tasks:tasks.slice(0,50).map(t=>({id:t.id,title:t.title,assignee_id:t.assignee_id,status:t.status,deadline:t.deadline})),total:tasks.length,history};
}
const templateInput=z.object({name:z.string().trim().min(2).max(100),shared:z.boolean(),content:z.object({
 title:taskInput.shape.title,description:taskInput.shape.description,price:taskInput.shape.price,
 customFields:customFieldsInput,important:z.boolean().nullable().optional(),customerRisk:z.boolean().nullable().optional()
})});
export async function listTaskTemplates(actor:User){
 return (await pool.query(`SELECT id,owner_id,name,content,shared FROM task_templates
 WHERE owner_id=$1 OR (shared AND $2) ORDER BY lower(name),id LIMIT 50`,[actor.id,globalAccess(actor)])).rows;
}
export async function saveTaskTemplate(actor:User,input:unknown){
 const value=templateInput.parse(input);
 assert(!value.shared||globalAccess(actor),403,'Общие шаблоны создаёт руководство.');
 const inserted=await pool.query(`INSERT INTO task_templates(id,owner_id,name,content,shared) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(owner_id,name) DO NOTHING RETURNING id`,[randomUUID(),actor.id,value.name,JSON.stringify(value.content),value.shared]);
 assert(inserted.rowCount,409,'Шаблон с таким названием уже есть.');
 return inserted.rows[0];
}
export async function removeTaskTemplate(actor:User,id:string){
 const result=await pool.query('DELETE FROM task_templates WHERE id=$1 AND owner_id=$2',[id,actor.id]);
 assert(result.rowCount,404,'Свой шаблон не найден.');
}
