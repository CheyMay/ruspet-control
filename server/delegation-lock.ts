import type {Db} from './db.js';
import {assert} from './domain.js';
export async function requireAcceptedDelegations(db:Db,id:string){
 assert(!(await db.query("SELECT 1 FROM tasks WHERE delegated_from_id=$1 AND status<>'completed' LIMIT 1",[id])).rowCount,409,'Сначала примите результаты всех делегированных поручений.');
}
// Always lock ancestors before descendants, including acceptance and undo.
export async function lockDelegationChain(db:Db,id:string){
 const chain=(await db.query(`WITH RECURSIVE chain AS (
  SELECT id,delegated_from_id,ARRAY[id] path FROM tasks WHERE id=$1
  UNION ALL SELECT t.id,t.delegated_from_id,c.path||t.id FROM tasks t JOIN chain c ON t.id=c.delegated_from_id WHERE NOT(t.id=ANY(c.path))
 ) SELECT id FROM chain ORDER BY cardinality(path) DESC`,[id])).rows;
 for(const row of chain)await db.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE',[row.id]);
}
