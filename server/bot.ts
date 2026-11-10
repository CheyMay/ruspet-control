import {taskIntegration} from './bitrix-fields.js';
import {integrationLabels} from '../shared/integration-status.js';
import {lastUndo,undoLastAction} from './undo.js';
import {formatPrice,priceBand,priceLabels,parsePrice,taskPrice} from '../shared/pricing.js';
import {reportText,publicOrigin} from './report-content.js';
import {linkedText,reportLink,escapeHtml,taskLink} from '../shared/report-links.js';
import {randomBytes} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {acknowledgeAlert,userAlerts,listTaskReminders,saveTaskReminder,disableTaskReminder,reminderInput} from './reminders.js';
import {assert,canRequest,canEdit,canSee} from './domain.js';
import {bootstrap,detail,addComment,answerControl,requestApproval,decide,answerClarification,config,getReport,listReports} from './service.js';
import {canDelegateTask,delegateTask,delegationTargets,editTask,reviewTask,taskAssignees,type TaskInput} from './workflow.js';
import {actionItems,canReview} from '../shared/actions.js';
import {taskQueue} from '../shared/queues.js';
import {summarize,queueLabels} from '../shared/analytics.js';
import type {User,Task} from '../shared/types.js';
import {parseVoiceIntent} from './voice-intent.js';
export type BotScreen={replyKeyboard?:'contact'|'remove';timingKind?:'menu'|'task';format?:'HTML';document?:{reportId:string};links?:{text:string;url:string}[];text:string;buttons:{text:string;token:string}[][]};
type Payload={op:string;id?:string;page?:number;filter?:string;query?:string;kind?:string;version?:number;target?:string;step?:number;revision?:number;values?:Record<string,string>;minutes?:number};
type Field={key:string;label:string;min:number};
type Dialog={payload:Payload;fields:Field[];index:number;values:Record<string,string>};
const date=(s:string|null)=>s?new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}):'Не назначен';
function basicTaskFields(kind:string|undefined,min:number):Field[]|undefined{
 if(kind==='deadline')return [{key:'deadline',label:'Предложите новый срок',min:1},{key:'reason',label:'Почему нужен новый срок?',min},{key:'plan',label:'Что будет сделано к новому сроку?',min}];
 if(kind==='comment'||kind==='submit')return [{key:'comment',label:kind==='comment'?'Комментарий к задаче':'Опишите готовый результат',min:5}];
}
function nextMissing(d:Dialog){
 while(d.index<d.fields.length&&Object.hasOwn(d.values,d.fields[d.index].key))d.index++;
}
async function screen(u:User,ch:string,text:string,rows:{text:string;payload:Payload}[][],db:Db=pool):Promise<BotScreen>{
 const records:{token:string;payload:unknown}[]=[];
 const buttons=rows.map(row=>row.map(b=>{const token=randomBytes(18).toString('base64url');records.push({token,payload:b.payload});return {text:b.text,token}}));
 if(records.length)await db.query("INSERT INTO bot_buttons(token,actor_id,channel,payload,expires_at) SELECT token,$2,$3,payload,now()+interval '24 hours' FROM jsonb_to_recordset($1::jsonb) AS buttons(token text,payload jsonb)",[JSON.stringify(records),u.id,ch]);
 return {text,buttons};
}
const button=(text:string,op:string,extra:Partial<Payload>={})=>({text,payload:{op,...extra}});
const home=[button('📅 Срок сегодня','day'),button('📥 Ждут решения','inbox')];
export async function clearBotDraft(u:User,ch:string){await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch])})}
export async function botView(u:User,ch:string,p:Payload={op:'home'}):Promise<BotScreen>{
 const result=await renderView(u,ch,p);
 if(p.op==='home'&&process.env.PUBLIC_ORIGIN)result.links=[...(result.links||[]),{text:'Войти на сайт',url:new URL('/',process.env.PUBLIC_ORIGIN).href}];
 if(p.op==='home'||p.op==='task')result.timingKind=p.op==='home'?'menu':'task';
 return result;
}
async function renderView(u:User,ch:string,p:Payload):Promise<BotScreen>{
 if(['task','history','discussion'].includes(p.op)){
  const d=await detail(u,p.id!),t=d.task,now=new Date();
  const ids=[t.assignee_id,t.creator_id,...d.comments.map(c=>c.author_id),...d.events.map(e=>e.actor_id),...d.approvals.flatMap(a=>a.route.map((step:{userId:string})=>step.userId))];
  const people=(await pool.query('SELECT id,name FROM users WHERE id=ANY($1)',[ids])).rows;
  const name=(id:string)=>people.find(x=>x.id===id)?.name||id;
  const showPlanning=p.op==='history'&&(await config(pool)).config.showPlanning;
  if(p.op==='discussion'){
   const list=[...d.comments].reverse(),page=Math.max(0,Math.min(p.page||0,Math.max(0,list.length-1))),c=list[page];
   return screen(u,ch,`Обсуждение #${t.id} · ${list.length} сообщений\n\n${c?name(c.author_id)+' · '+date(c.created_at)+' МСК\n'+c.body.slice(0,3300):'Сообщений пока нет.'}`,[[...(page?[button('← Новее','discussion',{id:t.id,page:page-1})]:[]),...(page+1<list.length?[button('Ранее →','discussion',{id:t.id,page:page+1})]:[])],[button('Написать комментарий','form',{kind:'comment',id:t.id,target:c?.approval_id||undefined})],[button('К задаче','task',{id:t.id}),button('Меню','home')]]);
  }
  if(p.op==='history'){
   const fields:Record<string,string>={title:'Название',description:'Описание',deadline:'Срок',status:'Состояние',assignee_id:'Исполнитель',planned_start:'Плановое начало',planned_end:'Плановое окончание'};
   const undone=new Set(d.events.flatMap(e=>e.kind==='action_undone'&&Array.isArray(e.data.originalEvents)?e.data.originalEvents as string[]:[]));
   const texts=d.events.flatMap(e=>{let text=`${date(e.created_at)} МСК · ${e.actor_id?name(e.actor_id):'Система'}\n${e.message}${undone.has(e.id)?' · действие отменено':''}`;const before=e.data.before as Record<string,unknown>|undefined,after=e.data.after as Record<string,unknown>|undefined;
    if(before&&after)for(const [key,label] of Object.entries(fields).filter(([key])=>showPlanning||!key.startsWith('planned_')))if(before[key]!==after[key])text+=`\n${label}: ${String(before[key]??'—')} → ${String(after[key]??'—')}`;
    for(const key of ['reason','progress','plan','comment','body','question','answer'])if(e.data[key])text+=`\n${({reason:'Причина',progress:'Сделано',plan:'План / результат',comment:'Замечание / решение',body:'Комментарий',question:'Уточнение',answer:'Ответ'} as Record<string,string>)[key]}: ${String(e.data[key])}`;
    return Array.from({length:Math.max(1,Math.ceil(text.length/3000))},(_,i)=>text.slice(i*3000,(i+1)*3000));});
   const page=Math.max(0,Math.min(p.page||0,texts.length-1));return screen(u,ch,`История #${t.id} · ${page+1}/${Math.max(1,texts.length)}\n\n${texts[page]||'Записей пока нет.'}`,[[...(page? [button('← Ранее в списке','history',{id:t.id,page:page-1})]:[]),...(page+1<texts.length?[button('Дальше →','history',{id:t.id,page:page+1})]:[])],[button('К задаче','task',{id:t.id}),button('Меню','home')]]);
  }
  let text=`#${t.id} · ${t.title}\n${queueLabels[taskQueue(t,now)]}\nИсполнитель: ${name(t.assignee_id)}\nПостановщик: ${name(t.creator_id)}\nСрок: ${date(t.deadline)} МСК\nЦена: ${formatPrice(t)} · ${priceLabels[priceBand(t)]}\n\n${t.description.slice(0,600)||'Описание не заполнено.'}`;
  const integration=await taskIntegration(u,t.id,false);text+='\n\n'+integrationLabels[integration.state]+(integration.error?'\n'+integration.error:'')+(integration.paused?'\nОтправка приостановлена.':'');
  if(t.custom_fields?.length)text+='\n\nДополнительные поля\n'+t.custom_fields.map(f=>f.label+': '+(f.value||'—')).join('\n').slice(0,420);
  const last=d.submissions[0];if(last)text+=`\n\n${last.restored_from?'Приёмка восстановлена после отмены':'Сдача №'+last.round}: ${last.result.slice(0,500)}${last.remark?'\nЗамечание: '+last.remark.slice(0,500):''}`;
  if(t.delegated_from_id)text+='\n\nПоручение по задаче #'+t.delegated_from_id;
  const rows:ReturnType<typeof button>[][]=[];
  if(await canDelegateTask(u,t))rows.push([button('Делегировать задачу','delegate_list',{id:t.id})]);
  const pending=d.approvals.find(a=>a.state==='pending');
  const form=(label:string,kind:string,target?:string,step?:number)=>button(label,'form',{kind,id:t.id,version:t.version,target,step,revision:target===pending?.id?pending?.action_revision:undefined});
  if(t.status==='active'&&canEdit(u,t))rows.push([button('Редактировать задачу','edit',{id:t.id})]);
  rows.push([button('Напоминания по задаче','task_reminders',{id:t.id})]);
  if(pending){text+=`\n\nОжидается решение: ${name(pending.route[pending.current_step].userId)}\nПричина: ${pending.reason.slice(0,500)}\nПлан: ${pending.plan.slice(0,500)}`;if(pending.proposed_deadline)text+=`\nПредложенный крайний срок: ${date(pending.proposed_deadline)} МСК`;
   const waiting=!!pending.clarification_requested_at&&!pending.clarification_answered_at;
   if(pending.clarification_question)text+=`\n\nУточнение: ${pending.clarification_question.slice(0,500)}${pending.clarification_answer?'\nОтвет: '+pending.clarification_answer.slice(0,500):''}`;
   if(waiting&&pending.requester_id===u.id)rows.push([form('Ответить на уточнение','clarification',pending.id,pending.current_step)]);
   if(!waiting&&pending.route[pending.current_step].userId===u.id)rows.push([form('Согласовать','approve',pending.id,pending.current_step),form('Отклонить','reject',pending.id,pending.current_step)],[form('Уточнить','clarify',pending.id,pending.current_step),button('Напомнить через час','confirm',{kind:'later',id:t.id,target:pending.id,step:pending.current_step,revision:pending.action_revision,minutes:60,values:{}})]);
  }else if(t.status==='active'&&canRequest(u,t))rows.push([form(last?.state==='returned'?'Отправить доработку':'Сдать результат','submit')],[form('Предложить новый срок','deadline')]);
  else if(t.status==='review'&&canReview(u,t))rows.push([button('Принять без комментария','accept_prepare',{id:t.id,version:t.version}),form('Принять результат','accept')],[form('Вернуть с замечаниями','return')]);
  const control=d.controls.find(c=>['waiting','escalated'].includes(c.state)&&(c.assignee_id===u.id||u.role==='admin'));if(control)rows.push([form('Ответить на запрос','answer',control.id)]);
  rows.push([button('Обсуждение','discussion',{id:t.id}),form('Написать комментарий','comment',pending?.id)]);const lastAction=await lastUndo(u,t.id);if(lastAction)rows.push([button('Отменить последнее действие','undo_prepare',{id:t.id,target:lastAction.id})]);
  rows.push([button('История','history',{id:t.id}),button('Меню','home')]);return screen(u,ch,text.slice(0,4000),rows);
 }
 if(p.op==='report_pdf'){const report=await getReport(u,p.id!);return {text:'PDF · '+new Date(report.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}),buttons:[],document:{reportId:report.id}};}
 if(p.op==='reports'&&!p.id&&p.page===undefined){
  return screen(u,ch,'Отчёты\n\nСводка сейчас покажет, что требует внимания. Итоги дня покажут сделанное за день и задачи на завтра. Архив хранит снимки, которые можно открыть в PDF.',[
   [button('Сводка сейчас',u.role==='employee'?'personal_brief':'brief'),button('Итоги дня и завтра','report_evening')],
   [button('Сохранить снимок','report_now'),button('Архив отчётов','report_archive')],[button('Меню','home')]
  ]);
 }
 if(p.op==='reports'||p.op==='report_archive'){
  const page=p.page||0,report=p.id?await getReport(u,p.id):null;
  const rows:ReturnType<typeof button>[][]=[];
  if(report){const content=reportText(report);rows.push([button('PDF отчёта','report_pdf',{id:report.id})],[button('К архиву','report_archive',{page})],[button('Отчёты','reports')]);const result=await screen(u,ch,content.text.slice(0,3900),rows);return {...result,text:linkedText(content.text.length>3500?content.text.slice(0,3400)+'\nПолная сводка — в PDF и на сайте.':content.text,content.links),format:'HTML',links:[{text:'Отчёт на сайте',url:reportLink(publicOrigin(),report.id)}]};}
  const archive=await listReports(u,{page:Math.floor(page/2)});
  for(const r of archive.items.slice((page%2)*10,(page%2)*10+10))rows.push([button(date(r.summary?.to||r.created_at)+' · '+({snapshot:'Общий',daily:'Итоги и завтра',period:'За период',today:'Сегодня',overdue:'Просрочки',review:'Приёмка',nextday:'План'} as Record<string,string>)[r.kind||'snapshot'],'reports',{id:r.id,page})]);
  rows.push([...(page?[button('← Назад','report_archive',{page:page-1})]:[]),...((page+1)*10<archive.total?[button('Далее →','report_archive',{page:page+1})]:[])],[button('К отчётам','reports')]);return screen(u,ch,'Архив отчётов · '+archive.total+'\nВыберите снимок. Каждый отчёт сохраняет время и параметры.',rows);
 }
 if(p.op==='delegate_list'||p.op==='delegate_preview'){
  const {people,version,responsibility}=await delegationTargets(u,p.id!);
  const automatic=p.op==='delegate_list'&&p.filter!=='manual'&&!!responsibility.managerId;
  if(p.op==='delegate_preview'||automatic){
   const person=people.find(person=>person.id===(automatic?responsibility.managerId:p.target));
   assert(person,403,'Выберите подчинённого из доступного списка.');
   return screen(u,ch,`Создать поручение по задаче #${p.id} для ${person.name}?${automatic?'\nОтветственный компании «'+responsibility.companyName+'» · '+(responsibility.source==='bitrix'?'Битрикс24':'ОКБ'):''}\nПосле приёмки всех поручений основная задача перейдёт на приёмку.\nСрок перейдёт в копию. Цена копии — 0 ₽. Результат вернётся руководителю на приёмку.`,[
    [button('Создать поручение','confirm',{kind:'delegate',id:p.id,version,target:person.id,...(automatic?{values:{assignment:'auto',responsibilityToken:responsibility.token!}}:{})})],
    [button('Другой сотрудник','delegate_list',{id:p.id,filter:'manual'}),button('К задаче','task',{id:p.id})]
   ]);
  }
  const page=Math.max(0,Math.min(p.page||0,Math.ceil(people.length/8)-1));
  return screen(u,ch,people.length?(responsibility.reason?responsibility.reason+'\n':'')+'Кому делегировать задачу #'+p.id+'?':'В вашей области нет доступных подчинённых.',[
   ...people.slice(page*8,page*8+8).map(person=>[button(person.name,'delegate_preview',{id:p.id,target:person.id})]),
   [...(page?[button('← Назад','delegate_list',{id:p.id,page:page-1,filter:'manual'})]:[]),...((page+1)*8<people.length?[button('Далее →','delegate_list',{id:p.id,page:page+1,filter:'manual'})]:[])],
   [button('К задаче','task',{id:p.id})]
  ]);
 }
 const data=await bootstrap(u,true),now=new Date(data.serverTime),name=(id:string)=>data.users.find(x=>x.id===id)?.name||id;
 if(p.op==='search'){
  const query=(p.query||'').trim().toLocaleLowerCase('ru-RU');assert(query.length>=2&&query.length<=100,400,'Для поиска введите не менее 2 символов после /search.');
  const list=data.tasks.filter(t=>t.id.toLocaleLowerCase('ru-RU').includes(query)||t.title.toLocaleLowerCase('ru-RU').includes(query)||name(t.assignee_id).toLocaleLowerCase('ru-RU').includes(query));
  const page=Math.max(0,Math.min(p.page||0,Math.max(0,Math.ceil(list.length/6)-1))),slice=list.slice(page*6,page*6+6);
  return screen(u,ch,`Поиск: ${p.query}\nНайдено задач: ${list.length}\n\n${slice.map((t,i)=>`${i+1}. #${t.id} ${t.title.slice(0,150)}`).join('\n')||'Совпадений нет.'}\n\nСтраница ${page+1}/${Math.max(1,Math.ceil(list.length/6))}`, [...slice.map((t,i)=>[button(`${i+1}. Открыть #${t.id}`,'task',{id:t.id})]),[...(page?[button('← Назад','search',{query:p.query,page:page-1})]:[]),...(page*6+6<list.length?[button('Далее →','search',{query:p.query,page:page+1})]:[])],[button('Меню','home')]]);
 }
 if(p.op==='reminder_days'){
  await detail(u,p.id!);const selected=(p.query||'').split(',').filter(Boolean).map(Number),names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const choices=names.map((name,i)=>button((selected.includes(i+1)?'✓ ':'')+name,'reminder_days',{id:p.id,query:(selected.includes(i+1)?selected.filter(d=>d!==i+1):[...selected,i+1]).join(',')}));
  return screen(u,ch,'Выберите дни напоминания по задаче #'+p.id+' · время московское',[choices.slice(0,4),choices.slice(4),...(selected.length?[[button('Далее: время и недели','form',{id:p.id,kind:'reminder',values:{days:selected.join(',')}})]]:[]),[button('К задаче','task',{id:p.id})]]);
 }
 if(p.op==='task_reminders'){
  const state=await listTaskReminders(u,p.id!),active=state.schedules.filter(r=>r.enabled);
  return screen(u,ch,'Напоминания по задаче #'+p.id+'\n'+(active.map(r=>`${name(r.recipient_id)}: дни ${r.days.join(', ')} · ${r.times.join(', ')} МСК · ${r.weeks} нед.`).join('\n')||'Расписаний нет.')+'\nНеподтверждённые сообщения повторяются каждые 30 минут до конца дня.',[[button('Новое напоминание для меня','reminder_days',{id:p.id})],...active.map(r=>[button('Выключить: '+r.times.join(', '),'confirm',{kind:'reminder_cancel',id:p.id,target:r.id})]),[button('К задаче','task',{id:p.id}),button('Ожидают подтверждения','alerts')]]);
 }
 if(p.op==='alerts'){const alerts=(await userAlerts(u)).filter(a=>!a.acknowledged_at&&!a.canceled_at);return screen(u,ch,'Напоминания, ожидающие подтверждения: '+alerts.length, [...alerts.slice(0,15).map(a=>[button('ОК · '+(a.task_id?'#'+a.task_id:a.kind),'confirm',{kind:'alert_ack',target:a.id})]),[button('Меню','home')]]);}
 if(p.op==='edit'){const d=await detail(u,p.id!);assert(canEdit(u,d.task)&&d.task.status==='active',403,'Редактирование доступно постановщику или руководителю.');return screen(u,ch,'Редактирование #'+d.task.id+' · '+d.task.title,[[button('Название','form',{kind:'edit_title',id:p.id,version:d.task.version})],[button('Описание','form',{kind:'edit_description',id:p.id,version:d.task.version})],[button('Цена задачи','form',{kind:'edit_price',id:p.id,version:d.task.version})],[button('Исполнитель','assignee_list',{id:p.id,version:d.task.version})],[button('Крайний срок через согласование','form',{kind:'deadline',id:p.id,version:d.task.version})],[button('К задаче','task',{id:p.id})]]);}
 if(p.op==='assignee_list'){const d=await detail(u,p.id!);assert(canEdit(u,d.task),403,'Нет права редактировать задачу.');const people=await taskAssignees(u,p.id!);const page=Math.max(0,Math.min(p.page||0,Math.ceil(people.length/8)-1));return screen(u,ch,'Выберите исполнителя · страница '+(page+1),[...people.slice(page*8,page*8+8).map(person=>[button(person.name,'assignee_prepare',{id:p.id,version:d.task.version,target:person.id})]),[...(page?[button('← Назад','assignee_list',{id:p.id,page:page-1})]:[]),...((page+1)*8<people.length?[button('Далее →','assignee_list',{id:p.id,page:page+1})]:[])],[button('К задаче','task',{id:p.id})]]);}
 if(p.op==='brief'||p.op==='personal_brief'){
  assert(p.op!=='brief'||u.role!=='employee',403,'Сводка команды доступна руководителям.');
  const s=summarize(data.tasks,now),pending=data.approvals.filter(a=>a.state==='pending').length;
  const urgent=data.tasks.filter(t=>taskQueue(t,now)==='overdue').sort((a,b)=>Number(!!b.customer_risk)-Number(!!a.customer_risk)||(a.deadline||'').localeCompare(b.deadline||'')).slice(0,3);
  return screen(u,ch,`📊 РУСПЭТ · ${u.role==='employee'?'моя сводка':'сводка руководителя'}\n${date(data.serverTime)} МСК · ваша область доступа\n\nВсего задач: ${s.total}\nПросрочены ранее: ${s.overdue}\nПоследний день сегодня: ${s.today}\nСрок впереди: ${s.upcoming}\nБез срока: ${s.no_deadline}\nНа приёмке: ${s.review}\nЗавершены: ${s.completed}\n\nОтдельно: ${pending} согласований — входят в задачи выше.\n\nВ первую очередь\n${urgent.map(t=>`• #${t.id} ${t.title.slice(0,110)}\n  ${name(t.assignee_id)} · ${date(t.deadline)}`).join('\n')||'Просрочек с прошлых дней нет.'}\n\nЧек-листы и анализ невыполненных задач исключены. Это текущая сводка; сохранённые снимки — в архиве.`,[[button('Просрочены · '+s.overdue,'report_queue',{filter:'overdue'}),button('Сегодня · '+s.today,'report_queue',{filter:'today'})],[button('На приёмке · '+s.review,'report_queue',{filter:'review'}),button('Нужно действие','inbox')],[button('Обновить сводку',p.op),button('Архив отчётов','report_archive')],...urgent.map(t=>[button('Открыть #'+t.id,'task',{id:t.id})]),[button('В меню','home')]]);
 }
 if(p.op==='report_now'||p.op==='report_evening'){const report=await (await import('./service.js')).makeReport(u,p.op==='report_now'?'snapshot':'daily','bot:'+randomBytes(12).toString('hex'));return botView(u,ch,{op:'reports',id:report.id});}
 if(['inbox','tasks','day','report_queue'].includes(p.op)){
  const actions=actionItems(data).filter(a=>a.mine);const list=p.op==='inbox'?actions.map(a=>({id:a.taskId,label:a.label+' · '+a.title})):data.tasks.filter(t=>(p.op==='report_queue'?taskQueue(t,now)===p.filter:(t.assignee_id===u.id||u.role!=='employee')&&(p.op==='tasks'||taskQueue(t,now)==='today'))).map(t=>({id:t.id,label:t.title}));
  const page=Math.max(0,Math.min(p.page||0,Math.max(0,Math.ceil(list.length/6)-1))),slice=list.slice(page*6,page*6+6);
  return screen(u,ch,`${p.op==='inbox'?'Нужно ваше действие':p.op==='day'?'Последний день сегодня':p.op==='report_queue'?queueLabels[p.filter as keyof typeof queueLabels]||'Выборка':'Доступные задачи'} · ${list.length}\n${slice.map((t,i)=>`${i+1}. #${t.id} ${t.label.slice(0,180)}`).join('\n\n')||'Список пуст.'}\n\nСтраница ${page+1}/${Math.max(1,Math.ceil(list.length/6))}`, [...slice.map((t,i)=>[button(`${i+1}. Открыть #${t.id}`,'task',{id:t.id})]),[...(page?[button('← Назад',p.op,{page:page-1,filter:p.filter})]:[]),...(page*6+6<list.length?[button('Далее →',p.op,{page:page+1,filter:p.filter})]:[])],home,[button('Все задачи','tasks'),button('Меню','home')]]);
 }
 const s=summarize(data.tasks,now),actions=actionItems(data).filter(a=>a.mine).length,last=await lastUndo(u);
 return screen(u,ch,`РУСПЭТ · ${u.role==='employee'?'Мои задачи':'Пульт руководителя'}\n${u.name}\n\n📥 Ждут вашего действия: ${actions}\n\nВсего доступно: ${s.total}\nПросрочены ранее: ${s.overdue}\nСрок сегодня: ${s.today}\nНа приёмке: ${s.review}\n\nНачните с «Ждут решения» — там ответы, приёмка и согласования. Откройте задачу, чтобы увидеть историю или отправить результат.\n\nПЭТ-преформы · крышки · упаковка\nБитрикс24 пока не подключён.`,[home,...(last?[[button('Отменить последнее действие','undo_prepare',{id:last.task_id,target:last.id})]]:[]),[button('🔔 Напоминания','alerts')],[button(u.role==='employee'?'Мои задачи':'Задачи команды','tasks')],[button('📁 Отчёты','reports')],...(u.role!=='employee'?[[button('📊 Сводка команды','brief')]]:[])]);
}
export function parseMoscowInput(value:string){const match=value.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);assert(match,400,'Введите дату в формате ДД.ММ.ГГГГ ЧЧ:ММ, время московское.');const [,d,m,y,h,min]=match,raw=`${y}-${m}-${d}T${h}:${min}:00+03:00`,date=new Date(raw);assert(!isNaN(date.getTime())&&new Date(date.getTime()+10800000).toISOString().slice(0,16)===`${y}-${m}-${d}T${h}:${min}`,400,'Такой даты или времени нет.');assert(date>new Date(),400,'Новый срок должен быть в будущем.');return date.toISOString();}
async function prompt(u:User,ch:string,d:Dialog,db:Db){const f=d.fields[d.index];return screen(u,ch,`Задача #${d.payload.id}\nШаг ${d.index+1}/${d.fields.length}\n\n${f.label}\n${f.key==='deadline'?'Формат: ДД.ММ.ГГГГ ЧЧ:ММ · Москва':`Минимум ${f.min} символов. Можно указать ссылку на материалы.`}`,[[button('Отменить ввод','cancel')]],db)}
function draftSummary(d:Dialog){
 return (d.payload.kind==='reminder'?'Дни недели (1=Пн, 7=Вс): '+d.values.days+'\n\n':'')+
  d.fields.filter(f=>Object.hasOwn(d.values,f.key)).map(f=>f.label+'\n'+(f.key==='deadline'?date(d.values[f.key])+' МСК':d.values[f.key]||'Без комментария')).join('\n\n');
}
async function confirmation(u:User,ch:string,d:Dialog,db:Db,heading=`Проверьте перед отправкой · #${d.payload.id}`){
 const summary=draftSummary(d);
 const restart=d.payload.kind==='accept'&&d.fields.length===0?button('К задаче','task',{id:d.payload.id}):button('Ввести заново','form',{...d.payload,values:undefined});
 return screen(u,ch,`${heading}\n\n${summary.length>3200?summary.slice(0,3200)+'\n… Введённые ответы сохранены полностью.':summary}`,[
  [button('Подтвердить и отправить','confirm',{...d.payload,op:'confirm',values:d.values})],[restart,button('Отмена','cancel')]
 ],db);
}

export async function savedVoiceDraft(u:User,ch:string,inputId:string,db:Db=pool){
 return (await db.query('SELECT screen FROM bot_inputs WHERE actor_id=$1 AND channel=$2 AND input_id=$3',[u.id,ch,'voice:'+inputId])).rows[0]?.screen as BotScreen|undefined;
}
export async function botVoiceDraft(u:User,ch:string,transcript:string,inputId:string,at=new Date()):Promise<BotScreen>{
 const intent=transcript.length<=2600?parseVoiceIntent(transcript,at):null;
 if(!intent)return screen(u,ch,`Распознал: ${transcript.slice(0,600)}\n\nНачните с действия и номера задачи. Например: «Добавь комментарий к задаче 2406: клиент подтвердил образцы».`,[[button('Мои задачи','tasks'),button('Меню','home')]]);
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);
  const cached=await savedVoiceDraft(u,ch,inputId,db);if(cached)return cached;
  const {id,kind}=intent;
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];
  assert(task&&canSee(u,task),404,'Задача не найдена или недоступна. Проверьте её номер в «Мои задачи».');
  if(kind==='submit'||kind==='deadline')assert(canRequest(u,task)&&task.status!=='completed'&&(kind!=='submit'||task.status==='active'),409,'Это действие недоступно в текущем состоянии задачи.');
  if(kind==='accept')assert(task.status==='review'&&canReview(u,task),409,'Результат не ожидает вашей приёмки.');
  if(kind!=='comment')assert(!(await db.query("SELECT 1 FROM approvals WHERE task_id=$1 AND state='pending'",[id])).rowCount,409,'Сначала завершите активное согласование по этой задаче.');
  const fields=basicTaskFields(kind,(await config(db)).config.responseMinLength)??(intent.values.comment?[{key:'comment',label:'Комментарий к приёмке',min:0}]:[]);
  const values:Record<string,string>={};
  for(const field of fields){
   const value=intent.values[field.key];
   if(!value||value.length<field.min)continue;
   if(field.key==='deadline'){try{values.deadline=parseMoscowInput(value);}catch{/* Ask for a valid date. */}}
   else values[field.key]=value;
  }
  const payload:Payload={op:'form',id,kind,version:task.version};
  const draft={payload,fields,index:0,values};nextMissing(draft);
  const labels={comment:'Добавить комментарий',submit:'Передать результат на приёмку',deadline:'Запросить перенос срока',accept:'Принять результат'};
  const heading=`${labels[kind]} · #${id}\n${task.title.slice(0,200)}`;
  const missing=fields.filter(field=>!Object.hasOwn(values,field.key));
  const response=missing.length?await screen(u,ch,`${heading}\n\n${draftSummary(draft)}\nУточните: ${missing.map(field=>field.label).join(' · ')}`,[
   [button('Уточнить и продолжить','form',{...payload,values})],[button('К задаче','task',{id})]
  ],db):await confirmation(u,ch,draft,db,heading);
  await db.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4)',[u.id,ch,'voice:'+inputId,JSON.stringify(response)]);
  return response;
 });
}
export async function botClick(u:User,ch:string,token:string):Promise<BotScreen>{
 const b=(await pool.query('SELECT * FROM bot_buttons WHERE token=$1 AND actor_id=$2 AND channel=$3 AND expires_at>now()',[token,u.id,ch])).rows[0];assert(b,409,'Кнопка устарела. Откройте меню заново.');const p=b.payload as Payload;
 if(!['form','confirm','cancel','accept_prepare','assignee_prepare','undo_prepare'].includes(p.op)){await clearBotDraft(u,ch);return botView(u,ch,p)}
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);
  const record=(await db.query('SELECT * FROM bot_buttons WHERE token=$1 FOR UPDATE',[token])).rows[0];if(record.receipt)return record.receipt as BotScreen;assert(!record.revoked,409,'Этот ввод отменён или заменён новым. Откройте актуальную задачу.');
  if(p.op==='cancel'||p.op==='form')await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch]);
  if(p.op==='cancel'){await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);return screen(u,ch,'Ввод отменён. Изменения не отправлены.',[[button('Меню','home')]],db)}
  if(p.op==='assignee_prepare'){const d=await detail(u,p.id!);assert(canEdit(u,d.task),403,'Нет права редактировать задачу.');const person=(await db.query('SELECT name FROM users WHERE id=$1',[p.target])).rows[0];assert(person,400,'Исполнитель не найден.');return screen(u,ch,'Назначить исполнителем: '+person.name+'?',[[button('Указать причину','form',{kind:'edit_assignee',id:p.id,version:p.version,target:p.target})],[button('Отмена','cancel')]],db);}
  if(p.op==='accept_prepare')return screen(u,ch,`Принять результат по задаче #${p.id} без комментария?`,[[button('Да, принять результат','confirm',{kind:'accept',id:p.id,version:p.version,values:{comment:''}})],[button('Отмена','cancel')]],db);
  if(p.op==='undo_prepare'){const last=await lastUndo(u,undefined,db);assert(last&&last.id===p.target,409,'Отмена недоступна: действие изменилось или прошло пять минут.');return screen(u,ch,`Отменить «${last.label}» по задаче #${last.task_id}? История сохранится, участники получат уточнение.`,[[button('Да, отменить действие','confirm',{kind:'undo',id:last.task_id,target:last.id})],[button('Оставить действие','cancel')]],db);}
  if(p.op==='form'){
   const min=(await config(db)).config.responseMinLength;
   if(p.kind?.startsWith('edit_')){const d=await detail(u,p.id!);assert(canEdit(u,d.task),403,'Нет права редактировать задачу.');}
   const fields:Field[]=basicTaskFields(p.kind,min)??(p.kind==='edit_price'?[{key:'price',label:'Цена задачи в рублях (обязательное поле)',min:1},{key:'reason',label:'Причина изменения цены',min:5}]:p.kind==='reminder'?[{key:'times',label:'Время напоминания: ЧЧ:ММ, можно несколько через запятую. Например: 09:00, 15:30. Не более 8 времён.',min:5},{key:'weeks',label:'Сколько недель повторять? Число от 1 до 52. Для одного недельного цикла введите 1.',min:1}]:p.kind==='edit_title'?[{key:'value',label:'Новое название задачи',min:3},{key:'reason',label:'Причина изменения',min:5}]:p.kind==='edit_description'?[{key:'value',label:'Новое описание задачи',min:1},{key:'reason',label:'Причина изменения',min:5}]:p.kind==='edit_assignee'?[{key:'reason',label:'Почему меняется исполнитель?',min:5}]:p.kind==='answer'?[{key:'reason',label:'Что помешало выполнить задачу?',min},{key:'progress',label:'Что уже сделано?',min},{key:'plan',label:'Что будете делать дальше?',min}]:p.kind==='clarification'?[{key:'answer',label:'Ответьте на вопрос согласующего',min:5}]:[{key:'comment',label:p.kind==='return'?'Что конкретно нужно исправить?':p.kind==='reject'?'Почему запрос отклонён?':p.kind==='clarify'?'Что нужно уточнить?':'Комментарий к решению',min:5}]);
   const d:Dialog={payload:p,fields,index:0,values:p.values||{}};nextMissing(d);if(d.index===d.fields.length)return confirmation(u,ch,d,db);await db.query("INSERT INTO bot_sessions(actor_id,channel,data,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT(actor_id,channel) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",[u.id,ch,JSON.stringify(d)]);return prompt(u,ch,d,db);
  }
  const v=p.values||{};let result='Действие сохранено.',resultTask:string|undefined;
  if(p.kind==='undo'){await undoLastAction(u,p.target!);result='Действие отменено. Исходная запись и отмена сохранены в истории.'}
  else if(p.kind==='delegate'){const copy=await delegateTask(u,p.id!,{...(p.values?.assignment==='auto'?{responsibilityToken:p.values.responsibilityToken}:{assigneeId:p.target!}),expectedVersion:p.version!});resultTask=copy.id;result='Поручение #'+copy.id+' создано. Результат вернётся руководителю на приёмку.';}
  else if(p.kind==='comment'){await addComment(u,p.id!,v.comment,p.target);result='Комментарий сохранён в обсуждении задачи и доступен руководителю.'}
  else if(p.kind==='reminder'){await saveTaskReminder(u,p.id!,{recipientId:u.id,days:v.days.split(',').map(Number),times:v.times.split(',').map(s=>s.trim()),weeks:Number(v.weeks)});result='Напоминание сохранено. Время московское. Для доставки привяжите свой чат в панели.'}
  else if(p.kind==='reminder_cancel'){await disableTaskReminder(u,p.target!);result='Расписание выключено.'}
  else if(p.kind==='alert_ack'){await acknowledgeAlert(u,p.target!);result='ОК, получение напоминания подтверждено. Это не завершает задачу.'}
  else if(p.kind?.startsWith('edit_')){const d=await detail(u,p.id!),t=d.task;const input:TaskInput={title:t.title,description:t.description,assigneeId:t.assignee_id,deadline:t.deadline,plannedStart:t.planned_start||null,plannedEnd:t.planned_end,important:t.important,customerRisk:t.customer_risk,parentId:t.parent_id||null};if(p.kind==='edit_title'){assert(v.value.length<=500,400,'Название не длиннее 500 символов.');input.title=v.value;}else if(p.kind==='edit_description')input.description=v.value;else if(p.kind==='edit_price'){const price=parsePrice(v.price);assert(price!==null,400,'Укажите корректную цену в рублях.');input.price=price;}else input.assigneeId=p.target!;await editTask(u,t.id,input,p.version!,v.reason);result='Изменение сохранено в задаче и истории.'}
  else if(p.kind==='answer'){await answerControl(u,p.target!,{reason:v.reason,progress:v.progress,plan:v.plan});result='Ответ сохранён и доступен руководителю.'}
  else if(p.kind==='deadline'){await requestApproval(u,p.id!,{type:'deadline',reason:v.reason,plan:v.plan,proposedDeadline:v.deadline,expectedVersion:p.version!});result='Новый срок предложен. Текущий крайний срок изменится после согласования.'}
  else if(p.kind==='clarification'){await answerClarification(u,p.target!,v.answer);result='Ответ отправлен согласующему. Этап ожидает его решения.'}
  else if(['approve','reject','later','clarify'].includes(p.kind!)){const r=await decide(u,p.target!,{decision:p.kind as 'approve'|'reject'|'later'|'clarify',comment:v.comment||'',expectedStep:p.step,expectedRevision:p.revision,remindMinutes:p.minutes});result=r.state==='stale'?'Задача изменилась. Нужен новый запрос.':p.kind==='clarify'?'Вопрос отправлен автору запроса.':p.kind==='later'?'Напоминание назначено через час.':r.state==='pending'?'Ваш этап согласован. Запрос передан следующему руководителю.':p.kind==='reject'?'Запрос отклонён. Причина сохранена.':'Согласование завершено.'}
  else{await reviewTask(u,p.id!,p.kind as 'submit'|'accept'|'return',v.comment||'',p.version!);result=p.kind==='submit'?'Результат передан на приёмку. Ожидается решение руководителя.':p.kind==='return'?'Задача возвращена. Замечания сохранены для исполнителя.':'Результат принят. Задача завершена.'}
  const undo=await lastUndo(u,undefined,db);
  if(p.id&&(await db.query("SELECT 1 FROM bitrix_operations WHERE task_id=$1 AND payload->>'actorId'=$2 AND created_at>=transaction_timestamp() AND state='pending' LIMIT 1",[p.id,u.id])).rowCount)result+='\n\nДействие сохранено в РУСПЭТ. Обмен с Битрикс24 выполняется по очереди; состояние видно в карточке задачи.';
  if(resultTask)result+='\nПоручение создано локально: автоматическое создание задач в Битрикс24 пока не включено.';
  const response=await screen(u,ch,result,[...(resultTask?[[button('Открыть поручение','task',{id:resultTask})]]:[]),[...(p.id?[button('К задаче','task',{id:p.id})]:[]),button('Нужно действие','inbox')],...(undo?[[button('Отменить последнее действие','undo_prepare',{id:undo.task_id,target:undo.id})]]:[])],db);
  await db.query('UPDATE bot_buttons SET receipt=$2 WHERE token=$1',[token,JSON.stringify(response)]);await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);return response;
 });
}
export async function botText(u:User,ch:string,text:string,inputId:string):Promise<BotScreen>{
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);const old=(await db.query('SELECT screen FROM bot_inputs WHERE actor_id=$1 AND channel=$2 AND input_id=$3',[u.id,ch,inputId])).rows[0];if(old)return old.screen;
  const row=(await db.query('SELECT * FROM bot_sessions WHERE actor_id=$1 AND channel=$2 AND expires_at>now() FOR UPDATE',[u.id,ch])).rows[0];assert(row,400,'Сначала откройте задачу и выберите действие. Для поиска используйте /task НОМЕР.');const d=row.data as Dialog,f=d.fields[d.index];assert(text.trim().length>=f.min&&text.length<=4000,400,`Ответ: от ${f.min} до 4000 символов.`);
  if(f.key==='price')assert(parsePrice(text)!==null,400,'Цена: неотрицательное число, не более двух знаков после запятой.');
  if(f.key==='times')assert(reminderInput.shape.times.safeParse(text.split(',').map(s=>s.trim())).success,400,'Время: ЧЧ:ММ, до 8 различных времён через запятую.');
  if(f.key==='weeks')assert(/^\d{1,2}$/.test(text.trim())&&Number(text)>=1&&Number(text)<=52,400,'Введите число недель от 1 до 52.');
  d.values[f.key]=f.key==='deadline'?parseMoscowInput(text.trim()):text.trim();d.index++;nextMissing(d);
  let response:BotScreen;if(d.index<d.fields.length){await db.query('UPDATE bot_sessions SET data=$3 WHERE actor_id=$1 AND channel=$2',[u.id,ch,JSON.stringify(d)]);response=await prompt(u,ch,d,db)}else{
   // The draft is now immutable and bound to a one-time confirmation button.
   await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);response=await confirmation(u,ch,d,db);
  }
  await db.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4)',[u.id,ch,inputId,JSON.stringify(response)]);return response;
 });
}

export async function alertScreen(u:User,ch:string,alert:{id:string;task_id:string|null;body:string;links?:{text:string;url:string}[];report_id?:string|null}):Promise<BotScreen>{const result=await screen(u,ch,alert.body,[[button('ОК, увидел','confirm',{kind:'alert_ack',target:alert.id,id:alert.task_id||undefined})],...(alert.task_id?[[button('Открыть задачу','task',{id:alert.task_id}),button('Новое напоминание','reminder_days',{id:alert.task_id})]]:[]),...(alert.report_id?[[button('Открыть отчёт','reports',{id:alert.report_id}),button('PDF','report_pdf',{id:alert.report_id})]]:[]),[button('Мои задачи','tasks')]]);return {...result,text:linkedText(alert.body,alert.links||[]),format:'HTML'};}
