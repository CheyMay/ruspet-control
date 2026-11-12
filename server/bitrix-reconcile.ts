import {pool} from './db.js';
import {catchupBitrix} from './bitrix-bootstrap.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
/** A bounded fallback to task webhooks: one changed-task page per worker iteration. */
export async function processBitrixReconcile(request:BitrixRequest){
 if(process.env.BITRIX_RECONCILE_ENABLED!=='true')return false;
 const state=(await pool.query('SELECT * FROM bitrix_reconcile_state WHERE id=1 AND next_at<=now()')).rows[0];
 if(!state)return false;
 try{
  if(!state.started_at)await pool.query('UPDATE bitrix_reconcile_state SET started_at=now() WHERE id=1');
  const result=await catchupBitrix(request,state.since,state.cursor,1,process.env.BITRIX_IMPORT_NEW_ENABLED==='true');
  if(result.complete)await pool.query("UPDATE bitrix_reconcile_state SET since=greatest(since,started_at-interval '5 minutes'),cursor='0',started_at=NULL,next_at=now()+interval '30 minutes',finished_at=now(),last_error=NULL WHERE id=1");
  else await pool.query("UPDATE bitrix_reconcile_state SET cursor=$1,next_at=now()+interval '2 seconds',last_error=NULL WHERE id=1",[result.cursor]);
 }catch(e){await pool.query("UPDATE bitrix_reconcile_state SET last_error=$1,next_at=now()+interval '1 minute' WHERE id=1",[e instanceof BitrixError?e.message:'Ошибка фоновой сверки задач.']);}
 return true;
}
