import type {PriceBand} from './pricing.js';
export interface ReportParameters {from?:string;to?:string;actorId?:string;assigneeId?:string;creatorId?:string;priceBand?:PriceBand;queue?:'all'|'front'|'overdue'|'today'|'review'|'completed'|'no_deadline'}
export const reportKindLabels:Record<string,string>={snapshot:'Общий отчёт',period:'Отчёт за период',today:'Задачи на сегодня',overdue:'Просрочки',review:'Приёмка',daily:'Итоги и работа на завтра',nextday:'План следующего дня'};
export function localDayStart(day:string){return new Date(day+'T00:00:00+03:00');}
export function nextBusinessDay(day:string){let d=new Date(day+'T12:00:00+03:00');do{d=new Date(d.getTime()+86400000);}while([0,6].includes(d.getUTCDay()));return new Date(d.getTime()+10800000).toISOString().slice(0,10);}
