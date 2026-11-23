import {pool} from './db.js';
import {assert,canSee} from './domain.js';
import {getCompany} from './okb.js';
import {withTaskClients} from './task-clients.js';
import type {Task,User} from '../shared/types.js';

type NoteScope={companyId:string;taskId?:string};
async function checkScope(actor:User,{companyId,taskId}:NoteScope){
 if(!taskId){await getCompany(actor,companyId);return;}
 const task=(await pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];
 assert(task&&canSee(actor,task),404,'Задача недоступна.');
 const [linked]=await withTaskClients([task],pool);
 assert(linked.client_refs?.some(client=>client.id===companyId),404,'Компания не связана с задачей.');
}
type Note={id:string;body:string;created_at:string;author:string};
export async function clientNotes(actor:User,scope:NoteScope,before?:string){
 await checkScope(actor,scope);
 const rows=(await pool.query<Note>(`SELECT n.id,n.body,n.created_at,u.name author FROM client_notes n JOIN users u ON u.id=n.author_id
  WHERE n.company_id=$1 AND ($2::uuid IS NULL OR (n.created_at,n.id) < (SELECT created_at,id FROM client_notes WHERE company_id=$1 AND id=$2))
  ORDER BY n.created_at DESC,n.id DESC LIMIT 21`,[scope.companyId,before??null])).rows;
 return {notes:rows.slice(0,20),more:rows.length>20};
}
export async function addClientNote(actor:User,scope:NoteScope,body:string){
 await checkScope(actor,scope);
 const {rows}=await pool.query<Note>(`INSERT INTO client_notes(company_id,author_id,body)
  VALUES($1,$2,$3) RETURNING id,body,created_at,$4::text AS author`,[scope.companyId,actor.id,body,actor.name]);
 return rows[0];
}
