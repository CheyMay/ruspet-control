import {assert,canSee} from './domain.js';
import {transaction,type Db} from './db.js';
import {branchApprovalLead,branchCovers,type BranchApprovalLead} from '../shared/branches.js';
import {priceBand} from '../shared/pricing.js';
import type {Step,Task,User} from '../shared/types.js';
import {randomUUID} from 'node:crypto';

export async function branchApprovalLeads(db:Db):Promise<BranchApprovalLead[]>{
 return (await db.query<BranchApprovalLead>('SELECT branch_id AS "branchId",user_id AS "userId" FROM approval_branch_leads ORDER BY branch_id')).rows;
}
export async function resolveBranchApprovalLead(db:Db,task:Task){
 const people=(await db.query<User>('SELECT * FROM users')).rows;
 const lead=branchApprovalLead(task.branch_id,people,await branchApprovalLeads(db));
 assert(lead&&canSee(lead,task),422,'Для филиала «'+task.branch_id+'» не назначен однозначный руководитель с доступом к задаче. Проверьте назначения в настройках согласований.');
 return lead;
}
export async function saveBranchApprovalLeads(actor:User,items:BranchApprovalLead[]){
 assert(actor.role==='admin',403,'Назначения филиалов меняет администратор.');
 assert(new Set(items.map(item=>item.branchId)).size===items.length,400,'Филиалы не должны повторяться.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431036)');
  const users=(await db.query<User>('SELECT * FROM users WHERE id=ANY($1)',[items.flatMap(item=>item.userId?[item.userId]:[])])).rows;
  for(const item of items){
   const person=users.find(user=>user.id===item.userId);
   assert(!item.userId||person&&!person.root_access&&['admin','director','sales_head','branch_manager'].includes(person.role)&&
    (person.role!=='branch_manager'||person.company_branch_access||branchCovers(person.branch_id,item.branchId)),400,'Выберите руководителя с доступом к филиалу «'+item.branchId+'».');
   const old=(await db.query<{user_id:string|null}>('SELECT user_id FROM approval_branch_leads WHERE branch_id=$1 FOR UPDATE',[item.branchId])).rows[0];
   if(old&&old.user_id===item.userId)continue;
   await db.query(`INSERT INTO approval_branch_leads(branch_id,user_id) VALUES($1,$2)
    ON CONFLICT(branch_id) DO UPDATE SET user_id=excluded.user_id,updated_at=now()`,[item.branchId,item.userId]);
   await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,$2,'branch_approval_lead_changed','Изменён руководитель филиала для согласований',$3)",
    [randomUUID(),actor.id,JSON.stringify({branch:item.branchId,before:old?.user_id??null,after:item.userId})]);
   // A changed assignment must not leave an old branch approver able to decide.
   const affected=(await db.query<{id:string;task_id:string;creator_id:string}>(`UPDATE approvals a SET state='stale',canceled_at=now(),action_revision=action_revision+1
    FROM tasks t WHERE a.task_id=t.id AND a.type='deadline' AND a.state='pending' AND a.branch_review_user_id IS NOT NULL
    AND (t.branch_id=$1 OR starts_with(t.branch_id,$1||' / ')) AND a.branch_review_user_id IS DISTINCT FROM $2
    RETURNING a.id,a.task_id,t.creator_id`,[item.branchId,item.userId])).rows;
   for(const approval of affected){
    await db.query("UPDATE outbox SET withdrawn_at=now() WHERE withdrawn_at IS NULL AND dedupe_key LIKE $1",['approval:'+approval.id+':%']);
    await db.query("INSERT INTO task_events(id,task_id,actor_id,kind,message,data) VALUES($1,$2,$3,'approval_canceled','Руководитель филиала изменился; требуется новый запрос',$4)",
     [randomUUID(),approval.task_id,actor.id,JSON.stringify({approvalId:approval.id,branch:item.branchId})]);
    await db.query('INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key) VALUES($1,$2,$3,$4,$5)',
     [randomUUID(),approval.task_id,approval.creator_id,'Руководитель филиала изменился. Проверьте перенос срока задачи #'+approval.task_id+'.','branch-route:'+approval.id+':'+randomUUID()]);
   }
  }
  return branchApprovalLeads(db);
 });
}
export function lowBudgetDeadlineRoute(task:Task,requesterId:string):Step[]|null|undefined{
 if(priceBand(task)!=='low')return undefined;
 return task.creator_id===requesterId?null:[{userId:task.creator_id,label:'Постановщик'}];
}
export async function withBranchReview(db:Db,task:Task,requesterId:string,route:Step[]|null|undefined,branchReviewer?:string|null){
 if(!branchReviewer||route===undefined||route===null)return route;
 const lead=await resolveBranchApprovalLead(db,task);
 assert(lead.id===branchReviewer&&lead.id!==requesterId&&lead.id!==task.creator_id,422,'Руководитель филиала или участники изменились. Запрос нужно проверить у постановщика.');
 return [...route.filter(step=>step.userId!==lead.id),{userId:lead.id,label:'Руководитель филиала'}];
}
