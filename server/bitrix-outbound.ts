import {pool} from './db.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {syncLinkedTask} from './bitrix-sync.js';

/** Run only inside the common Bitrix worker lock (431025). */
export async function processBitrixOutbound(request:BitrixRequest){
 if(process.env.BITRIX_WRITE_ENABLED!=='true')return false;
 const link=(await pool.query(`SELECT l.task_id FROM bitrix_task_links l
  WHERE (l.outbound_retry_at IS NULL OR l.outbound_retry_at<=now()) AND l.conflict IS DISTINCT FROM 'Задача удалена в Битрикс24. Требуется решение руководителя.'
  AND NOT EXISTS(SELECT 1 FROM comments c JOIN bitrix_comment_outbox cq ON cq.comment_id=c.id WHERE c.task_id=l.task_id AND c.kind='review' AND cq.state<>'sent' AND c.withdrawn_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM bitrix_content_ops o WHERE o.task_id=l.task_id AND o.kind='result.pin' AND o.state<>'sent')
  AND EXISTS(SELECT 1 FROM task_sync_queue q WHERE q.task_id=l.task_id AND q.task_version>l.linked_version
   AND q.state IN ('pending','failed')
   AND q.payload->>'kind' IN ('task_edited','deadline_changed','action_undone','review_submitted','review_returned','task_completed'))
  ORDER BY l.outbound_retry_at NULLS FIRST,l.task_id LIMIT 1`)).rows[0];
 if(!link)return false;
 try{
  const plan=await syncLinkedTask(request,link.task_id,true,true);
  if(plan.conflict.length)throw new BitrixError('Конфликт полей: '+plan.conflict.join(', '));
  // Changes already present remotely need no repeated write, but still acknowledge the outbox.
  await pool.query(`UPDATE task_sync_queue q SET state='sent',retry_at=NULL WHERE q.task_id=$1
   AND q.task_version>(SELECT linked_version FROM bitrix_task_links WHERE task_id=$1)
   AND q.task_version<=$2
   AND q.state IN ('pending','failed')
   AND q.payload->>'kind' IN ('task_edited','deadline_changed','action_undone','review_submitted','review_returned','task_completed')`,[link.task_id,plan.syncedVersion]);
  await pool.query('UPDATE bitrix_task_links SET outbound_error=NULL,outbound_retry_at=NULL,outbound_attempts=0 WHERE task_id=$1',[link.task_id]);
 }catch(e){
  const reason=e instanceof BitrixError?e.message:'Ошибка отправки изменений в Битрикс24.';
  await pool.query(`UPDATE bitrix_task_links SET outbound_error=$2,outbound_attempts=outbound_attempts+1,
   outbound_retry_at=now()+least(3600,30*power(2,least(outbound_attempts,7))) * interval '1 second' WHERE task_id=$1`,[link.task_id,reason]);
 }
 return true;
}
