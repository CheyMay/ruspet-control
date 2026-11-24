import {pool,type Db} from './db.js';

export const linkedTaskNumber='(SELECT l.external_id::text FROM bitrix_task_links l WHERE l.task_id=t.id) AS bitrix_id';

export async function resolveTaskNumber(number:string,db:Db=pool):Promise<string>{
 if(!/^[1-9]\d{0,17}$/.test(number))return number;
 const {rows}=await db.query<{task_id:string}>('SELECT task_id FROM bitrix_task_links WHERE external_id=$1::bigint',[number]);
 return rows[0]?.task_id??number;
}
