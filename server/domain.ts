import type { Task, User, Rules, Metrics, Approval, ControlRequest } from '../shared/types.js';
import {exclusionReason} from '../shared/task-selection.js';
import {plannedInterval} from '../shared/analytics.js';
import { taskQueue, elapsedToday, taskCode, businessDay } from '../shared/queues.js';
export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export function assert(condition: unknown, status: number, message: string): asserts condition { if(!condition) throw new AppError(status,message); }
export const globalAccess = (u:User) => ['director','admin','sales_head'].includes(u.role);
export const canAccess = (u:User,t:Task) => globalAccess(u) || (u.role==='branch_manager' && u.branch_id===t.branch_id) || t.assignee_id===u.id || t.creator_id===u.id;
export const canSee = (u:User,t:Task) => canAccess(u,t)&&!exclusionReason(t);
export const canRequest = (u:User,t:Task) => u.id===t.assignee_id || u.id===t.creator_id || u.role==='admin' || (u.role==='branch_manager' && u.branch_id===t.branch_id);
export const canManage = (u:User) => ['admin','director','branch_manager','sales_head'].includes(u.role);
export function moscowDay(date: Date|string = new Date()): string { return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date)); }
export function evaluate(task: Task, rules: Rules, now = new Date(), allTasks:Task[] = []) {
 if(task.status==='completed'||exclusionReason(task)) return [];
 const result: {rule:string;severity:string;message:string}[]=[];
 const add=(rule:string,message:string,severity='warning')=>result.push({rule,message,severity});
 if(rules.overdue && taskQueue(task,now)==='overdue') add('overdue','Срок прошёл до начала сегодняшнего дня','critical');
 if(rules.overdue && elapsedToday(task,now)) add('elapsed_today','Время выполнения истекло сегодня','warning');
 if(rules.missingDeadline && !task.deadline) add('missing_deadline','Не указан крайний срок');
 if(rules.plannedOverdue && task.status!=='review' && task.planned_end && businessDay(task.planned_end)<businessDay(now) && (!task.deadline || new Date(task.deadline)>=now)) add('planned_overdue','Плановое окончание просрочено');
 if(rules.requiredFields && (task.important===null || task.customer_risk===null)) add('required_fields','Не заполнены признаки важности или риска потери клиента');
 // Verified from GAS validateTaskCode; self-assigned tasks are exempt there.
 if(rules.code && task.assignee_id!==task.creator_id && !taskCode(task.title).valid) add('code','Некорректный буквенный код: [РЕ][ЗПОВ][БМ]*; старые коды с # допускаются');
 if(rules.planning && task.status==='active'){
  const {start,end}=plannedInterval(task);
  if(!start)add('missing_plan_start','Не указано плановое начало');
  if(!end)add('missing_plan_end','Не указано плановое окончание');
  if(start&&end){const duration=(new Date(end).getTime()-new Date(start).getTime())/60000;if(duration<0)add('negative_plan','Окончание раньше начала');if(duration>360)add('long_plan','Плановая длительность больше 6 часов');}
  if(end&&task.deadline&&new Date(end)>new Date(task.deadline))add('plan_after_deadline','Плановое окончание позже крайнего срока');
  if(end&&new Date(end)<new Date(task.created_at))add('plan_before_creation','Плановое окончание раньше создания задачи');
  const parentId=task.parent_id!==undefined?task.parent_id||'':String(task.source_fields?.['ID базовой задачи']||'');
  if(parentId){const parent=allTasks.find(t=>t.id===parentId);if(!parent)add('parent_unavailable','Родитель отсутствует в доступной выборке; сроки не проверены','info');else if(parent.deadline){if(task.deadline&&new Date(task.deadline)>new Date(parent.deadline))add('child_deadline','Срок подзадачи позже срока родителя');if(end&&new Date(end)>new Date(parent.deadline))add('child_plan','План подзадачи позже срока родителя');}}
  if(!taskCode(task.title).legacy&&taskCode(task.title).code[2]==='Б'&&!allTasks.some(t=>(t.parent_id!==undefined?t.parent_id:String(t.source_fields?.['ID базовой задачи']||''))===task.id))add('children_unavailable','У большой задачи нет подзадач в доступной выборке','info');
 }
 return result;
}
export function metrics(tasks:Task[],approvals:Approval[],controls:ControlRequest[],now=new Date()):Metrics {
 const active=tasks.filter(t=>t.status!=='completed');
 return {total:tasks.length,active:active.length,overdue:active.filter(t=>taskQueue(t,now)==='overdue').length,today:active.filter(t=>taskQueue(t,now)==='today').length,review:tasks.filter(t=>t.status==='review').length,completed:tasks.filter(t=>t.status==='completed').length,pending:approvals.filter(a=>a.state==='pending').length,waiting:controls.filter(c=>['waiting','escalated'].includes(c.state)).length,transfers:tasks.reduce((sum,t)=>sum+t.transfer_count,0)};
}
export const defaultRules:Rules={overdue:true,missingDeadline:true,plannedOverdue:true,requiredFields:true,code:false,responseMinLength:12,reminderMinutes:30,maxReminders:2,routes:{deadline:['branchManager','salesHead'],completion:['branchManager','director']}};
