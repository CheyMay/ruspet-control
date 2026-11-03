import {pool} from './db.js';
import type {Task} from '../shared/types.js';

/** Integration boundary, not a Bitrix API. A real adapter must map IDs, verify
 * permissions and handle the operation key idempotently before enabling this worker. */
export type TaskSyncAdapter=(change:{operationKey:string;taskId:string;version:number;payload:{kind:string;after:Task}})=>Promise<void>;
let lastAttempt=0;
export async function processTaskSync(adapter:TaskSyncAdapter,now=new Date(),limit=10){
 const lock=await pool.connect();let acquired=false,sent=0;
 try{
  acquired=(await lock.query('SELECT pg_try_advisory_lock(431015) ok')).rows[0].ok;if(!acquired)return {sent};
  for(let i=0;i<Math.min(10,Math.max(0,limit));i++){
   const row=(await pool.query("SELECT q.* FROM task_sync_queue q WHERE state NOT IN ('sent','canceled') AND (retry_at IS NULL OR retry_at<=$1) AND NOT EXISTS(SELECT 1 FROM task_sync_queue older WHERE older.task_id=q.task_id AND older.task_version<q.task_version AND older.state NOT IN ('sent','canceled')) ORDER BY created_at,id LIMIT 1",[now.toISOString()])).rows[0];if(!row)break;
   const wait=1000-(Date.now()-lastAttempt);if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));lastAttempt=Date.now();
   try{await adapter({operationKey:row.id,taskId:row.task_id,version:row.task_version,payload:row.payload});await pool.query("UPDATE task_sync_queue SET state='sent',attempts=attempts+1,retry_at=NULL WHERE id=$1",[row.id]);sent++;}
   catch{await pool.query("UPDATE task_sync_queue SET state='failed',attempts=attempts+1,retry_at=$2 WHERE id=$1",[row.id,new Date(now.getTime()+Math.min(3600000,30000*2**Math.min(row.attempts,7))).toISOString()]);}

  }
  return {sent};
 }finally{if(acquired)await lock.query('SELECT pg_advisory_unlock(431015)');lock.release();}
}
export async function taskSyncStatus(){return {provider:'mock',connected:false,queue:(await pool.query('SELECT state,count(*)::int count FROM task_sync_queue GROUP BY state')).rows};}
