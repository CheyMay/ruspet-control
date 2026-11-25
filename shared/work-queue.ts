import {actionItems,activeTaskApproval,canReview,taskNextAction,type ActionItem} from './actions.js';
import {businessDay} from './queues.js';
import type {Bootstrap,Task} from './types.js';
import type {TeamScope} from './team-scopes.js';

export const workQueueTitle='Сроки и действия';
export const workLabels={overdue:'Просрочено',today:'Крайний срок сегодня',next:'Ждут моего действия',waiting:'Ждут действия коллеги',planned:'Остальные в работе'} as const;
export const workBuckets=['overdue','today','next','waiting','planned'] as const;
export type WorkBucket=keyof typeof workLabels;
export type WorkScope='mine'|TeamScope;
export type WorkTask={
 task:Task;bucket:WorkBucket;deadlineState:'earlier'|'expired'|'today'|null;
 ownerId:string|null;action:ActionItem|null;needsAcceptance:boolean;pendingApproval:boolean;
 label:string;tab:'info'|'discussion'|'approvals'|'result';
};
export type WorkQueue=Record<WorkBucket,WorkTask[]>;
const priority:Record<ActionItem['kind'],number>={clarification:0,decision:1,review:2,answer:3,rework:4,edit_permission:5};
const tabs:Record<ActionItem['kind'],WorkTask['tab']>={
 answer:'discussion',decision:'approvals',clarification:'approvals',edit_permission:'approvals',review:'result',rework:'result'};
function deadlineState(task:Task,now:Date,today:string):WorkTask['deadlineState']{
 if(!task.deadline)return null;
 const at=Date.parse(task.deadline);
 if(!Number.isFinite(at))return null;
 const day=businessDay(task.deadline);
 if(day<today)return 'earlier';
 if(day===today)return at<=+now?'expired':'today';
 return null;
}
export const workCount=(queue:WorkQueue)=>queue.overdue.length+queue.today.length+queue.next.length;

export function workQueue(data:Bootstrap,scope:WorkScope='mine'):WorkQueue{
 const queue:WorkQueue={overdue:[],today:[],next:[],waiting:[],planned:[]};
 const user=data.user,now=new Date(data.serverTime),today=businessDay(now);
 const personal=scope==='mine';
 if(!data.salesTeams&&(scope==='sales'||scope==='team'&&user.role==='employee'))return queue;
 const teamTasks=!personal&&data.salesTeams?new Set(data.salesTeams[scope]):null;
 const allVisible=user.role==='admin'||user.role==='director',members=new Set(data.teamIds??[]);
 const awaiting=new Set(data.pendingAssignmentIds??[]);
 const approvals=new Map(data.approvals.filter(a=>a.state==='pending'&&!a.canceled_at).map(a=>[a.task_id,a]));
 const actions=new Map<string,ActionItem>();
 for(const item of actionItems(data)){
  if(personal&&!item.mine)continue;
  const previous=actions.get(item.taskId);
  if(!previous||priority[item.kind]<priority[previous.kind])actions.set(item.taskId,item);
 }
 for(const task of data.tasks){
  if(task.status==='completed'||personal&&task.workspace_read_only)continue;
  const own=task.assignee_id===user.id;
  if(!personal&&(own||(teamTasks?!teamTasks.has(task.id):!allVisible&&!members.has(task.assignee_id))))continue;
  const approval=approvals.get(task.id);
  const pendingApproval=!!approval&&activeTaskApproval(task,approval);
  const current=taskNextAction(task,pendingApproval?approval:undefined,data.approvalScope);
  const allowedReview=!personal||task.status!=='review'||pendingApproval||canReview(user,task,data.approvalScope);
  const turn=allowedReview||current?.userId!==user.id?current:null;
  const candidate=actions.get(task.id);
  const related=pendingApproval&&candidate?.kind==='rework'||!allowedReview&&candidate?.kind==='review'?null:candidate??null;
  if(personal&&!own&&!related)continue;
  const stage=pendingApproval||task.status==='review';
  const deadline=pendingApproval?null:deadlineState(task,now,today);
  const needsAcceptance=own&&task.status==='active'&&awaiting.has(task.id);
  const waiting=stage&&(!personal||turn?.userId!==user.id)&&(!related||!personal);
  const execution=task.status==='active'&&!pendingApproval&&(!personal||own&&turn?.userId===user.id);
  let bucket:WorkBucket;
  if(waiting)bucket='waiting';
  else if(execution&&deadline)bucket=deadline==='today'?'today':'overdue';
  else if(related||needsAcceptance)bucket='next';
  else if(execution)bucket='planned';
  else continue;
  const action=waiting?null:related;
  const accept=needsAcceptance&&!pendingApproval;
  const label=accept?'Принять назначение':action?.label??turn?.label??'Проверить состояние задачи';
  const tab=accept?'info':action?tabs[action.kind]:pendingApproval?'approvals':task.status==='review'?'result':'info';
  queue[bucket].push({task,bucket,deadlineState:deadline,ownerId:action?.ownerId??turn?.userId??null,
   action,needsAcceptance:accept,pendingApproval,label,tab});
 }
 for(const bucket of workBuckets){
  queue[bucket].sort((a,b)=>(bucket==='next'?
   (a.action?.since??a.task.created_at).localeCompare(b.action?.since??b.task.created_at):
   (a.task.deadline??'9999').localeCompare(b.task.deadline??'9999'))||a.task.id.localeCompare(b.task.id,'ru',{numeric:true}));
 }
 return queue;
}
