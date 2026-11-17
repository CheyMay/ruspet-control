import type {Task,User,Event} from './types.js';
import type {ReportParameters} from './report-parameters.js';
import {businessDay,taskQueue,elapsedToday} from './queues.js';
import {priceCounts,priceBand,priceLabels} from './pricing.js';
import {localDayStart,nextBusinessDay} from './report-parameters.js';

export const workKinds=new Set(['task_edited','deadline_changed','review_submitted','review_returned','task_completed','explanation','approval_rejected','step_approved','comment','approval_requested','approval_clarification_answered']);
export function reportOutcome(event:Event){
 if(event.kind!=='bitrix_change')return event.kind;
 const before=event.data.before as Task|undefined,after=event.data.after as Task|undefined;
 if(!before||!after)return event.kind;
 if(before.status!=='completed'&&after.status==='completed')return 'task_completed';
 if(before.status!==after.status&&after.status==='review')return 'review_submitted';
 if(before.deadline!==after.deadline)return 'deadline_changed';
 return event.kind;
}
function changedDeadline(event:Event){
 if(event.kind==='deadline_changed')return true;
 if(event.kind!=='bitrix_change')return false;
 const before=event.data.before as Task|undefined,after=event.data.after as Task|undefined;
 return !!before&&!!after&&before.deadline!==after.deadline;
}
export function frontTasks(tasks:Task[],day:string){return tasks.filter(t=>t.status!=='completed'&&(t.status==='review'||!t.deadline||businessDay(t.deadline)<=day));}
export function matchesParameters(t:Task,p:ReportParameters,at:Date){return (!p.assigneeId||t.assignee_id===p.assigneeId)&&(!p.creatorId||t.creator_id===p.creatorId)&&(!p.priceBand||priceBand(t)===p.priceBand)&&(!p.queue||p.queue==='all'||p.queue==='front'&&frontTasks([t],businessDay(at)).length>0||taskQueue(t,at)===p.queue);}
export type FrontSnapshot={user_id:string;day:string;captured_at:string;rows:Task[]};
export function summarizeWork(tasks:Task[],users:User[],events:Event[],p:ReportParameters,from:Date,to:Date,fronts:FrontSnapshot[],trackingFrom:string|null,stateAvailable:boolean,allTasks:Task[]=tasks){
 const day=businessDay(to),ownEvents=events.filter(e=>Date.parse(e.created_at)>=from.getTime()&&Date.parse(e.created_at)<=to.getTime());
 const ids=(kind:string)=>[...new Set(ownEvents.filter(e=>reportOutcome(e)===kind).map(e=>e.task_id!).filter(Boolean))];
 const processed=[...new Set(ownEvents.filter(e=>workKinds.has(reportOutcome(e))).map(e=>e.task_id!).filter(Boolean))];
 const closed=ids('task_completed'),submitted=ids('review_submitted'),deferred=[...new Set(ownEvents.filter(changedDeadline).flatMap(e=>e.task_id?[e.task_id]:[]))];
 const approvalRequests=[...new Set(ownEvents.filter(e=>e.kind==='approval_requested'&&e.data.newDeadline).flatMap(e=>e.task_id?[e.task_id]:[]))];
 const byId=new Map(allTasks.map(t=>[t.id,t]));
 const expected=[...new Map(fronts.flatMap(f=>f.rows).filter(t=>matchesParameters(t,p,to)).map(t=>[t.id,t])).values()];
 const expectedIds=new Set(expected.map(t=>t.id)),frontClosed=expected.filter(t=>byId.get(t.id)?.status==='completed'),frontSubmitted=expected.filter(t=>byId.get(t.id)?.status==='review'),remaining=expected.filter(t=>byId.has(t.id)&&byId.get(t.id)!.status!=='completed');
 const tomorrowDay=nextBusinessDay(day),tomorrow=frontTasks(allTasks.filter(t=>matchesParameters(t,{...p,queue:'all'},to)),tomorrowDay);
 const sameDay=businessDay(from)===day;
 const buckets=new Map<string,{label:string;closed:number;submitted:number;processed:number;cumulativeClosed:number}>();
 if(sameDay){for(let h=new Date(from.getTime()+10800000).getUTCHours();h<=new Date(to.getTime()+10800000).getUTCHours();h++){const label=String(h).padStart(2,'0')+':00';buckets.set(label,{label,closed:0,submitted:0,processed:0,cumulativeClosed:0});}}
 for(const e of ownEvents){
  const outcome=reportOutcome(e);
  if(!workKinds.has(outcome))continue;
  const shifted=new Date(Date.parse(e.created_at)+10800000).toISOString(),label=sameDay?shifted.slice(11,13)+':00':shifted.slice(0,10);
  const bucket=buckets.get(label)||{label,closed:0,submitted:0,processed:0,cumulativeClosed:0};
  if(outcome==='task_completed')bucket.closed++;
  if(outcome==='review_submitted')bucket.submitted++;
  bucket.processed++;buckets.set(label,bucket);
 }
 let cumulative=0;const trend=[...buckets.values()].sort((a,b)=>a.label.localeCompare(b.label)).map(b=>({...b,cumulativeClosed:(cumulative+=b.closed)}));
 const team=users.map(u=>{
  const own=tasks.filter(t=>t.assignee_id===u.id),assignedEvents=ownEvents.filter(e=>((e.data.after||e.data.before) as Task|undefined)?.assignee_id===u.id||!(e.data.after||e.data.before)&&byId.get(e.task_id||'')?.assignee_id===u.id),actorEvents=ownEvents.filter(e=>e.actor_id===u.id);
  const unique=(list:Event[],kinds:Set<string>)=>new Set(list.filter(e=>kinds.has(reportOutcome(e))).map(e=>e.task_id).filter(Boolean)).size;
  const transfers=new Set(assignedEvents.filter(changedDeadline).map(e=>e.task_id).filter(Boolean)).size;
  const mineExpected=expected.filter(t=>t.assignee_id===u.id);
  return {id:u.id,name:u.name,total:own.length,overdue:own.filter(t=>taskQueue(t,to)==='overdue').length,today:own.filter(t=>taskQueue(t,to)==='today').length,prices:priceCounts(own),processed:unique(assignedEvents,workKinds),closed:unique(assignedEvents,new Set(['task_completed'])),processedByActor:unique(actorEvents,workKinds),closedByActor:unique(actorEvents,new Set(['task_completed'])),submitted:unique(assignedEvents,new Set(['review_submitted'])),transfers,expected:mineExpected.length,frontClosed:mineExpected.filter(t=>byId.get(t.id)?.status==='completed').length,frontRemaining:mineExpected.filter(t=>byId.has(t.id)&&byId.get(t.id)!.status!=='completed').length};
 }).filter(u=>u.total||u.processed||u.processedByActor||u.expected);
 const person=(id:string|undefined)=>id?users.find(u=>u.id===id)?.name||id:null;
 return {filters:{'Исполнитель':person(p.assigneeId),'Постановщик':person(p.creatorId),'Кто действовал':person(p.actorId),'Цена':p.priceBand?priceLabels[p.priceBand]:null},from:from.toISOString(),to:to.toISOString(),day,trackingFrom,completeHistory:!!trackingFrom&&Date.parse(trackingFrom)<=from.getTime(),stateAvailable,prices:priceCounts(tasks),elapsedToday:tasks.filter(t=>elapsedToday(t,to)).length,lateIds:tasks.filter(t=>taskQueue(t,to)==='overdue'||elapsedToday(t,to)).map(t=>t.id),overduePrices:priceCounts(tasks.filter(t=>taskQueue(t,to)==='overdue'||elapsedToday(t,to))),activity:{processed:processed.length,closed:closed.length,submitted:submitted.length,transfers:deferred.length,returned:ids('review_returned').length,answers:ids('explanation').length,processedIds:processed,closedIds:closed,submittedIds:submitted},trend,team,
  front:{capturedLatest:fronts.length?fronts.map(f=>f.captured_at).sort().at(-1)!:null,capturedAt:fronts.length?fronts.map(f=>f.captured_at).sort()[0]:null,total:expected.length,unavailable:expected.filter(t=>!byId.has(t.id)).length,closed:frontClosed.length,submitted:frontSubmitted.length,remaining:remaining.length,deferred:expected.filter(t=>deferred.includes(t.id)).length,addedLater:frontTasks(tasks,day).filter(t=>!expectedIds.has(t.id)).length,expectedIds:[...expectedIds],remainingIds:remaining.map(t=>t.id),closedIds:frontClosed.map(t=>t.id)},
  outcomes:{transferIds:deferred,requestedTransferIds:approvalRequests,explanationIds:ids('explanation')},
  tomorrow:{day:tomorrowDay,total:tomorrow.length,overdue:tomorrow.filter(t=>t.deadline&&businessDay(t.deadline)<tomorrowDay).length,today:tomorrow.filter(t=>t.deadline&&businessDay(t.deadline)===tomorrowDay).length,prices:priceCounts(tomorrow),ids:tomorrow.map(t=>t.id)},
  previous:null as null|{id:string;at:string;closedChange:number;processedChange:number;openChange:number},notes:[] as string[]};
}
export type ReportSummary=ReturnType<typeof summarizeWork>&{approvalQueue?:{decisionIds:string[];clarificationIds:string[]}};
