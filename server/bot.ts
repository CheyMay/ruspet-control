import {canEditTaskData} from '../shared/task-permissions.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {button,screen,date,type BotScreen,type Payload} from './bot-ui.js';
import {renderBotTask} from './bot-task.js';
import {renderBotNavigation} from './bot-navigation.js';
import {queueBitrixOperation} from './bitrix-operations.js';
import {lastUndo,undoLastAction} from './undo.js';
import {parsePrice} from '../shared/pricing.js';
import {reportText,publicOrigin} from './report-content.js';
import {linkedText,reportLink} from '../shared/report-links.js';
import {randomBytes} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {acknowledgeAlert,userAlerts,listTaskReminders,saveTaskReminder,disableTaskReminder,reminderInput} from './reminders.js';
import {assert,canRequest} from './domain.js';
import {bootstrap,detail,addComment,answerControl,requestApproval,decide,answerClarification,config,getReport,listReports} from './service.js';
import {delegateTask,delegationTargets,editTask,reviewTask,taskAssignees,type TaskInput} from './workflow.js';
import {taskQueue} from '../shared/queues.js';
import {summarize} from '../shared/analytics.js';
import type {User} from '../shared/types.js';
export type {BotScreen} from './bot-ui.js';
type Field={key:string;label:string;min:number};
type Dialog={payload:Payload;fields:Field[];index:number;values:Record<string,string>};
export async function clearBotDraft(u:User,ch:string){await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch])})}
export async function botView(u:User,ch:string,p:Payload={op:'home'}):Promise<BotScreen>{
 const result=await renderView(u,ch,p);
 if(p.op==='home'||p.op==='task')result.timingKind=p.op==='home'?'menu':'task';
 return result;
}
async function renderView(u:User,ch:string,p:Payload):Promise<BotScreen>{
 if(['home','tasks','inbox','day','search','search_prompt','menu_more','help'].includes(p.op))return renderBotNavigation(u,ch,p);
 if(p.op==='bitrix_content'){
  const {task}=await detail(u,p.id!);
  const sections=(await pool.query('SELECT kind,snapshot,revision FROM bitrix_task_content WHERE task_id=$1',[task.id])).rows;
  const list=sections.find(s=>s.kind==='checklist'),files=sections.find(s=>s.kind==='files'),results=sections.find(s=>s.kind==='results');
  const lines=[`Данные Битрикс24 · #${task.id}`,'','Чек-листы',...(list?.snapshot??[]).map((item:any)=>(item.IS_COMPLETE==='Y'?'✓ ':'□ ')+item.TITLE),'','Файлы',...(files?.snapshot??[]).map((file:any)=>file.NAME||'Файл'),'','Результаты',...(results?.snapshot??[]).map((result:any)=>result.text||'')];
  const text=lines.join('\n'),pages=Math.max(1,Math.ceil(text.length/3000)),page=Math.max(0,Math.min(p.page??0,pages-1));
  const rows:ReturnType<typeof button>[][]=[];
  if(list&&(canRequest(u,task)||task.accomplice_ids?.includes(u.id)))for(const item of list.snapshot.slice(page*8,page*8+8))rows.push([button((item.IS_COMPLETE==='Y'?'Вернуть в работу: ':'Выполнено: ')+String(item.TITLE).slice(0,45),'confirm',{kind:'checklist',id:task.id,list:p.list,target:String(item.ID),revision:list.revision,values:{complete:item.IS_COMPLETE==='Y'?'N':'Y'}})]);
  rows.push([...(page?[button('← Назад','bitrix_content',{id:task.id,list:p.list,page:page-1})]:[]),...(page+1<pages?[button('Далее →','bitrix_content',{id:task.id,list:p.list,page:page+1})]:[])],[button('К задаче','task',{id:task.id,list:p.list})]);
  return screen(u,ch,text.slice(page*3000,(page+1)*3000),rows);
 }
 if(['task','history','discussion','task_details','task_result','task_approval','task_more'].includes(p.op))return renderBotTask(u,ch,p);
 if(p.op==='report_pdf'){const report=await getReport(u,p.id!);return {text:'PDF · '+new Date(report.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}),buttons:[],document:{reportId:report.id}};}
 if(p.op==='reports'){
  const page=p.page||0,report=p.id?await getReport(u,p.id):null;
  const rows:ReturnType<typeof button>[][]=[];
  if(report){const content=reportText(report);rows.push([button('PDF отчёта','report_pdf',{id:report.id})],[button('К архиву','reports',{page})],[button('Меню','home')]);const result=await screen(u,ch,content.text.slice(0,3900),rows);return {...result,text:linkedText(content.text.length>3500?content.text.slice(0,3400)+'\nПолная сводка — в PDF и на сайте.':content.text,content.links),format:'HTML',links:[{text:'Отчёт на сайте',url:reportLink(publicOrigin(),report.id)}]};}
  const archive=await listReports(u,{page:Math.floor(page/2)});
  for(const r of archive.items.slice((page%2)*10,(page%2)*10+10))rows.push([button(date(r.summary?.to||r.created_at)+' · '+({snapshot:'Общий',daily:'Итоги и завтра',period:'За период',today:'Сегодня',overdue:'Просрочки',review:'Приёмка',nextday:'План'} as Record<string,string>)[r.kind||'snapshot'],'reports',{id:r.id,page})]);
  rows.push([...(page?[button('← Назад','reports',{page:page-1})]:[]),...((page+1)*10<archive.total?[button('Далее →','reports',{page:page+1})]:[])],[button('Общий отчёт сейчас','report_now')],[button('Итоги дня и завтра','report_evening')],[button('Меню','home')]);return screen(u,ch,'Отчёты · '+archive.total+'\nВыберите снимок или сформируйте новый. Каждый отчёт сохраняет время и параметры.',rows);
 }
 if(p.op==='delegate_list'||p.op==='delegate_preview'){
  const {people,version}=await delegationTargets(u,p.id!);
  if(p.op==='delegate_preview'){
   const person=people.find(person=>person.id===p.target);
   assert(person,403,'Выберите подчинённого из доступного списка.');
   return screen(u,ch,`Создать поручение по задаче #${p.id} для ${person.name}?\nСрок перейдёт в копию. Цена копии — 0 ₽. Результат вернётся руководителю на приёмку.`,[
    [button('Создать поручение','confirm',{kind:'delegate',id:p.id,list:p.list,version,target:person.id})],
    [button('Другой сотрудник','delegate_list',{id:p.id,list:p.list}),button('К задаче','task',{id:p.id,list:p.list})]
   ]);
  }
  const page=Math.max(0,Math.min(p.page||0,Math.ceil(people.length/8)-1));
  return screen(u,ch,people.length?'Кому делегировать задачу #'+p.id+'?':'В вашей области нет доступных подчинённых.',[
   ...people.slice(page*8,page*8+8).map(person=>[button(person.name,'delegate_preview',{id:p.id,list:p.list,target:person.id})]),
   [...(page?[button('← Назад','delegate_list',{id:p.id,list:p.list,page:page-1})]:[]),...((page+1)*8<people.length?[button('Далее →','delegate_list',{id:p.id,list:p.list,page:page+1})]:[])],
   [button('К задаче','task',{id:p.id,list:p.list})]
  ]);
 }
 const data=await bootstrap(u,true),now=new Date(data.serverTime),name=(id:string)=>data.users.find(x=>x.id===id)?.name||id;
 if(p.op==='reminder_days'){
  await detail(u,p.id!);const selected=(p.query||'').split(',').filter(Boolean).map(Number),names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const choices=names.map((name,i)=>button((selected.includes(i+1)?'✓ ':'')+name,'reminder_days',{id:p.id,list:p.list,query:(selected.includes(i+1)?selected.filter(d=>d!==i+1):[...selected,i+1]).join(',')}));
  return screen(u,ch,'Выберите дни напоминания по задаче #'+p.id+' · время московское',[choices.slice(0,4),choices.slice(4),...(selected.length?[[button('Далее: время и недели','form',{id:p.id,list:p.list,kind:'reminder',values:{days:selected.join(',')}})]]:[]),[button('К задаче','task',{id:p.id,list:p.list})]]);
 }
 if(p.op==='task_reminders'){
  const state=await listTaskReminders(u,p.id!),active=state.schedules.filter(r=>r.enabled);
  return screen(u,ch,'Напоминания по задаче #'+p.id+'\n'+(active.map(r=>`${name(r.recipient_id)}: дни ${r.days.join(', ')} · ${r.times.join(', ')} МСК · ${r.weeks} нед.`).join('\n')||'Расписаний нет.')+'\nНеподтверждённые сообщения повторяются каждые 30 минут до конца дня.',[[button('Новое напоминание для меня','reminder_days',{id:p.id,list:p.list})],...active.map(r=>[button('Выключить: '+r.times.join(', '),'confirm',{kind:'reminder_cancel',id:p.id,list:p.list,target:r.id})]),[button('К задаче','task',{id:p.id,list:p.list}),button('Ожидают подтверждения','alerts')]]);
 }
 if(p.op==='alerts'){const alerts=(await userAlerts(u)).filter(a=>!a.acknowledged_at&&!a.canceled_at);return screen(u,ch,'Напоминания, ожидающие подтверждения: '+alerts.length, [...alerts.slice(0,15).map(a=>[button('ОК · '+(a.task_id?'#'+a.task_id:a.kind),'confirm',{kind:'alert_ack',target:a.id})]),[button('Меню','home')]]);}
 if(p.op==='edit'){const d=await detail(u,p.id!);assert(canEditTaskData(u,d.task),403,'Редактирование доступно постановщику или руководителю.');return screen(u,ch,'Редактирование #'+d.task.id+' · '+compactTaskTitle(d.task.title),[[button('Название','form',{kind:'edit_title',id:p.id,list:p.list,version:d.task.version})],[button('Описание','form',{kind:'edit_description',id:p.id,list:p.list,version:d.task.version})],[button('Цена задачи','form',{kind:'edit_price',id:p.id,list:p.list,version:d.task.version})],[button('Исполнитель','assignee_list',{id:p.id,list:p.list,version:d.task.version})],...(d.task.status==='active'?[[button('Крайний срок через согласование','form',{kind:'deadline',id:p.id,list:p.list,version:d.task.version})]]:[]),[button('К задаче','task',{id:p.id,list:p.list})]]);}
 if(p.op==='assignee_list'){const d=await detail(u,p.id!);assert(canEditTaskData(u,d.task),403,'Нет права редактировать задачу.');const people=await taskAssignees(u,p.id!);const page=Math.max(0,Math.min(p.page||0,Math.ceil(people.length/8)-1));return screen(u,ch,'Выберите исполнителя · страница '+(page+1),[...people.slice(page*8,page*8+8).map(person=>[button(person.name,'assignee_prepare',{id:p.id,list:p.list,version:d.task.version,target:person.id})]),[...(page?[button('← Назад','assignee_list',{id:p.id,list:p.list,page:page-1})]:[]),...((page+1)*8<people.length?[button('Далее →','assignee_list',{id:p.id,list:p.list,page:page+1})]:[])],[button('К задаче','task',{id:p.id,list:p.list})]]);}
 if(p.op==='brief'){
  assert(u.role!=='employee',403,'Сводка команды доступна руководителям.');
  const s=summarize(data.tasks,now),pending=data.approvals.filter(a=>a.state==='pending').length;
  const urgent=data.tasks.filter(t=>taskQueue(t,now)==='overdue').sort((a,b)=>Number(!!b.customer_risk)-Number(!!a.customer_risk)||(a.deadline||'').localeCompare(b.deadline||'')).slice(0,3);
  return screen(u,ch,`📊 РУСПЭТ · сводка руководителя\n${date(data.serverTime)} МСК · ваша область доступа\n\nВсего задач: ${s.total}\nПросрочены ранее: ${s.overdue}\nПоследний день сегодня: ${s.today}\nСрок впереди: ${s.upcoming}\nБез срока: ${s.no_deadline}\nНа приёмке: ${s.review}\nЗавершены: ${s.completed}\n\nОтдельно: ${pending} согласований — входят в задачи выше.\n\nВ первую очередь\n${urgent.map(t=>`• #${t.id} ${compactTaskTitle(t.title,90)}\n  ${name(t.assignee_id)} · ${date(t.deadline)}`).join('\n')||'Просрочек с прошлых дней нет.'}\n\nЧек-листы и анализ невыполненных задач исключены. Это текущая сводка; сохранённые снимки — в архиве.`,[[button('Обновить сводку','brief')],[button('Архив отчётов','reports')],...urgent.map(t=>[button('Открыть #'+t.id,'task',{id:t.id})]),[button('В меню','home')]]);
 }
 if(p.op==='report_now'||p.op==='report_evening'){const report=await (await import('./service.js')).makeReport(u,p.op==='report_now'?'snapshot':'daily','bot:'+randomBytes(12).toString('hex'));return botView(u,ch,{op:'reports',id:report.id});}
 return renderBotNavigation(u,ch,{op:'home'});
}
export function parseMoscowInput(value:string){const match=value.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);assert(match,400,'Введите дату в формате ДД.ММ.ГГГГ ЧЧ:ММ, время московское.');const [,d,m,y,h,min]=match,raw=`${y}-${m}-${d}T${h}:${min}:00+03:00`,date=new Date(raw);assert(!isNaN(date.getTime())&&new Date(date.getTime()+10800000).toISOString().slice(0,16)===`${y}-${m}-${d}T${h}:${min}`,400,'Такой даты или времени нет.');assert(date>new Date(),400,'Новый срок должен быть в будущем.');return date.toISOString();}
async function prompt(u:User,ch:string,d:Dialog,db:Db){const f=d.fields[d.index];return screen(u,ch,`Задача #${d.payload.id}\nШаг ${d.index+1}/${d.fields.length}\n\n${f.label}\n${f.key==='deadline'?'Формат: ДД.ММ.ГГГГ ЧЧ:ММ · Москва':`Минимум ${f.min} символов. Можно указать ссылку на материалы.`}`,[[button('Отменить ввод','cancel',{id:d.payload.id,list:d.payload.list})]],db)}
export async function botClick(u:User,ch:string,token:string):Promise<BotScreen>{
 const b=(await pool.query('SELECT * FROM bot_buttons WHERE token=$1 AND actor_id=$2 AND channel=$3 AND expires_at>now()',[token,u.id,ch])).rows[0];assert(b,409,'Кнопка устарела. Откройте меню заново.');const p=b.payload as Payload;
 if(!['form','confirm','cancel','accept_prepare','assignee_prepare','undo_prepare'].includes(p.op)){await clearBotDraft(u,ch);return botView(u,ch,p)}
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);
  const record=(await db.query('SELECT * FROM bot_buttons WHERE token=$1 FOR UPDATE',[token])).rows[0];if(record.receipt)return record.receipt as BotScreen;assert(!record.revoked,409,'Этот ввод отменён или заменён новым. Откройте актуальную задачу.');
  if(p.op==='cancel'||p.op==='form')await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch]);
  if(p.op==='cancel'){await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);return screen(u,ch,'Ввод отменён. Изменения не отправлены.',[...(p.id?[[button('К задаче','task',{id:p.id,list:p.list})]]:[]),[button('Меню','home')]],db)}
  if(p.op==='assignee_prepare'){const d=await detail(u,p.id!);assert(canEditTaskData(u,d.task),403,'Нет права редактировать задачу.');const person=(await db.query('SELECT name FROM users WHERE id=$1',[p.target])).rows[0];assert(person,400,'Исполнитель не найден.');return screen(u,ch,'Назначить исполнителем: '+person.name+'?',[[button('Указать причину','form',{kind:'edit_assignee',id:p.id,list:p.list,version:p.version,target:p.target})],[button('Отмена','cancel',{id:p.id,list:p.list})]],db);}
  if(p.op==='accept_prepare')return screen(u,ch,`Принять результат по задаче #${p.id} без комментария?`,[[button('Да, принять результат','confirm',{kind:'accept',id:p.id,list:p.list,version:p.version,values:{comment:''}})],[button('Отмена','cancel',{id:p.id,list:p.list})]],db);
  if(p.op==='undo_prepare'){const last=await lastUndo(u,undefined,db);assert(last&&last.id===p.target,409,'Отмена недоступна: действие изменилось или прошло пять минут.');return screen(u,ch,`Отменить «${last.label}» по задаче #${last.task_id}? История сохранится, участники получат уточнение.`,[[button('Да, отменить действие','confirm',{kind:'undo',id:last.task_id,target:last.id})],[button('Оставить действие','cancel')]],db);}
  if(p.op==='form'){
   const min=(await config(db)).config.responseMinLength;
   if(p.kind?.startsWith('edit_')){const d=await detail(u,p.id!);assert(canEditTaskData(u,d.task),403,'Нет права редактировать задачу.');}
   const fields:Field[]=p.kind==='edit_price'?[{key:'price',label:'Цена задачи в рублях (обязательное поле)',min:1},{key:'reason',label:'Причина изменения цены',min:5}]:p.kind==='reminder'?[{key:'times',label:'Время напоминания: ЧЧ:ММ, можно несколько через запятую. Например: 09:00, 15:30. Не более 8 времён.',min:5},{key:'weeks',label:'Сколько недель повторять? Число от 1 до 52. Для одного недельного цикла введите 1.',min:1}]:p.kind==='edit_title'?[{key:'value',label:'Новое название задачи',min:3},{key:'reason',label:'Причина изменения',min:5}]:p.kind==='edit_description'?[{key:'value',label:'Новое описание задачи',min:1},{key:'reason',label:'Причина изменения',min:5}]:p.kind==='edit_assignee'?[{key:'reason',label:'Почему меняется исполнитель?',min:5}]:p.kind==='answer'?[{key:'reason',label:'Что помешало выполнить задачу?',min},{key:'progress',label:'Что уже сделано?',min},{key:'plan',label:'Что будете делать дальше?',min}]:p.kind==='deadline'?[{key:'deadline',label:'Предложите новый срок',min:1},{key:'reason',label:'Почему нужен новый срок?',min},{key:'plan',label:'Что будет сделано к новому сроку?',min}]:p.kind==='clarification'?[{key:'answer',label:'Ответьте на вопрос согласующего',min:5}]:[{key:'comment',label:p.kind==='comment'?'Комментарий к задаче':p.kind==='submit'?'Опишите готовый результат':p.kind==='return'?'Что конкретно нужно исправить?':p.kind==='reject'?'Почему запрос отклонён?':p.kind==='clarify'?'Что нужно уточнить?':'Комментарий к решению',min:5}];
   const d:Dialog={payload:p,fields,index:0,values:p.values||{}};await db.query("INSERT INTO bot_sessions(actor_id,channel,data,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT(actor_id,channel) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",[u.id,ch,JSON.stringify(d)]);return prompt(u,ch,d,db);
  }
  const v=p.values||{};let result='Действие сохранено.',resultTask:string|undefined;
  if(p.kind==='undo'){await undoLastAction(u,p.target!);result='Действие отменено. Исходная запись и отмена сохранены в истории.'}
  else if(p.kind==='delegate'){const copy=await delegateTask(u,p.id!,{assigneeId:p.target!,expectedVersion:p.version!});resultTask=copy.id;result='Поручение #'+copy.id+' создано. Результат вернётся руководителю на приёмку.';}
  else if(p.kind==='comment'){await addComment(u,p.id!,v.comment,p.target);result='Комментарий сохранён в обсуждении задачи и доступен руководителю.'}
  else if(p.kind==='reminder'){await saveTaskReminder(u,p.id!,{recipientId:u.id,days:v.days.split(',').map(Number),times:v.times.split(',').map(s=>s.trim()),weeks:Number(v.weeks)});result='Напоминание сохранено. Время московское. Для доставки привяжите свой чат в панели.'}
  else if(p.kind==='reminder_cancel'){await disableTaskReminder(u,p.target!);result='Расписание выключено.'}
  else if(p.kind==='alert_ack'){await acknowledgeAlert(u,p.target!);result='ОК, получение напоминания подтверждено. Это не завершает задачу.'}
  else if(p.kind?.startsWith('edit_')){const d=await detail(u,p.id!),t=d.task;const input:TaskInput={title:t.title,description:t.description,assigneeId:t.assignee_id,deadline:t.deadline,plannedStart:t.planned_start||null,plannedEnd:t.planned_end,important:t.important,customerRisk:t.customer_risk,parentId:t.parent_id||null};if(p.kind==='edit_title'){assert(v.value.length<=500,400,'Название не длиннее 500 символов.');input.title=v.value;}else if(p.kind==='edit_description')input.description=v.value;else if(p.kind==='edit_price'){const price=parsePrice(v.price);assert(price!==null,400,'Укажите корректную цену в рублях.');input.price=price;}else input.assigneeId=p.target!;await editTask(u,t.id,input,p.version!,v.reason);result='Изменение сохранено в задаче и истории.'}
  else if(p.kind==='checklist'){await queueBitrixOperation(u,p.id!,{kind:'checklist.update',itemId:p.target!,expectedRevision:p.revision!,fields:{IS_COMPLETE:v.complete as 'Y'|'N'}});result='Изменение чек-листа поставлено в очередь Битрикс24.'}
  else if(p.kind==='answer'){await answerControl(u,p.target!,{reason:v.reason,progress:v.progress,plan:v.plan});result='Ответ сохранён и доступен руководителю.'}
  else if(p.kind==='deadline'){await requestApproval(u,p.id!,{type:'deadline',reason:v.reason,plan:v.plan,proposedDeadline:v.deadline,expectedVersion:p.version!});result='Новый срок предложен. Текущий крайний срок изменится после согласования.'}
  else if(p.kind==='clarification'){await answerClarification(u,p.target!,v.answer);result='Ответ отправлен согласующему. Этап ожидает его решения.'}
  else if(['approve','reject','later','clarify'].includes(p.kind!)){const r=await decide(u,p.target!,{decision:p.kind as 'approve'|'reject'|'later'|'clarify',comment:v.comment||'',expectedStep:p.step,expectedRevision:p.revision,remindMinutes:p.minutes});result=r.state==='stale'?'Задача изменилась. Нужен новый запрос.':p.kind==='clarify'?'Вопрос отправлен автору запроса.':p.kind==='later'?'Напоминание назначено через час.':r.state==='pending'?'Ваш этап согласован. Запрос передан следующему руководителю.':p.kind==='reject'?'Запрос отклонён. Причина сохранена.':'Согласование завершено.'}
  else{await reviewTask(u,p.id!,p.kind as 'submit'|'accept'|'return',v.comment||'',p.version!);result=p.kind==='submit'?'Результат передан на приёмку. Ожидается решение руководителя.':p.kind==='return'?'Задача возвращена. Замечания сохранены для исполнителя.':'Результат принят. Задача завершена.'}
  const undo=await lastUndo(u,undefined,db);
  const response=await screen(u,ch,result,[...(resultTask?[[button('Открыть поручение','task',{id:resultTask})]]:[]),[...(p.id?[button('К задаче','task',{id:p.id,list:p.list})]:[]),button('Нужно действие','inbox')],...(undo?[[button('Отменить последнее действие','undo_prepare',{id:undo.task_id,target:undo.id})]]:[])],db);
  await db.query('UPDATE bot_buttons SET receipt=$2 WHERE token=$1',[token,JSON.stringify(response)]);await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);return response;
 });
}
export async function botText(u:User,ch:string,text:string,inputId:string):Promise<BotScreen>{
 const result=await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);const old=(await db.query('SELECT screen FROM bot_inputs WHERE actor_id=$1 AND channel=$2 AND input_id=$3',[u.id,ch,inputId])).rows[0];if(old)return old.screen;
  const row=(await db.query('SELECT * FROM bot_sessions WHERE actor_id=$1 AND channel=$2 AND expires_at>now() FOR UPDATE',[u.id,ch])).rows[0];
  if(!row||(row.data as Dialog).payload.op==='search'){
   const query=text.trim();assert(query.length>=2&&query.length<=100,400,'Для поиска напишите от 2 до 100 символов. Чтобы отправить результат, сначала откройте задачу и нажмите «Сдать результат».');
   await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);
   return {searchQuery:query};
  }
  const d=row.data as Dialog,f=d.fields[d.index];assert(text.trim().length>=f.min&&text.length<=4000,400,`Ответ: от ${f.min} до 4000 символов.`);
  if(f.key==='price')assert(parsePrice(text)!==null,400,'Цена: неотрицательное число, не более двух знаков после запятой.');
  if(f.key==='times')assert(reminderInput.shape.times.safeParse(text.split(',').map(s=>s.trim())).success,400,'Время: ЧЧ:ММ, до 8 различных времён через запятую.');
  if(f.key==='weeks')assert(/^\d{1,2}$/.test(text.trim())&&Number(text)>=1&&Number(text)<=52,400,'Введите число недель от 1 до 52.');
  d.values[f.key]=f.key==='deadline'?parseMoscowInput(text.trim()):text.trim();d.index++;
  let response:BotScreen;if(d.index<d.fields.length){await db.query('UPDATE bot_sessions SET data=$3 WHERE actor_id=$1 AND channel=$2',[u.id,ch,JSON.stringify(d)]);response=await prompt(u,ch,d,db)}else{
   // The draft is now immutable and bound to a one-time confirmation button.
   await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);const summary=(d.payload.kind==='reminder'?'Дни недели (1=Пн, 7=Вс): '+d.values.days+'\n\n':'')+d.fields.map(f=>f.label+'\n'+(f.key==='deadline'?date(d.values[f.key]):d.values[f.key])).join('\n\n');
   response=await screen(u,ch,`Проверьте перед отправкой · #${d.payload.id}\n\n${summary.length>3200?summary.slice(0,3200)+'\n… Введённые ответы сохранены полностью.':summary}`,[[button('Подтвердить и отправить','confirm',{...d.payload,op:'confirm',values:d.values})],[button('Ввести заново','form',d.payload),button('Отмена','cancel',{id:d.payload.id,list:d.payload.list})]],db);
  }
  await db.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4)',[u.id,ch,inputId,JSON.stringify(response)]);return response;
 });
 if('searchQuery' in result){
  const response=await botView(u,ch,{op:'search',query:result.searchQuery});
  return (await pool.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4) ON CONFLICT(actor_id,channel,input_id) DO UPDATE SET input_id=excluded.input_id RETURNING screen',[u.id,ch,inputId,JSON.stringify(response)])).rows[0].screen;
 }
 return result;
}

export async function alertScreen(u:User,ch:string,alert:{id:string;task_id:string|null;body:string;links?:{text:string;url:string}[];report_id?:string|null}):Promise<BotScreen>{const result=await screen(u,ch,alert.body,[[button('ОК, увидел','confirm',{kind:'alert_ack',target:alert.id,id:alert.task_id||undefined})],...(alert.task_id?[[button('Открыть задачу','task',{id:alert.task_id}),button('Новое напоминание','reminder_days',{id:alert.task_id})]]:[]),...(alert.report_id?[[button('Открыть отчёт','reports',{id:alert.report_id}),button('PDF','report_pdf',{id:alert.report_id})]]:[]),[button('Мои задачи','tasks')]]);return {...result,text:linkedText(alert.body,alert.links||[]),format:'HTML'};}
