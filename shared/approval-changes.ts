import {formatPrice} from './pricing.js';
import type {ApprovalTaskChange} from './types.js';

const labels:Record<string,string>={
 price:'Цена задачи',deadline:'Текущий крайний срок',title:'Название',description:'Описание',
 assignee_id:'Исполнитель',creator_id:'Постановщик',branch_id:'Филиал',status:'Статус',
 planned_start:'Плановое начало',planned_end:'Плановое окончание',completed_at:'Дата завершения',
 important:'Важность',customer_risk:'Риск потери клиента',parent_id:'Родительская задача',
 company_id:'Связь с ОКБ',custom_fields:'Дополнительные поля',priority:'Приоритет',critical:'Критичность',result_required:'Обязательность результата'
};
const dates=new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'});
const statuses:Record<string,string>={active:'В работе',review:'На приёмке',completed:'Завершена'};

export function approvalChangeLines(change:ApprovalTaskChange,name?:(id:string)=>string|undefined){
 return change.fields.map(({field,before,after})=>{
  const label=labels[field]??'Параметры задачи';
  if(field==='price')return label+': '+formatPrice({price:typeof before==='number'?before:null})+' → '+formatPrice({price:typeof after==='number'?after:null});
  if(field==='assignee_id'||field==='creator_id'){
   const old=name?.(String(before)),next=name?.(String(after));
   if(old&&next)return label+': '+old+' → '+next;
  }
  if(field==='priority')return label+': '+(before==='high'?'Высокий':'Обычный')+' → '+(after==='high'?'Высокий':'Обычный');
  if(field==='critical'||field==='result_required')return label+': '+(before?'Да':'Нет')+' → '+(after?'Да':'Нет');
  if(field==='status')return label+': '+statuses[String(before)]+' → '+statuses[String(after)];
  if(['deadline','planned_start','planned_end','completed_at'].includes(field)){
   const date=(value:typeof before)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?dates.format(new Date(value))+' МСК':'—';
   return label+': '+date(before)+' → '+date(after);
  }
  return label;
 });
}
