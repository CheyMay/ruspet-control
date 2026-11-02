import {randomUUID} from 'node:crypto';
import {transaction,type Db} from './db.js';
import {assert,canRequest,canSee,canManage,globalAccess} from './domain.js';
import {event,notify,refreshTaskFindings} from './service.js';
import {MockTaskProvider} from './providers.js';
import type {Task,User} from '../shared/types.js';
export interface TaskInput {title:string;description:string;assigneeId:string;deadline:string|null;plannedStart:string|null;plannedEnd:string|null;important:boolean|null;customerRisk:boolean|null;parentId:string|null}
const provider=new MockTaskProvider();
async function validate(db:Db,u:User,input:TaskInput,id?:string,currentOwner?:string){
 const owner=(await db.query('SELECT * FROM users WHERE id=$1',[input.assigneeId])).rows[0] as User|undefined;
 assert(owner,400,'Исполнитель не найден.');assert(owner.id===currentOwner||globalAccess(u)||owner.id===u.id||(u.role==='branch_manager'&&owner.branch_id===u.branch_id),403,'Этот исполнитель вне вашей области доступа.');
 if(input.plannedStart&&input.plannedEnd)assert(new Date(input.plannedEnd)>=new Date(input.plannedStart),400,'Плановое окончание раньше начала.');
 if(input.parentId){assert(input.parentId!==id,400,'Задача не может быть своим родителем.');const parent=(await db.query('SELECT * FROM tasks WHERE id=$1',[input.parentId])).rows[0];assert(parent&&canSee(u,parent),400,'Родительская задача не найдена или недоступна.');
 const chain=(await db.query('WITH RECURSIVE tree AS (SELECT id,parent_id,ARRAY[id] path FROM tasks WHERE id=$1 UNION ALL SELECT t.id,t.parent_id,tree.path||t.id FROM tasks t JOIN tree ON t.id=tree.parent_id WHERE NOT(t.id=ANY(tree.path))) SELECT id FROM tree',[input.parentId])).rows;assert(!chain.some(t=>t.id===id),400,'Возникнет цикл родительских задач.');}
 return owner!;
}
export async function createTask(u:User,input:TaskInput){return transaction(async db=>{
 const owner=await validate(db,u,input),id='L-'+randomUUID().slice(0,8);
 const task=(await db.query("INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,deadline,original_deadline,planned_start,planned_end,status,priority,code,important,customer_risk,parent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,'active','normal',$10,$11,$12,$13) RETURNING *",[id,input.title,input.description,owner.branch_id,owner.id,u.id,input.deadline,input.plannedStart,input.plannedEnd,input.title.split(/\s/)[0],input.important,input.customerRisk,input.parentId])).rows[0];
 await db.query('INSERT INTO mock_provider_tasks(id,snapshot,revision) VALUES($1,$2,1)',[id,JSON.stringify(task)]);await refreshTaskFindings(db,task,u);await event(db,id,u.id,'created','Создана локальная задача',{after:task});return {id};
});}
export async function editTask(u:User,id:string,input:TaskInput,version:number){return transaction(async db=>{
 await db.query('SELECT pg_advisory_xact_lock(431011)');
 const before=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0] as Task;
 assert(before&&canSee(u,before),404,'Задача недоступна.');assert(canRequest(u,before),403,'Нет права изменять задачу.');assert(before.status==='active',409,'Редактировать можно только задачу в работе.');assert(before.version===version,409,'Задача изменилась. Обновите карточку.');
 assert(input.deadline===before.deadline,400,'Крайний срок меняется через запрос согласования.');
 const owner=await validate(db,u,input,id,before.assignee_id);
 const after=(await db.query('UPDATE tasks SET title=$2,description=$3,assignee_id=$4,branch_id=$5,planned_start=$6,planned_end=$7,important=$8,customer_risk=$9,parent_id=$10,code=$11,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,input.title,input.description,owner.id,owner.branch_id,input.plannedStart,input.plannedEnd,input.important,input.customerRisk,input.parentId,input.title.split(/\s/)[0]])).rows[0];
 await provider.applyApprovedChange(db,after,before.version);await db.query("UPDATE approvals SET state='stale' WHERE task_id=$1 AND state='pending'",[id]);
 if(before.assignee_id!==after.assignee_id)await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[id]);await refreshTaskFindings(db,after,u);
 await event(db,id,u.id,'task_edited','Изменены параметры задачи, проверки обновлены.',{before,after});return {id};
});}
export async function reviewTask(u:User,id:string,action:'submit'|'accept'|'return',comment:string,version:number){return transaction(async db=>{
 const before=(await db.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0] as Task;assert(before&&canSee(u,before),404,'Задача недоступна.');assert(before.version===version,409,'Задача изменилась. Обновите карточку.');
 const reviewer=u.id===before.creator_id||u.role==='admin'||u.role==='director'||(canManage(u)&&(globalAccess(u)||u.branch_id===before.branch_id));
 if(action==='submit'){assert(canRequest(u,before),403,'Нет права сдавать задачу.');assert(before.status==='active',409,'Задача уже передана или завершена.');}
 else {assert(reviewer,403,'Решение принимает постановщик или руководитель.');assert(before.status==='review',409,'Задача не ожидает приёмки.');assert(u.id!==before.assignee_id,403,'Нельзя принимать собственную работу.');}
 if(action!=='accept')assert(comment.trim().length>=5,400,'Укажите результат или причину, минимум 5 символов.');
 assert(!(await db.query("SELECT 1 FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rowCount,409,'Сначала завершите активное согласование.');
 const status=action==='submit'?'review':action==='accept'?'completed':'active';
 const after=(await db.query("UPDATE tasks SET status=$2,completed_at=CASE WHEN $2='completed' THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[id,status])).rows[0];
 await provider.applyApprovedChange(db,after,before.version);
 if(action==='submit')await db.query("INSERT INTO task_submissions(id,task_id,round,result,author_id,state) SELECT $1,$2,coalesce(max(round),0)+1,$3,$4,'review' FROM task_submissions WHERE task_id=$2",[randomUUID(),id,comment,u.id]);
 else await db.query("UPDATE task_submissions SET state=$2,reviewer_id=$3,remark=$4,decided_at=now() WHERE task_id=$1 AND state='review'",[id,action==='accept'?'accepted':'returned',u.id,comment||null]);
 const labels={submit:'Работа передана на приёмку',accept:'Результат принят, задача завершена',return:'Задача возвращена в работу'};
 if(comment.trim())await db.query("INSERT INTO comments(id,task_id,author_id,body,kind) VALUES($1,$2,$3,$4,'review')",[randomUUID(),id,u.id,comment]);
 await event(db,id,u.id,action==='accept'?'task_completed':action==='submit'?'review_submitted':'review_returned',labels[action],{before,after,comment});
 await refreshTaskFindings(db,after,u);
 if(action==='accept')await db.query("UPDATE control_requests SET state='resolved' WHERE task_id=$1 AND state<>'resolved'",[id]);
 await notify(db,id,action==='submit'?before.creator_id:before.assignee_id,`${labels[action]} · #${id}${comment.trim()?': '+comment:''}`,`review:${id}:${after.version}`);return {state:status};
});}
