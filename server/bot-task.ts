import {button,htmlScreen,date,type Payload} from './bot-ui.js';
import {botExcerpt,botTaskStatus,botTextPages} from './bot-presentation.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {escapeHtml as h} from '../shared/report-links.js';
import {formatPrice,priceBand,priceLabels} from '../shared/pricing.js';
import {canRequest} from './domain.js';
import {canReview} from '../shared/actions.js';
import {detail,config} from './service.js';
import {canDelegateTask} from './workflow.js';
import {lastUndo} from './undo.js';
import {taskIntegration} from './bitrix-fields.js';
import {integrationLabels} from '../shared/integration-status.js';
import {pool} from './db.js';
import type {User} from '../shared/types.js';

export async function renderBotTask(u:User,ch:string,p:Payload){
 const d=await detail(u,p.id!),t=d.task,now=new Date();
 const pending=d.approvals.find(a=>a.state==='pending'),last=d.submissions[0];
 const {canEdit,canRequest:canRequestEdit,canDecide,request}=d.editAccess;
 const approver=pending?.route[pending.current_step];
 const ids=[t.assignee_id,t.creator_id,...(pending?[pending.requester_id,approver?.userId]:[]),
  ...(p.op==='discussion'?d.comments.map(c=>c.author_id):[]),...(p.op==='history'?d.events.map(e=>e.actor_id):[])].filter(Boolean);
 const people=(await pool.query('SELECT id,name FROM users WHERE id=ANY($1)',[ids])).rows;
 const name=(id:string)=>people.find(x=>x.id===id)?.name||id;
 const extra={id:t.id,list:p.list},back=[button('← К задаче','task',extra),button('Меню','home')];
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
 if(p.op==='task_edit_permission'){
  const labels={pending:'Ожидает решения',approved:'Разрешено одно сохранение',rejected:'Отклонено',used:'Использовано'};
  const rows:ReturnType<typeof button>[][]=[];
  if(canDecide&&request)rows.push([form('Разрешить','permission_approve',request.id),form('Отклонить','permission_reject',request.id)]);
  if(canRequestEdit)rows.push([form('Запросить разрешение','permission_request')]);
  if(canEdit&&request?.state==='approved')rows.push([button('Редактировать задачу','edit',extra)]);
  return paged('Разрешение на редактирование',request?
   labels[request.state]+' · '+name(request.requesterId)+'\n\n'+request.reason+(request.decisionComment?'\n\n'+request.decisionComment:''):
   canRequestEdit?'Укажите, что нужно изменить. Запрос получит постановщик задачи.':'Активного запроса нет.',rows);
 }
 if(p.op==='task_details')return paged('Описание',t.title+'\n\n'+(t.description||'Описание пока не заполнено.'),[[button('Поля задачи','task_fields',extra)]]);
 if(p.op==='task_fields'){
  const showPlanning=(await config(pool)).config.showPlanning;
  const integration=await taskIntegration(u,t.id,false);
  const lines=['Исполнитель: '+name(t.assignee_id),'Постановщик: '+name(t.creator_id),'Крайний срок: '+date(t.deadline)+(t.deadline?' МСК':''),
   'Цена: '+formatPrice(t)+' · '+priceLabels[priceBand(t)],'Переносов срока: '+t.transfer_count,
   integrationLabels[integration.state],...(integration.error?[integration.error]:[]),
   ...(showPlanning?['Плановое начало: '+date(t.planned_start??null),'Плановое окончание: '+date(t.planned_end)]:[]),
   ...(t.delegated_from_id?['Поручение по задаче #'+t.delegated_from_id]:[]),
   ...(t.custom_fields?.length?['','Дополнительные поля',...t.custom_fields.map(f=>f.label+': '+(f.value||'—'))]:[])];
  return paged('Поля задачи',lines.join('\n'),[[button('Описание','task_details',extra)]]);
 }
 if(p.op==='task_result')return paged('Результат работы',last?
  `Сдача №${last.round}${last.restored_from?' · восстановлена после отмены':''}\n${date(last.submitted_at)} МСК\n\n${last.result}${last.remark?'\n\nЗамечания:\n'+last.remark:''}`:'Результат ещё не сдавали.',reviewRows);
 if(p.op==='task_approval')return paged('Согласование',pending?
  `Запрос: ${pending.type==='deadline'?'перенос срока':'закрытие задачи'}\nЭтап ${pending.current_step+1} из ${pending.route.length}\nАвтор: ${name(pending.requester_id)}\n${waiting?'Ждём уточнения от: '+name(pending.requester_id):'Решение за: '+name(approver?.userId??'')}\nТекущий крайний срок: ${date(t.deadline)}${pending.proposed_deadline?'\nПредложенный крайний срок: '+date(pending.proposed_deadline):''}\n\nПричина:\n${pending.reason}\n\nПлан:\n${pending.plan}${pending.clarification_question?'\n\nВопрос:\n'+pending.clarification_question:''}${pending.clarification_answer?'\n\nОтвет:\n'+pending.clarification_answer:''}`:'Текущих согласований нет.',approvalRows);
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
  if(canEdit)rows.push([button('Редактировать задачу','edit',extra)]);
  if(canRequestEdit||request)rows.push([button(request?'Разрешение на редактирование':'Запросить редактирование','task_edit_permission',extra)]);
  if(!pending&&t.status==='active'&&canRequest(u,t))rows.push([form('Предложить новый срок','deadline')]);
  if(await canDelegateTask(u,t))rows.push([button('Делегировать задачу','delegate_list',extra)]);
  rows.push([button('Напоминания','task_reminders',extra)],[button('История','history',extra),button('Поля задачи','task_fields',extra)]);
  const lastAction=await lastUndo(u,t.id);if(lastAction)rows.push([button('Отменить последнее действие','undo_prepare',{...extra,target:lastAction.id})]);
  return htmlScreen(u,ch,`<b>Ещё действия · #${h(t.id)}</b>\n${h(compactTaskTitle(t.title))}`,[...rows,back]);
 }
 const context:string[]=[];
 const rows:ReturnType<typeof button>[][]=[];
 const control=d.controls.find(c=>['waiting','escalated'].includes(c.state)&&(c.assignee_id===u.id||u.role==='admin'));
 if(control){context.push('От вас ждут ответ на запрос');rows.push([form('Ответить на запрос','answer',control.id)]);}
 if(canDecide||request?.state==='approved'&&request.requesterId===u.id)
  rows.push([button(canDecide?'Решить запрос на редактирование':'Редактировать задачу',canDecide?'task_edit_permission':'edit',extra)]);
 if(pending){
  const participant=waiting?pending.requester_id:approver?.userId;
  const mine=participant===u.id;
  if(participant)context.push(waiting?(mine?'От вас ждут уточнение':'Уточнение запрошено у '+name(participant)):'Решение за '+(mine?'вами':name(participant)));
  rows.push([button(mine?(waiting?'Ответить на уточнение':'Рассмотреть запрос'):'Посмотреть согласование','task_approval',extra)]);
 }else if(t.status==='active'&&canRequest(u,t)){
  if(last?.state==='returned')context.push('Есть замечания к результату');
  rows.push([form(last?.state==='returned'?'Отправить доработку':'Сдать результат','submit')]);
 }
 if(last||t.status==='review')rows.push([button(t.status==='review'&&canReview(u,t)?'Проверить результат':last?.state==='returned'?'Результат и замечания':'Результат работы','task_result',extra)]);
 const status=botTaskStatus(t,now,!!pending),facts:string[]=[];
 if(t.status==='completed'&&t.completed_at)facts.push('Закрыта '+date(t.completed_at)+' МСК');
 if(t.status!=='completed')facts.push(t.deadline?'Крайний срок '+date(t.deadline)+' МСК':'Без крайнего срока');
 facts.push(t.assignee_id===u.id?'Вы исполнитель':'Исполнитель · '+name(t.assignee_id));
 const preview=botExcerpt(t.description,155);
 const text=[
  `<b>${h(compactTaskTitle(t.title,110))}</b>\n#${h(t.id)} · <b>${h(status)}</b>${t.important?' · Важно':''}`,
  h(facts.join('\n')),
  ...(context.length?[h(context.join('\n'))]:[]),
  ...(preview&&preview!==botExcerpt(t.title,155)?[h(preview)]:[])
 ].join('\n\n');
 rows.push([button('Описание','task_details',extra),button('Обсуждение'+(d.comments.length?' · '+d.comments.length:''),'discussion',extra)],
  [button('Ещё действия','task_more',extra)],
  [p.list?button('← К списку',p.list.op,p.list):button('← К задачам','tasks'),button('Меню','home')]);
 return htmlScreen(u,ch,text,rows);
}
