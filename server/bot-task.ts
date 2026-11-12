import {button,htmlScreen,date,type Payload} from './bot-ui.js';
import {botTextPages} from './bot-presentation.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {escapeHtml as h} from '../shared/report-links.js';
import {canEditTaskData} from '../shared/task-permissions.js';
import {formatPrice,priceBand,priceLabels} from '../shared/pricing.js';
import {canRequest} from './domain.js';
import {canReview} from '../shared/actions.js';
import {taskQueue} from '../shared/queues.js';
import {queueLabels} from '../shared/analytics.js';
import {detail,config} from './service.js';
import {canDelegateTask} from './workflow.js';
import {lastUndo} from './undo.js';
import {pool} from './db.js';
import type {User} from '../shared/types.js';

export async function renderBotTask(u:User,ch:string,p:Payload){
 const d=await detail(u,p.id!),t=d.task,now=new Date();
 const ids=[t.assignee_id,t.creator_id,...(t.accomplice_ids??[]),...(t.auditor_ids??[]),...d.comments.map(c=>c.author_id),...d.events.flatMap(e=>e.actor_id?[e.actor_id]:[]),...d.approvals.flatMap(a=>[a.requester_id,...a.route.map((step:{userId:string})=>step.userId)])];
 const people=(await pool.query('SELECT id,name FROM users WHERE id=ANY($1)',[ids])).rows;
 const name=(id:string)=>people.find(x=>x.id===id)?.name||id;
 const extra={id:t.id,list:p.list},back=[button('← К задаче','task',extra),button('Меню','home')];
 const pending=d.approvals.find(a=>a.state==='pending'),last=d.submissions[0];
 const form=(label:string,kind:string,target?:string,step?:number)=>button(label,'form',{...extra,kind,version:t.version,target,step,revision:target===pending?.id?pending?.action_revision:undefined});
 const waiting=!!pending?.clarification_requested_at&&!pending.clarification_answered_at;
 const approvalRows:ReturnType<typeof button>[][]=[];
 if(pending){
  if(waiting&&pending.requester_id===u.id)approvalRows.push([form('Ответить на уточнение','clarification',pending.id,pending.current_step)]);
  if(!waiting&&pending.route[pending.current_step]?.userId===u.id)approvalRows.push([form('Согласовать','approve',pending.id,pending.current_step),form('Отклонить','reject',pending.id,pending.current_step)],[form('Уточнить','clarify',pending.id,pending.current_step),button('Напомнить через час','confirm',{...extra,kind:'later',target:pending.id,step:pending.current_step,revision:pending.action_revision,minutes:60,values:{}})]);
 }
 const reviewRows=t.status==='review'&&!pending&&canReview(u,t)?[
  [button('Принять без комментария','accept_prepare',{...extra,version:t.version})],
  [form('Принять результат','accept'),form('Вернуть с замечаниями','return')]
 ]:[];
 const paged=async(label:string,text:string,rows:ReturnType<typeof button>[][]=[])=>{
  const pages=botTextPages(text),page=Math.max(0,Math.min(p.page||0,pages.length-1));
  return htmlScreen(u,ch,`<b>${h(label)} · #${h(t.id)}</b>${pages.length>1?` · ${page+1}/${pages.length}`:''}\n\n${h(pages[page])}`,[
   [...(page?[button('← Предыдущая часть',p.op,{...extra,page:page-1})]:[]),...(page+1<pages.length?[button('Продолжение →',p.op,{...extra,page:page+1})]:[])],...rows,back]);
 };
 if(p.op==='task_details'){
  const showPlanning=(await config(pool)).config.showPlanning;
  const lines=[t.title,'',t.description||'Описание пока не заполнено.','','Параметры',
   'Исполнитель: '+name(t.assignee_id),'Постановщик: '+name(t.creator_id),'Срок: '+date(t.deadline)+(t.deadline?' МСК':''),
   'Цена: '+formatPrice(t)+' · '+priceLabels[priceBand(t)],'Переносов срока: '+t.transfer_count,
   ...(showPlanning?['Плановое начало: '+date(t.planned_start??null),'Плановое окончание: '+date(t.planned_end)]:[]),
   ...(t.accomplice_ids?.length?['Соисполнители: '+t.accomplice_ids.map(name).join(', ')]:[]),
   ...(t.auditor_ids?.length?['Наблюдатели: '+t.auditor_ids.map(name).join(', ')]:[]),
   ...(t.delegated_from_id?['Поручение по задаче #'+t.delegated_from_id]:[]),
   ...(t.custom_fields?.length?['','Дополнительные поля',...t.custom_fields.map(f=>f.label+': '+(f.value||'—'))]:[])];
  return paged('Описание и поля',lines.join('\n'));
 }
 if(p.op==='task_result')return paged('Результат работы',last?
  `Сдача №${last.round}${last.restored_from?' · восстановлена после отмены':''}\n${date(last.submitted_at)} МСК\n\n${last.result}${last.remark?'\n\nЗамечания:\n'+last.remark:''}`:'Результат ещё не сдавали.',reviewRows);
 if(p.op==='task_approval')return paged('Согласование',pending?
  `Запрос: ${pending.type==='deadline'?'перенос срока':'закрытие задачи'}\nАвтор: ${name(pending.requester_id)}\n${waiting?'Ждём уточнения от: '+name(pending.requester_id):'Решение за: '+name(pending.route[pending.current_step]?.userId??'')}\nТекущий срок: ${date(t.deadline)}${pending.proposed_deadline?'\nПредложенный срок: '+date(pending.proposed_deadline):''}\n\nПричина:\n${pending.reason}\n\nПлан:\n${pending.plan}${pending.clarification_question?'\n\nВопрос:\n'+pending.clarification_question:''}${pending.clarification_answer?'\n\nОтвет:\n'+pending.clarification_answer:''}`:'Текущих согласований нет.',approvalRows);
 if(p.op==='discussion'){
  const list=[...d.comments].reverse(),page=Math.max(0,Math.min(p.page||0,Math.max(0,list.length-1))),c=list[page];
  const parts=botTextPages(c?.body||'Сообщений пока нет.'),part=Math.max(0,Math.min(p.step||0,parts.length-1));
  return htmlScreen(u,ch,`<b>Обсуждение · #${h(t.id)}</b>\n${list.length?`Сообщение ${page+1} из ${list.length} · новые сначала`:''}\n\n${c?h(c.author_name||name(c.author_id))+' · '+date(c.created_at)+' МСК\n':''}${h(parts[part])}${parts.length>1?`\n\nЧасть ${part+1}/${parts.length}`:''}`,[
   [...(part?[button('← Часть','discussion',{...extra,page,step:part-1})]:[]),...(part+1<parts.length?[button('Читать дальше →','discussion',{...extra,page,step:part+1})]:[])],
   [...(page?[button('← Новее','discussion',{...extra,page:page-1})]:[]),...(page+1<list.length?[button('Ранее →','discussion',{...extra,page:page+1})]:[])],
   [form('Написать комментарий','comment',c?.approval_id||pending?.id)],back]);
 }
 if(p.op==='history'){
  const showPlanning=(await config(pool)).config.showPlanning;
  const fields:Record<string,string>={title:'Название',description:'Описание',deadline:'Срок',status:'Состояние',assignee_id:'Исполнитель',planned_start:'Плановое начало',planned_end:'Плановое окончание'};
  const undone=new Set(d.events.flatMap(e=>e.kind==='action_undone'&&Array.isArray(e.data.originalEvents)?e.data.originalEvents as string[]:[]));
  const texts=d.events.flatMap(e=>{let text=date(e.created_at)+' МСК · '+(e.actor_id?name(e.actor_id):'Система')+'\n'+e.message+(undone.has(e.id)?' · действие отменено':'');const before=e.data.before as Record<string,unknown>|undefined,after=e.data.after as Record<string,unknown>|undefined;
   if(before&&after)for(const [key,label] of Object.entries(fields).filter(([key])=>showPlanning||!key.startsWith('planned_')))if(before[key]!==after[key])text+='\n'+label+': '+String(before[key]??'—')+' → '+String(after[key]??'—');
   for(const key of ['reason','progress','plan','comment','body','question','answer'])if(e.data[key])text+='\n'+({reason:'Причина',progress:'Сделано',plan:'План / результат',comment:'Замечание / решение',body:'Комментарий',question:'Уточнение',answer:'Ответ'} as Record<string,string>)[key]+': '+String(e.data[key]);
   return botTextPages(text);});
  const page=Math.max(0,Math.min(p.page||0,Math.max(0,texts.length-1)));
  return htmlScreen(u,ch,`<b>История · #${h(t.id)}</b> · ${page+1}/${Math.max(1,texts.length)}\n\n${h(texts[page]||'Записей пока нет.')}`,[
   [...(page?[button('← Новее','history',{...extra,page:page-1})]:[]),...(page+1<texts.length?[button('Раньше →','history',{...extra,page:page+1})]:[])],back]);
 }
 if(p.op==='task_more'){
  const rows:ReturnType<typeof button>[][]=[];
  if(canEditTaskData(u,t))rows.push([button('Редактировать задачу','edit',extra)]);
  if(!pending&&t.status==='active'&&canRequest(u,t))rows.push([form('Предложить новый срок','deadline')]);
  if(await canDelegateTask(u,t))rows.push([button('Делегировать задачу','delegate_list',extra)]);
  rows.push([button('Напоминания по задаче','task_reminders',extra)],[button('История','history',extra)]);
  const lastAction=await lastUndo(u,t.id);if(lastAction)rows.push([button('Отменить последнее действие','undo_prepare',{...extra,target:lastAction.id})]);
  if((await pool.query('SELECT 1 FROM bitrix_task_links WHERE task_id=$1',[t.id])).rowCount)rows.push([button('Чек-листы, файлы и результаты','bitrix_content',extra)]);
  return htmlScreen(u,ch,`<b>Ещё действия · #${h(t.id)}</b>\n${h(compactTaskTitle(t.title))}\n\nИзменение срока проходит через согласование.`,[...rows,back]);
 }
 let next='Задача в работе.';
 const rows:ReturnType<typeof button>[][]=[];
 const control=d.controls.find(c=>['waiting','escalated'].includes(c.state)&&(c.assignee_id===u.id||u.role==='admin'));
 if(control){next='От вас ждут ответ на запрос.';rows.push([form('Ответить на запрос','answer',control.id)]);}
 if(pending){
  next=waiting?(pending.requester_id===u.id?'Ответьте на уточнение по согласованию.':'Ждём уточнения от '+name(pending.requester_id)+'.'):
   pending.route[pending.current_step]?.userId===u.id?'Рассмотрите запрос на '+(pending.type==='deadline'?'перенос срока.':'закрытие.'):'Ждём решения: '+name(pending.route[pending.current_step]?.userId??'')+'.';
  rows.push([button('Рассмотреть запрос','task_approval',extra)]);
 }else if(t.status==='active'&&canRequest(u,t)){
  if(!control)next=last?.state==='returned'?'Исправьте замечания и отправьте доработку.':'Когда работа готова — сдайте результат.';
  rows.push([form(last?.state==='returned'?'Отправить доработку':'Сдать результат','submit')]);
 }else if(t.status==='review'){
  if(!control)next=canReview(u,t)?'Проверьте результат: принять или вернуть.':'Результат сдан. Ждём приёмки.';
 }else if(t.status==='completed'&&!control)next='Результат принят. Задача завершена.';
 if(last||t.status==='review')rows.push([button(t.status==='review'&&canReview(u,t)?'Проверить результат':last?.state==='returned'?'Результат и замечания':'Результат работы','task_result',extra)]);
 const text=`<b>#${h(t.id)} · ${h(compactTaskTitle(t.title,140))}</b>\n${h(queueLabels[taskQueue(t,now)])}\n\nСрок: ${h(date(t.deadline))}${t.deadline?' МСК':''}\nИсполнитель: ${h(name(t.assignee_id))}\n\n<b>Сейчас:</b> ${h(next)}`;
 rows.push([button('Описание','task_details',extra),button('Обсуждение'+(d.comments.length?' · '+d.comments.length:''),'discussion',extra)],
  [button('Ещё действия','task_more',extra)],
  [p.list?button('← К списку',p.list.op,p.list):button('← К задачам','tasks'),button('Меню','home')]);
 return htmlScreen(u,ch,text,rows);
}
