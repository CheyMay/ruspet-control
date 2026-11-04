import {priceLabels,priceBand,taskPrice} from './pricing.js';
import {businessDay} from './queues.js';
import type {Task} from './types.js';

export const metrics={count:'Количество задач',price:'Сумма цен · ₽',transfers:'Сумма переносов'} as const;
export const numericOps={'>':'Больше','>=':'Не меньше','=':'Равно','!=':'Не равно','<=':'Не больше','<':'Меньше'} as const;
export const filterOps={...numericOps,contains:'Содержит',exists:'Заполнено'} as const;
const windows={today:'Сегодня',week:'Текущая неделя · пн–вс',nextWeek:'Следующая неделя · пн–вс',next7:'Ближайшие 7 дней, включая сегодня',overdue:'Срок до сегодняшнего дня',none:'Без срока'};
const status={active:'В работе',review:'На приёмке',completed:'Завершена'};
const bool={yes:'Да',no:'Нет'};
export const taskFilters={
 status:{label:'Состояние',kind:'choice',options:status},
 assignee:{label:'Исполнитель',kind:'person'},
 creator:{label:'Постановщик',kind:'person'},
 branch:{label:'Филиал',kind:'text'},
 deadline:{label:'Период крайнего срока',kind:'choice',options:windows},
 overdueDays:{label:'Сколько дней прошло после срока · 24 часа',kind:'number'},
 priceBand:{label:'Категория цены',kind:'choice',options:priceLabels},
 price:{label:'Цена · ₽',kind:'number'},
 transfers:{label:'Число переносов',kind:'number'},
 important:{label:'Важная задача',kind:'choice',options:bool},
 customerRisk:{label:'Риск потери клиента',kind:'choice',options:bool},
 title:{label:'Название',kind:'text'},
 code:{label:'Код задачи',kind:'text'},
 custom:{label:'Дополнительное поле',kind:'text'}
} as const;
export type TaskFilter={field:keyof typeof taskFilters;operator:keyof typeof filterOps;value:string;label?:string};
export type MetricConfig={metric:keyof typeof metrics;filters:TaskFilter[];operator:keyof typeof numericOps;threshold:number};
export const metricPreset:MetricConfig={metric:'count',operator:'>',threshold:5,filters:[{field:'status',operator:'=',value:'active'},{field:'overdueDays',operator:'>',value:'2'}]};
export const premiumPreset:MetricConfig={metric:'count',operator:'>',threshold:5,filters:[{field:'status',operator:'=',value:'active'},{field:'deadline',operator:'=',value:'next7'},{field:'priceBand',operator:'=',value:'premium'}]};
export function operatorsFor(field:TaskFilter['field']):TaskFilter['operator'][]{
 const kind=taskFilters[field].kind;
 return kind==='number'?Object.keys(numericOps) as TaskFilter['operator'][]:kind==='text'?['=','!=','contains','exists']:['=','!='];
}
export function compareNumber(actual:number,operator:keyof typeof numericOps,threshold:number){
 switch(operator){
  case '>':return actual>threshold;
  case '>=':return actual>=threshold;
  case '=':return actual===threshold;
  case '!=':return actual!==threshold;
  case '<=':return actual<=threshold;
  case '<':return actual<threshold;
 }
}
export function filterError(filter:TaskFilter){
 const field=taskFilters[filter.field];
 if(!operatorsFor(filter.field).includes(filter.operator))return 'Проверьте оператор для «'+field.label+'».';
 if(filter.field==='custom'&&!filter.label?.trim())return 'Укажите название дополнительного поля.';
 if(filter.operator!=='exists'&&!filter.value.trim())return 'Укажите значение для «'+field.label+'».';
 if(field.kind==='number'&&!Number.isFinite(Number(filter.value)))return 'Введите число для «'+field.label+'».';
 if(field.kind==='choice'&&!Object.hasOwn(field.options,filter.value))return 'Выберите значение для «'+field.label+'».';
 return null;
}
function dayPlus(day:string,amount:number){return new Date(Date.parse(day+'T00:00:00Z')+amount*86400000).toISOString().slice(0,10);}
function deadlineMatches(deadline:string|null,window:string,now:Date){
 if(window==='none')return !deadline;
 if(!deadline)return false;
 const day=businessDay(deadline),today=businessDay(now);
 const weekday=new Date(today+'T00:00:00Z').getUTCDay();
 const monday=dayPlus(today,-((weekday+6)%7));
 if(window==='today')return day===today;
 if(window==='overdue')return day<today;
 if(window==='next7')return day>=today&&day<dayPlus(today,7);
 if(window==='week')return day>=monday&&day<dayPlus(monday,7);
 return day>=dayPlus(monday,7)&&day<dayPlus(monday,14);
}
function matches(task:Task,filter:TaskFilter,now:Date){
 const {field,operator,value}=filter;
 if(field==='deadline')return deadlineMatches(task.deadline,value,now)===(operator==='=');
 const values:Record<Exclude<TaskFilter['field'],'deadline'>,string|number|null|undefined>={
  status:task.status,assignee:task.assignee_id,creator:task.creator_id,branch:task.branch_id,
  overdueDays:task.deadline?(now.getTime()-Date.parse(task.deadline))/86400000:null,
  priceBand:priceBand(task),price:taskPrice(task),transfers:task.transfer_count,important:task.important==null?null:task.important?'yes':'no',
  customerRisk:task.customer_risk==null?null:task.customer_risk?'yes':'no',title:task.title,code:task.code,
  custom:field==='custom'?task.custom_fields?.find(item=>item.label.toLocaleLowerCase('ru-RU')===filter.label?.trim().toLocaleLowerCase('ru-RU'))?.value:null
 };
 const actual=values[field];
 if(actual==null)return false;
 if(typeof actual==='number')return compareNumber(actual,operator as keyof typeof numericOps,Number(value));
 const text=actual.toLocaleLowerCase('ru-RU'),expected=value.toLocaleLowerCase('ru-RU');
 if(operator==='exists')return !!text.trim();
 if(operator==='contains')return text.includes(expected);
 return operator==='='?text===expected:text!==expected;
}
export function measureTasks(tasks:Task[],config:MetricConfig,now:Date){
 const matched=tasks.filter(task=>config.filters.every(filter=>matches(task,filter,now)));
 const value=config.metric==='count'?matched.length:config.metric==='price'?
  Math.round(matched.reduce((sum,task)=>sum+(taskPrice(task)??0)*100,0))/100:
  matched.reduce((sum,task)=>sum+task.transfer_count,0);
 return {value,matched};
}
