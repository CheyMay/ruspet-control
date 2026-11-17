import {taskPrice,type PriceBand} from './pricing.js';
import {businessDay} from './queues.js';
import type {Task,User} from './types.js';
export type ReportView='mine'|'created'|'team'|'company';
export interface ReportParameters {view?:ReportView;from?:string;to?:string;actorId?:string;assigneeId?:string;creatorId?:string;priceBand?:PriceBand;queue?:'all'|'front'|'overdue'|'today'|'review'|'completed'|'no_deadline'}
export const hasCompanyOverview=(user:User)=>user.role==='director'||user.role==='admin';
export const defaultReportView=(user:User):ReportView=>hasCompanyOverview(user)?'company':'mine';
export const reportViews=(user:User):ReportView[]=>user.role==='employee'?['mine','created']:hasCompanyOverview(user)?['company','mine','created','team']:['mine','created','team'];
export const reportViewLabels:Record<ReportView,string>={mine:'Мои задачи',created:'Я постановщик',team:'Задачи команды',company:'Вся компания'};
export const reportKindLabels:Record<string,string>={snapshot:'Общий отчёт',period:'Отчёт за период',today:'Задачи на сегодня',overdue:'Просрочки',review:'Приёмка',daily:'Итоги и работа на завтра',nextday:'План следующего дня'};
export function localDayStart(day:string){return new Date(day+'T00:00:00+03:00');}
export function nextBusinessDay(day:string){let d=new Date(day+'T12:00:00+03:00');do{d=new Date(d.getTime()+86400000);}while([0,6].includes(d.getUTCDay()));return new Date(d.getTime()+10800000).toISOString().slice(0,10);}
export function compareWorkPlan(a:Task,b:Task,day:string){
 const earlier=(task:Task)=>task.deadline&&businessDay(task.deadline)<day?0:1;
 return earlier(a)-earlier(b)||(taskPrice(b)??-1)-(taskPrice(a)??-1)||(a.deadline||'9999').localeCompare(b.deadline||'9999')||a.id.localeCompare(b.id);
}
