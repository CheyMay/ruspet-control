import {summarize,plannedInterval} from './analytics.js';
import {taskQueue,businessDay} from './queues.js';
import type {Task,User,SourceInfo} from './types.js';
export const reportKinds:Record<string,string>={snapshot:'Общее состояние',today:'Последний день сегодня',overdue:'Просрочки прошлых дней',review:'Ожидают приёмки',daily:'Итоги дня',nextday:'План на следующий рабочий день'};
export function reportAnalysis(tasks:Task[],users:User[],now:Date,previous:{id:string;created_at:string;rows:Task[];analysis?:{asOf:string}}|null,source:SourceInfo|null){
 const counts=summarize(tasks,now),active=tasks.filter(t=>t.status==='active');
 const team=users.filter(u=>tasks.some(t=>t.assignee_id===u.id)).map(u=>({id:u.id,name:u.name,...summarize(tasks.filter(t=>t.assignee_id===u.id),now)})).sort((a,b)=>b.overdue-a.overdue||b.total-a.total||a.name.localeCompare(b.name,'ru'));
 const missingPlan=active.filter(t=>{const p=plannedInterval(t);return !p.start||!p.end||new Date(p.end)<=new Date(p.start)}).length;
 const unknownRisk=active.filter(t=>t.customer_risk===null).length,risk=tasks.filter(t=>t.customer_risk&&t.status!=='completed').length;
 const old=new Map(previous?.rows.map(t=>[t.id,t])||[]),current=new Set(tasks.map(t=>t.id));
 const fields:(keyof Task)[]=['title','description','status','deadline','assignee_id','planned_start','planned_end','important','customer_risk','parent_id'];
 const comparison=previous?{id:previous.id,at:previous.analysis?.asOf||previous.created_at,previousCounts:summarize(previous.rows,new Date(previous.analysis?.asOf||previous.created_at)),entered:tasks.filter(t=>!old.has(t.id)).length,left:previous.rows.filter(t=>!current.has(t.id)).length,changed:tasks.filter(t=>{const p=old.get(t.id);return p&&fields.some(k=>p[k]!==t[k]);}).length,completed:tasks.filter(t=>old.has(t.id)&&old.get(t.id)!.status!=='completed'&&t.status==='completed').length,deadlineChanged:tasks.filter(t=>old.has(t.id)&&old.get(t.id)!.deadline!==t.deadline).length}:null;
 const urgent=tasks.filter(t=>['overdue','today'].includes(taskQueue(t,now))).sort((a,b)=>Number(!!b.customer_risk)-Number(!!a.customer_risk)||(a.deadline||'').localeCompare(b.deadline||'')).slice(0,10).map(t=>({id:t.id,title:t.title,owner:users.find(u=>u.id===t.assignee_id)?.name||t.assignee_id,deadline:t.deadline!,risk:!!t.customer_risk,daysLate:Math.max(0,Math.round((Date.parse(businessDay(now))-Date.parse(businessDay(t.deadline!)))/86400000))}));
 const notes=[`Всего ${counts.total} задач: ${counts.unfinished} незавершённых, ${counts.completed} завершённых.`,`Просрочены с прошлых дней — ${counts.overdue}; последний день сегодня — ${counts.today}; ожидают приёмки — ${counts.review}.`];
 if(team[0]?.overdue)notes.push(`Больше всего просрочек в этой выборке: ${team[0].name} — ${team[0].overdue}. Это количество задач, не оценка эффективности.`);
 if(missingPlan)notes.push(`У ${missingPlan} задач в работе нет полного корректного плана. Они не дают достоверной оценки нагрузки.`);
 if(!previous)notes.push('Первый снимок этого типа: сравнение появится после следующего отчёта.');
 return {asOf:now.toISOString(),targetDay:null as string|null,excludedWithoutPlan:null as number|null,counts,team,missingPlan,unknownRisk,risk,comparison,urgent,notes,source:source?{file:source.file_name,sheet:source.sheet_name,importedAt:source.imported_at}:null};
}
export type ReportAnalysis=ReturnType<typeof reportAnalysis>;
