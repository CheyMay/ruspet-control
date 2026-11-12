import {randomUUID} from 'node:crypto';
import {transaction} from './db.js';
import {assert,canSee,globalAccess} from './domain.js';
import {recordTaskBarrier} from './undo-record.js';
import type {Task,User} from '../shared/types.js';
export async function editComment(user:User,taskId:string,id:string,revision:number,body:string|null){
 return transaction(async db=>{
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
  assert(task&&canSee(user,task),404,'Задача недоступна.');
  const comment=(await db.query('SELECT * FROM comments WHERE id=$1 AND task_id=$2 AND withdrawn_at IS NULL FOR UPDATE',[id,taskId])).rows[0];
  assert(comment,404,'Комментарий не найден.');assert(comment.author_id===user.id||globalAccess(user),403,'Нельзя изменять чужой комментарий.');
  assert(comment.revision===revision,409,'Комментарий изменился. Обновите обсуждение.');
  await db.query('UPDATE comments SET body=$2,withdrawn_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1',[id,body??comment.body,body===null]);
  await db.query('INSERT INTO bitrix_comment_revisions(comment_id,body,deleted) VALUES($1,$2,$3)',[id,comment.body,body===null]);
  await db.query('INSERT INTO task_events(id,task_id,actor_id,kind,message,data) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),taskId,user.id,body===null?'comment_deleted':'comment_edited',body===null?'Комментарий удалён':'Комментарий изменён',JSON.stringify({commentId:id,before:comment.body,after:body})]);
  await recordTaskBarrier(db,user,taskId,body===null?'Удаление комментария':'Изменение комментария');
  return {ok:true};
 });
}
