import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workCount,workQueue} from '../shared/work-queue.js';
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
