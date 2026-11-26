import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workCount,workQueue} from '../shared/work-queue.js';
import {quickWorkActions} from '../shared/work-actions.js';
import {branchApprovalLead} from '../shared/branches.js';
import type {Approval,Bootstrap,ControlRequest,Task,User} from '../shared/types.js';

const now='2026-11-20T12:00:00+03:00',today='2026-11-20T16:00:00+03:00',tomorrow='2026-11-21T09:00:00+03:00';
const user=(id:string,role:User['role']='employee'):User=>({id,name:id,role,position:'',branch_id:'Крым'});
function task(id:string,assignee_id:string,deadline:string|null,values:Partial<Task>={}):Task{
 return {id,title:id,description:'',branch_id:'Крым',assignee_id,creator_id:'director',deadline,original_deadline:deadline,
  planned_end:null,status:'active',priority:'normal',code:'РЗМ*',important:null,customer_risk:null,version:1,transfer_count:0,
  created_at:'2026-11-16T09:00:00+03:00',updated_at:now,completed_at:null,...values};
}
function approval(id:string,taskId:string,owner:string,values:Partial<Approval>={}):Approval{
 return {id,task_id:taskId,requester_id:'worker',type:'deadline',reason:'Запрос',plan:'',proposed_deadline:tomorrow,
  task_version:1,state:'pending',current_step:0,route:[{label:'Руководитель',userId:owner}],
  route_version:1,action_revision:1,deferred_until:null,created_at:now,clarification_question:null,clarification_answer:null,
  clarification_requested_at:null,clarification_answered_at:null,...values};
}
const data=(actor:User,values:Partial<Bootstrap>):Bootstrap=>({
 user:actor,users:[actor],tasks:[],approvals:[],controls:[],submissions:[],serverTime:now,
 events:[],findings:[],reports:[],notifications:[],rulesVersion:1,source:null,rules:{} as Bootstrap['rules'],metrics:{} as Bootstrap['metrics'],...values
});

test('ordinary assignees get close and deadline shortcuts for overdue and today while self tasks complete directly',()=>{
 const worker=user('worker'),tasks=[task('late','worker','2026-11-19T12:00:00+03:00'),task('today','worker',today)];
 const state=data(worker,{tasks}),queue=workQueue(state);
 for(const item of [queue.overdue[0],queue.today[0]]){const quick=quickWorkActions(state,item);assert.equal(quick.finish,'submit');assert(quick.deadline);}
 const self=task('self','worker',today,{creator_id:'worker'}),own=data(worker,{tasks:[self]});
 assert.equal(quickWorkActions(own,workQueue(own).today[0]).finish,'complete');
 const awaiting=data(worker,{tasks,pendingAssignmentIds:['late']});assert.equal(quickWorkActions(awaiting,workQueue(awaiting).overdue[0]).finish,null);
 const readonly=data(worker,{tasks:[{...tasks[0],workspace_read_only:true}]});
 const row={...queue.overdue[0],task:readonly.tasks[0]};assert.equal(quickWorkActions(readonly,row).finish,null);assert.equal(quickWorkActions(readonly,row).deadline,false);
});

test('quick approval and result acceptance belong to the current actor and keep branch responsibilities separate from the sales role',()=>{
 const creator=user('creator'),head={...user('head','sales_head'),branch_id:'Головной офис / Продажи'},lead=user('lead','branch_manager');lead.branch_id='Краснодар';
 const request=approval('a','low','creator'),low=task('low','worker',today,{creator_id:'creator',price:4999.99});
 const state=data(creator,{users:[creator,head,lead],tasks:[low],approvals:[request],branchApprovalLeads:[{branchId:'Крым',userId:head.id},{branchId:'Краснодар',userId:lead.id}]});
 const quick=quickWorkActions(state,workQueue(state).next[0]);assert.equal(quick.approval?.id,request.id);assert(quick.forward);assert.equal(quick.branchLead?.id,head.id);
 assert.equal(branchApprovalLead('Краснодар',state.users,state.branchApprovalLeads)?.id,lead.id);
 const missing={...state,branchApprovalLeads:[{branchId:'Крым',userId:null}]};assert.equal(quickWorkActions(missing,workQueue(missing).next[0]).branchLead,null);
 const high={...state,tasks:[{...low,price:5000}]};assert.equal(quickWorkActions(high,workQueue(high).next[0]).forward,false);
 const review=data(creator,{tasks:[{...low,status:'review'}]});assert(quickWorkActions(review,workQueue(review).next[0]).accept);
 const foreign=data(user('worker'),{tasks:[{...low,status:'review'}]});assert.equal(quickWorkActions(foreign,workQueue(foreign).waiting[0]).accept,false);
});

test('personal work queue separates expired tasks, remaining deadlines, next steps and waiting without duplicates',()=>{
 const worker=user('worker');
 const items=[
  task('earlier','worker','2026-11-19T16:00:00+03:00'),task('expired','worker',now),task('today','worker',today),
  task('waiting','worker',today),task('other-review','another',today,{status:'review',creator_id:'worker'}),
  task('new','worker',tomorrow),task('new-today','worker',today),task('not-mine','another',today),
  task('no-step','worker',tomorrow),task('done','worker',today,{status:'completed'}),task('inactive-approval','worker',today),
  task('self-review','worker',today,{creator_id:'worker',status:'review'})
 ];
 const answer:ControlRequest={id:'answer',task_id:'today',assignee_id:'worker',state:'waiting',due_at:today,created_at:now,reminders:0,
  reason:null,progress:null,plan:null};
 const result=workQueue(data(worker,{
  tasks:items,approvals:[approval('active','waiting','director'),approval('stale','inactive-approval','director',{task_version:2})],
  pendingAssignmentIds:['new','new-today'],controls:[answer]
 }));
 assert.deepEqual(result.overdue.map(row=>[row.task.id,row.deadlineState]),[['earlier','earlier'],['expired','expired']]);
 assert.deepEqual(result.today.map(row=>row.task.id),['inactive-approval','new-today','today']);
 assert.deepEqual(result.today.find(row=>row.task.id==='today')?.tab,'discussion');
 assert.equal(result.today.find(row=>row.task.id==='new-today')?.needsAcceptance,true);
 assert.deepEqual(result.next.map(row=>row.task.id),['new','other-review']);
 assert.equal(result.next.find(row=>row.task.id==='other-review')?.tab,'result');
 assert.equal(result.waiting.find(row=>row.task.id==='waiting')?.ownerId,'director');
 assert.equal(result.waiting.find(row=>row.task.id==='self-review')?.ownerId,null);
 assert.equal(workCount(result),7);
 const ids=Object.values(result).flat().map(row=>row.task.id);
 assert.equal(ids.length,new Set(ids).size);
});

test('team work requires explicit scope and respects the manager team and current decision owner',()=>{
 const head=user('lead','branch_manager');
 const fixture=data(head,{
  teamIds:['worker'],tasks:[task('own','lead',today),task('team','worker',today),
   task('outside','outside',today),task('request','worker',today)],approvals:[approval('request','request','outside')]
 });
 const own=workQueue(fixture),team=workQueue(fixture,'team');
 assert.deepEqual(own.today.map(row=>row.task.id),['own']);
 assert.deepEqual(team.today.map(row=>row.task.id),['team']);
 assert.equal(team.waiting[0].ownerId,'outside');
 assert.equal(team.waiting[0].tab,'approvals');
 assert.equal(workCount(workQueue({...fixture,user:user('worker')},'team')),0);
});

test('clarification shows as a question instead of overdue work or a control request',()=>{
 const worker=user('worker'),item=task('paused','worker','2026-11-19T16:00:00+03:00');
 const result=workQueue(data(worker,{
  tasks:[item],approvals:[approval('request',item.id,'director',{clarification_requested_at:now})],
  controls:[{id:'old-check',task_id:item.id,assignee_id:worker.id,state:'waiting',due_at:today,
   created_at:now,reminders:0,reason:null,progress:null,plan:null}]
 }));
 assert.equal(result.overdue.length,0);
 assert.equal(result.next.length,1);
 assert.equal(result.next[0].action?.kind,'clarification');
 assert.equal(result.next[0].deadlineState,null);
});
