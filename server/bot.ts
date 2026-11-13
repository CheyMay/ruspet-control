import {button,date,screen,type BotScreen,type Payload} from './bot-ui.js';
import {renderBotTask} from './bot-task.js';
import {renderBotNavigation} from './bot-navigation.js';
import {readNotifications} from './notifications.js';
import {parseVoiceIntent} from './voice-intent.js';
import {normalizeActionField,prepareVoiceAction,taskActionFields,voiceLabels,type Field} from './bot-voice-actions.js';
import {voiceExample} from '../shared/voice.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {responsibilityLabels} from '../shared/company-responsibility.js';
export type {BotScreen} from './bot-ui.js';
import {lastUndo,undoLastAction} from './undo.js';
import {formatPrice,priceBand,priceLabels,parsePrice,taskPrice} from '../shared/pricing.js';
import {reportText,publicOrigin} from './report-content.js';
import {linkedText,reportLink,escapeHtml,taskLink} from '../shared/report-links.js';
import {randomBytes} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {acknowledgeAlert,userAlerts,listTaskReminders,saveTaskReminder,disableTaskReminder,saveOneTimeReminder,cancelOneTimeReminder} from './reminders.js';
import {assert,AppError} from './domain.js';
import {bootstrap,detail,addComment,answerControl,requestApproval,decide,answerClarification,config,getReport,listReports} from './service.js';
import {canDelegateTask,createTask,delegateTask,delegationClients,delegationTargets,editTask,reviewTask,taskAssignees,type TaskInput} from './workflow.js';
import {taskQueue} from '../shared/queues.js';
import {summarize} from '../shared/analytics.js';
import {defaultReportView,reportViews,reportViewLabels,type ReportView} from '../shared/report-parameters.js';
import type {User} from '../shared/types.js';
import {taskInput} from './task-input.js';
import {decideTaskEdit,requestTaskEdit} from './task-edit-permissions.js';
import {setApprovalWatch} from './approval-hierarchy.js';
type Dialog={payload:Payload;fields:Field[];index:number;values:Record<string,string>};
const taskScreens=['task','history','discussion','task_details','task_fields','task_edit_permission','task_result','task_approval','task_more'];
async function saveDialog(db:Db,u:User,ch:string,dialog:Dialog,minutes=60){
 await db.query("INSERT INTO bot_sessions(actor_id,channel,data,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 minute') ON CONFLICT(actor_id,channel) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",[u.id,ch,JSON.stringify(dialog),minutes]);
}
function nextMissing(dialog:Dialog){
 while(dialog.index<dialog.fields.length&&Object.hasOwn(dialog.values,dialog.fields[dialog.index].key))dialog.index++;
}
export async function clearBotDraft(u:User,ch:string){await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch])})}
export async function botView(u:User,ch:string,p:Payload={op:'home'}):Promise<BotScreen>{
 const result=await renderView(u,ch,p);
 if(p.id&&(taskScreens.includes(p.op)||p.op==='task_reminders'))await saveDialog(pool,u,ch,{payload:{op:'context',id:p.id},fields:[],index:0,values:{}},15);
 if(p.op==='home'&&process.env.PUBLIC_ORIGIN)result.links=[...(result.links||[]),{text:'Войти на сайт',url:new URL('/',process.env.PUBLIC_ORIGIN).href}];
 if(p.op==='home'||p.op==='task')result.timingKind=p.op==='home'?'menu':'task';
 return result;
}
async function renderView(u:User,ch:string,p:Payload):Promise<BotScreen>{
 if(taskScreens.includes(p.op))return renderBotTask(u,ch,p);
 if(p.op==='report_pdf'){const report=await getReport(u,p.id!);return {text:'PDF · '+new Date(report.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}),buttons:[],document:{reportId:report.id}};}
 if(p.op==='reports'){
  const view=(p.filter||defaultReportView(u)) as ReportView;
  assert(reportViews(u).includes(view),403,'Этот раздел отчётов недоступен.');
  const page=p.page||0,report=p.id?await getReport(u,p.id):null;
  const rows:ReturnType<typeof button>[][]=[];
  if(report){
   const content=reportText(report);
   rows.push([button('PDF отчёта','report_pdf',{id:report.id})],
    [button('К архиву','reports',{page,filter:report.parameters?.view||view})],[button('Меню','home')]);
   const result=await screen(u,ch,content.text.slice(0,3900),rows);
   return {...result,text:linkedText(content.text.length>3500?content.text.slice(0,3400)+'\nПолная сводка — в PDF и на сайте.':content.text,content.links),
    format:'HTML',links:[{text:'Отчёт на сайте',url:reportLink(publicOrigin(),report.id)}]};
  }
  const archive=await listReports(u,{view,page:Math.floor(page/2)});
  for(const r of archive.items.slice((page%2)*10,(page%2)*10+10))rows.push([button(date(r.summary?.to||r.created_at)+' · '+({snapshot:'Снимок',daily:'Итоги и завтра',period:'За период',today:'Сегодня',overdue:'Просрочки',review:'Приёмка',nextday:'План'} as Record<string,string>)[r.kind||'snapshot'],'reports',{id:r.id,page,filter:view})]);
  rows.push([...(page?[button('← Назад','reports',{page:page-1,filter:view})]:[]),...((page+1)*10<archive.total?[button('Далее →','reports',{page:page+1,filter:view})]:[])],
   [button('Отчёт сейчас','report_now',{filter:view}),button('Итоги дня','report_evening',{filter:view})],
   reportViews(u).filter(mode=>mode!==view).map(mode=>button(reportViewLabels[mode],'reports',{filter:mode})),[button('Меню','home')]);
  return screen(u,ch,'Отчёты · '+reportViewLabels[view]+'\nСохранённых снимков: '+archive.total,rows);
 }
 if(p.op==='delegate_list'||p.op==='delegate_preview'){
  const companyId=p.values?.companyId;
  const chosen:Record<string,string>=companyId?{companyId}:{};
  const {people,version,responsibility}=await delegationTargets(u,p.id!,companyId);
  const automatic=p.op==='delegate_list'&&p.filter!=='manual'&&!!responsibility.managerId;
  if(p.op==='delegate_preview'||automatic){
   const person=people.find(person=>person.id===(automatic?responsibility.managerId:p.target));
   assert(person,403,'Выберите подчинённого из доступного списка.');
   return screen(u,ch,`Создать поручение по задаче #${p.id} для ${person.name}?${automatic?'\nМенеджер клиента «'+responsibility.companyName+'» · '+responsibilityLabels[responsibility.source!]:''}\nПосле приёмки всех поручений основная задача закроется автоматически. Бюджет и крайний срок основной задачи сохранятся.`,[
    [button('Создать поручение','confirm',{kind:'delegate',id:p.id,list:p.list,version,target:person.id,values:automatic?{...chosen,assignment:'auto',responsibilityToken:responsibility.token!}:chosen})],
    [button('Другой сотрудник','delegate_list',{id:p.id,list:p.list,filter:'manual',values:chosen}),button('К задаче','task',{id:p.id,list:p.list})]
   ]);
  }
  const page=Math.max(0,Math.min(p.page||0,Math.ceil(people.length/8)-1));
  return screen(u,ch,people.length?(responsibility.reason?responsibility.reason+'\n':'')+'Кому делегировать задачу #'+p.id+'?':'В вашей области нет доступных подчинённых.',[
   ...people.slice(page*8,page*8+8).map(person=>[button(person.name,'delegate_preview',{id:p.id,list:p.list,target:person.id,values:chosen})]),
   [...(page?[button('← Назад','delegate_list',{id:p.id,page:page-1,filter:'manual',values:chosen})]:[]),...((page+1)*8<people.length?[button('Далее →','delegate_list',{id:p.id,page:page+1,filter:'manual',values:chosen})]:[])],
   ...(people.length&&!responsibility.companyId?[[button('Найти клиента в ОКБ','form',{id:p.id,kind:'delegate_client'})]]:[]),
   [button('К задаче','task',{id:p.id,list:p.list})]
  ]);
 }
 if(p.op==='reminder_days'){
  await detail(u,p.id!);const selected=(p.query||'').split(',').filter(Boolean).map(Number),names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const choices=names.map((name,i)=>button((selected.includes(i+1)?'✓ ':'')+name,'reminder_days',{id:p.id,query:(selected.includes(i+1)?selected.filter(d=>d!==i+1):[...selected,i+1]).join(',')}));
  return screen(u,ch,'Выберите дни напоминания по задаче #'+p.id+' · время московское',[choices.slice(0,4),choices.slice(4),...(selected.length?[[button('Далее: время и недели','form',{id:p.id,kind:'reminder',values:{days:selected.join(',')}})]]:[]),[button('К задаче','task',{id:p.id,list:p.list})]]);
 }
 if(p.op==='task_reminders'){
  const state=await listTaskReminders(u,p.id!),active=state.schedules.filter(r=>r.enabled);
  const people=active.length?(await pool.query('SELECT id,name FROM users WHERE id=ANY($1)',[active.map(r=>r.recipient_id)])).rows:[];
  const name=(id:string)=>people.find(person=>person.id===id)?.name||id;
  return screen(u,ch,'Напоминания по задаче #'+p.id+'\n'+(active.map(r=>`${name(r.recipient_id)}: дни ${r.days.join(', ')} · ${r.times.join(', ')} МСК · ${r.weeks} нед.`).join('\n')||'Расписаний нет.')+'\nБез подтверждения бот напомнит ещё раз через 30 минут.',[[button('Разовое напоминание','form',{id:p.id,kind:'reminder_once'}),button('По расписанию','reminder_days',{id:p.id})],...state.oneTime.map(r=>[button('Отменить '+date(r.due_at),'confirm',{kind:'reminder_cancel_once',id:p.id,target:r.id})]),...active.map(r=>[button('Выключить: '+r.times.join(', '),'confirm',{kind:'reminder_cancel',id:p.id,target:r.id})]),[button('К задаче','task',{id:p.id,list:p.list}),button('Ожидают подтверждения','alerts')]]);
 }
 if(p.op==='alerts'){const alerts=(await userAlerts(u)).filter(a=>!a.acknowledged_at&&!a.canceled_at);return screen(u,ch,'Напоминания, ожидающие подтверждения: '+alerts.length, [...alerts.slice(0,15).map(a=>[button('ОК · '+(a.task_id?'#'+a.task_id:a.kind),'confirm',{kind:'alert_ack',target:a.id})]),[button('Меню','home')]]);}
 if(p.op==='edit'){const d=await detail(u,p.id!);assert(d.editAccess.canEdit,403,'Нет права редактировать задачу. Исполнитель может запросить разрешение.');return screen(u,ch,'Редактирование #'+d.task.id+' · '+compactTaskTitle(d.task.title),[[button('Название','form',{kind:'edit_title',id:p.id,version:d.task.version})],[button('Описание','form',{kind:'edit_description',id:p.id,version:d.task.version})],[button('Цена задачи','form',{kind:'edit_price',id:p.id,version:d.task.version})],[button('Исполнитель','assignee_list',{id:p.id,version:d.task.version})],[button('Крайний срок через согласование','form',{kind:'deadline',id:p.id,version:d.task.version})],[button('К задаче','task',{id:p.id,list:p.list})]]);}
 if(p.op==='assignee_list'){const d=await detail(u,p.id!);assert(d.editAccess.canEdit,403,'Нет права редактировать задачу.');const people=await taskAssignees(u,p.id!);const page=Math.max(0,Math.min(p.page||0,Math.ceil(people.length/8)-1));return screen(u,ch,'Выберите исполнителя · страница '+(page+1),[...people.slice(page*8,page*8+8).map(person=>[button(person.name,'assignee_prepare',{id:p.id,version:d.task.version,target:person.id})]),[...(page?[button('← Назад','assignee_list',{id:p.id,page:page-1})]:[]),...((page+1)*8<people.length?[button('Далее →','assignee_list',{id:p.id,page:page+1})]:[])],[button('К задаче','task',{id:p.id,list:p.list})]]);}
 if(p.op==='brief'){
  assert(u.role!=='employee',403,'Сводка команды доступна руководителям.');
  const view=(p.filter||'team') as ReportView;
  assert(reportViews(u).includes(view),403,'Этот раздел отчётов недоступен.');
  const data=await bootstrap(u,true),now=new Date(data.serverTime),name=(id:string)=>data.users.find(person=>person.id===id)?.name||id;
  const team=new Set(data.teamIds);
  const tasks=data.tasks.filter(task=>view==='company'||(view==='mine'?task.assignee_id===u.id:team.has(task.assignee_id)));
  const ids=new Set(tasks.map(task=>task.id)),s=summarize(tasks,now);
  const pending=data.approvals.filter(a=>a.state==='pending'&&ids.has(a.task_id)).length;
  const urgent=tasks.filter(t=>taskQueue(t,now)==='overdue').sort((a,b)=>Number(!!b.customer_risk)-Number(!!a.customer_risk)||(a.deadline||'').localeCompare(b.deadline||'')).slice(0,3);
  const breakdown=data.users.map(person=>({person,...summarize(tasks.filter(task=>task.assignee_id===person.id),now)}))
   .filter(row=>row.unfinished).sort((a,b)=>b.overdue-a.overdue||b.today-a.today);
  const lines=breakdown.slice(0,6).map(row=>row.person.name+': '+row.overdue+' просрочено · '+row.today+' сегодня · '+row.unfinished+' открыто');
  const summary=`Открыто: ${s.unfinished} · Завершено: ${s.completed}\nПросрочено: ${s.overdue} · Срок сегодня: ${s.today}\nНа приёмке: ${s.review} · Без срока: ${s.no_deadline}\nСогласований: ${pending}`;
  const priority=urgent.map(t=>`#${t.id} · ${compactTaskTitle(t.title,105)}\n${name(t.assignee_id)} · ${date(t.deadline)}`).join('\n\n');
  const result=await screen(u,ch,[reportViewLabels[view]+' · '+date(data.serverTime)+' МСК',summary,lines.join('\n'),
   breakdown.length>6?'Ещё исполнителей: '+(breakdown.length-6):'',priority].filter(Boolean).join('\n\n'),[
   [button('Отчёты','reports',{filter:view}),...(view==='team'?[button('По сотрудникам','team')]:[])],
   ...urgent.map(t=>[button('Открыть #'+t.id,'task',{id:t.id,list:{op:'brief',filter:view}})]),[button('Меню','home')]
  ]);
  if(view==='company')result.links=[{text:'Аналитика компании на сайте',url:new URL('/?view=overview',publicOrigin()).href}];
  return result;
 }
 if(p.op==='report_now'||p.op==='report_evening'){
  const view=(p.filter||defaultReportView(u)) as ReportView;
  const report=await (await import('./service.js')).makeReport(u,p.op==='report_now'?'snapshot':'daily','bot:'+randomBytes(12).toString('hex'),new Date(),{view});
  return botView(u,ch,{op:'reports',id:report.id,filter:view});
 }
 return renderBotNavigation(u,ch,p);
}
export function parseMoscowInput(value:string,now=new Date()){
 const match=value.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
 assert(match,400,'Укажите дату и время по Москве, например «завтра в 15:00».');
 const [,d,m,y,h,min]=match,date=new Date(y+'-'+m+'-'+d+'T'+h+':'+min+':00+03:00');
 assert(!isNaN(+date)&&new Date(+date+10800000).toISOString().slice(0,16)===y+'-'+m+'-'+d+'T'+h+':'+min,400,'Такой даты или времени нет.');
 assert(date>now,400,'Дата и время должны быть в будущем.');return date.toISOString();
}
function missingLabel(d:Dialog){
 const field=d.fields[d.index];
 if(field.key==='deadline'&&d.payload.values?.dueDay)return 'Дата уже указана: '+d.payload.values.dueDay+'. Назовите время по Москве.';
 return field.label;
}
async function prompt(u:User,ch:string,d:Dialog,db:Db){
 return screen(u,ch,(d.payload.id?'Задача #'+d.payload.id:'Новая задача')+'\n'+missingLabel(d),
  [[button('Отменить ввод','cancel',{id:d.payload.id,list:d.payload.list})]],db);
}
const dayNames=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
async function draftSummary(d:Dialog,db:Db){
 const result:string[]=[];
 if(d.values.assignee){
  const person=(await db.query('SELECT name FROM users WHERE id=$1',[d.values.assignee])).rows[0];
  result.push('Исполнитель: '+(person?.name||d.values.assignee));
 }
 if(d.values.days)result.push('Дни: '+d.values.days.split(',').map(day=>dayNames[Number(day)-1]).join(', '));
 for(const f of d.fields){
  if(f.key==='assignee'||f.key==='days')continue;
  const value=d.values[f.key];
  if(!value)continue;
  if(f.key==='deadline')result.push('Дата: '+(value==='none'?'Без срока':date(value)+' МСК'));
  else result.push(f.label+'\n'+value);
 }
 return result.join('\n\n');
}
async function confirmation(u:User,ch:string,d:Dialog,db:Db,heading=d.payload.id?'Проверьте перед отправкой · #'+d.payload.id:'Проверьте новую задачу'){
 const summary=await draftSummary(d,db);
 const redo={...d.payload,values:d.payload.kind==='reminder'?{days:d.values.days}:undefined};
 return screen(u,ch,`${heading}\n\n${summary.length>3100?summary.slice(0,3100)+'\n… Введённые ответы сохранены полностью.':summary}`,[
  [button('Подтвердить и отправить','confirm',{...d.payload,op:'confirm',values:d.values})],
  [...(d.fields.length?[button('Ввести заново','form',redo)]:[]),button('Отмена','cancel',{id:d.payload.id,list:d.payload.list})]
 ],db);
}
export async function savedVoiceDraft(u:User,ch:string,inputId:string,db:Db=pool){
 return (await db.query('SELECT screen FROM bot_inputs WHERE actor_id=$1 AND channel=$2 AND input_id=$3',[u.id,ch,'voice:'+inputId])).rows[0]?.screen as BotScreen|undefined;
}
export async function botVoiceDraft(u:User,ch:string,transcript:string,inputId:string,at=new Date()):Promise<BotScreen>{
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);
  const cached=await savedVoiceDraft(u,ch,inputId,db);if(cached)return cached;
  const existing=(await db.query('SELECT data FROM bot_sessions WHERE actor_id=$1 AND channel=$2 AND expires_at>now()',[u.id,ch])).rows[0]?.data as Dialog|undefined;
  const context=existing?.payload.op==='context'?existing.payload.id:undefined;
  const intent=parseVoiceIntent(transcript,at,context);
  if(!intent&&existing&&!['context','search'].includes(existing.payload.op))return handleBotText(db,u,ch,transcript,'voice:'+inputId);
  let response:BotScreen;
  if(!intent){
   response=await screen(u,ch,'Распознал: '+transcript.slice(0,600)+'\n\nНазовите действие и номер задачи. Например: «'+voiceExample+'»',[[button('Мои задачи','tasks'),button('Меню','home')]],db);
  }else{
   const {payload,title}=await prepareVoiceAction(u,intent,db);
   const kind=payload.kind as typeof intent.kind;
   if(intent.values.dueDay)payload.values={dueDay:intent.values.dueDay};
   const fields=kind==='accept'&&!intent.values.comment?[]:taskActionFields(kind,(await config(db)).config.responseMinLength);
   const values:Record<string,string>={};
   if(kind==='create_task'){
    if(u.role==='employee'&&!intent.values.assignee)values.assignee=u.id;
    if(!intent.values.deadline)values.deadline='none';
    if(!intent.values.description)values.description='';
   }
   let client='';
   if(kind==='delegate'){
    if(!intent.values.instruction)values.instruction='';
    if(!intent.values.assignee||/^(?:менеджер[ау]? клиента|ответственн\p{L}* клиента)$/iu.test(intent.values.assignee)){
     const {responsibility}=await delegationTargets(u,payload.id!,undefined,db);
     if(responsibility.managerId){
      Object.assign(values,{assignee:responsibility.managerId,assignment:'auto',responsibilityToken:responsibility.token!});
      client='\nКлиент: '+responsibility.companyName+' · '+responsibilityLabels[responsibility.source!];
     }
    }
   }
   const draft:Dialog={payload,fields,index:0,values};
   for(const f of fields){
    const value=intent.values[f.key];if(!value||(f.key==='assignee'&&values.assignment==='auto'))continue;
    try{values[f.key]=await normalizeActionField(u,payload,f,value,db,stamp=>parseMoscowInput(stamp,at),at);}
    catch(error){if(!(error instanceof AppError)||error.status!==400)throw error;}
   }
   const heading=voiceLabels[kind]+(payload.id?' · #'+payload.id+'\n'+title.slice(0,180):'')+client;
   await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);
   await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch]);
   nextMissing(draft);
   if(kind==='reminder_cancel_voice'){
    const reminders=await listTaskReminders(u,payload.id!);
    const choices=[
     ...reminders.oneTime.map(r=>[button('Отменить '+date(r.due_at),'confirm',{id:payload.id,kind:'reminder_cancel_once',target:r.id})]),
     ...reminders.schedules.filter(r=>r.enabled&&r.recipient_id===u.id).map(r=>[button('Выключить '+r.times.join(', '),'confirm',{id:payload.id,kind:'reminder_cancel',target:r.id})])
    ];
    response=await screen(u,ch,choices.length?heading+'\nВыберите напоминание.':'Активных личных напоминаний по этой задаче нет.',[...choices,[button('К задаче','task',{id:payload.id})]],db);
   }else if(draft.index===fields.length)response=await confirmation(u,ch,draft,db,heading);
   else{
    await saveDialog(db,u,ch,draft);
    const summary=(await draftSummary(draft,db)).slice(0,2500);
    response=await screen(u,ch,heading+(summary?'\n\n'+summary:'')+'\n\n'+missingLabel(draft),[
     ...(kind==='delegate'&&!values.assignee?[[button('Найти клиента в ОКБ','form',{id:payload.id,kind:'delegate_client'})]]:[]),
     [button('Отменить ввод','cancel',{id:payload.id})]
    ],db);
   }
  }
  await db.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4)',[u.id,ch,'voice:'+inputId,JSON.stringify(response)]);
  return response;
 });
}
export async function botClick(u:User,ch:string,token:string):Promise<BotScreen>{
 const b=(await pool.query('SELECT * FROM bot_buttons WHERE token=$1 AND actor_id=$2 AND channel=$3 AND expires_at>now()',[token,u.id,ch])).rows[0];assert(b,409,'Кнопка устарела. Откройте меню заново.');const p=b.payload as Payload;
 if(p.op==='notices_read'){
  await readNotifications(u,p.noticeIds||[]);
  return botView(u,ch,{op:'notices'});
 }
 if(p.op==='approval_watch'){await setApprovalWatch(u,p.id!,p.values?.enabled==='true');return botView(u,ch,{op:'task_more',id:p.id,list:p.list});}
 if(!['form','confirm','cancel','accept_prepare','approval_accept_prepare','assignee_prepare','undo_prepare'].includes(p.op)){await clearBotDraft(u,ch);return botView(u,ch,p)}
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);
  const record=(await db.query('SELECT * FROM bot_buttons WHERE token=$1 FOR UPDATE',[token])).rows[0];if(record.receipt)return record.receipt as BotScreen;assert(!record.revoked,409,'Этот ввод отменён или заменён новым. Откройте актуальную задачу.');
  if(p.op==='cancel'||p.op==='form')await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch]);
  if(p.op==='cancel'){
   await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);
   if(p.id)await saveDialog(db,u,ch,{payload:{op:'context',id:p.id},fields:[],index:0,values:{}},15);
   return screen(u,ch,'Ввод отменён. Изменения не отправлены.',[[...(p.id?[button('К задаче','task',{id:p.id,list:p.list})]:[]),button('Меню','home')]],db);
  }
  if(p.op==='assignee_prepare'){const d=await detail(u,p.id!,db);assert(d.editAccess.canEdit,403,'Нет права редактировать задачу.');const person=(await db.query('SELECT name FROM users WHERE id=$1',[p.target])).rows[0];assert(person,400,'Исполнитель не найден.');return screen(u,ch,'Назначить исполнителем: '+person.name+'?',[[button('Указать причину','form',{kind:'edit_assignee',id:p.id,version:p.version,target:p.target})],[button('Отмена','cancel')]],db);}
  if(p.op==='accept_prepare')return screen(u,ch,`Принять результат по задаче #${p.id} без комментария?`,[[button('Да, принять результат','confirm',{kind:'accept',id:p.id,list:p.list,version:p.version,values:{comment:''}})],[button('Отмена','cancel')]],db);
  if(p.op==='approval_accept_prepare')return screen(u,ch,`Принять результат по задаче #${p.id} без комментария?`,[
   [button('Да, принять результат','confirm',{...p,op:'confirm',values:{comment:''}})],
   [button('К согласованию','task_approval',{id:p.id,list:p.list})]
  ],db);
  if(p.op==='undo_prepare'){const last=await lastUndo(u,undefined,db);assert(last&&last.id===p.target,409,'Отмена недоступна: действие изменилось или прошло пять минут.');return screen(u,ch,`Отменить «${last.label}» по задаче #${last.task_id}? История сохранится, участники получат уточнение.`,[[button('Да, отменить действие','confirm',{kind:'undo',id:last.task_id,list:p.list,target:last.id})],[button('Оставить действие','cancel')]],db);}
  if(p.op==='form'){
   const min=(await config(db)).config.responseMinLength;
   if(p.kind?.startsWith('edit_')){const d=await detail(u,p.id!,db);assert(d.editAccess.canEdit,403,'Нет права редактировать задачу.');}
   const fields=taskActionFields(p.kind,min,!p.target);
   const values={...(p.kind==='create_task'&&u.role==='employee'?{assignee:u.id}:{}),...p.values};
   const d:Dialog={payload:p,fields,index:0,values};nextMissing(d);
   if(d.index===fields.length)return confirmation(u,ch,d,db,p.kind==='permission_approve'?'Разрешить одно редактирование задачи #'+p.id+'?':undefined);
   await saveDialog(db,u,ch,d);return prompt(u,ch,d,db);
  }
  const v=p.values||{};let result='Действие сохранено.',resultTask:string|undefined;
  if(p.kind==='create_task'){
   const input=taskInput.parse({title:v.title,description:v.description||'',assigneeId:v.assignee,price:Number(v.price),deadline:v.deadline==='none'?null:v.deadline,
    plannedStart:null,plannedEnd:null,important:null,customerRisk:null,parentId:null});
   const created=await createTask(u,input);resultTask=created.id;
   result='Задача #'+created.id+' поставлена.';
  }
  else if(p.kind==='undo'){await undoLastAction(u,p.target!);result='Действие отменено. Исходная запись и отмена сохранены в истории.'}
  else if(p.kind==='delegate'){
   const copy=await delegateTask(u,p.id!,{...(v.assignment==='auto'?{responsibilityToken:v.responsibilityToken}:{assigneeId:v.assignee||p.target!}),
    companyId:v.companyId,expectedVersion:p.version!,instruction:v.instruction||undefined});
   resultTask=copy.id;result='Поручение #'+copy.id+' создано. После приёмки всех поручений основная задача закроется автоматически.';
  }
  else if(p.kind==='comment'){await addComment(u,p.id!,v.comment,p.target);result='Комментарий сохранён в обсуждении задачи и доступен руководителю.'}
  else if(p.kind==='reminder'){await saveTaskReminder(u,p.id!,{recipientId:u.id,days:v.days.split(',').map(Number),times:v.times.split(',').map(s=>s.trim()),weeks:Number(v.weeks)},true);result='Напоминание сохранено. Время московское. Для доставки привяжите свой чат в панели.'}
  else if(p.kind==='reminder_once'){await saveOneTimeReminder(u,p.id!,v.deadline);result='Разовое напоминание сохранено на '+date(v.deadline)+' МСК. Доставка в личный чат подключённого бота.';}
  else if(p.kind==='reminder_cancel_once'){await cancelOneTimeReminder(u,p.target!);result='Разовое напоминание отменено.';}
  else if(p.kind==='reminder_cancel'){await disableTaskReminder(u,p.target!);result='Расписание выключено.'}
  else if(p.kind==='alert_ack'){await acknowledgeAlert(u,p.target!);result='ОК, получение напоминания подтверждено. Это не завершает задачу.'}
  else if(p.kind?.startsWith('edit_')){const d=await detail(u,p.id!,db),t=d.task;const input:TaskInput={title:t.title,description:t.description,assigneeId:t.assignee_id,deadline:t.deadline,plannedStart:t.planned_start||null,plannedEnd:t.planned_end,important:t.important,customerRisk:t.customer_risk,parentId:t.parent_id||null};if(p.kind==='edit_title'){assert(v.value.length<=500,400,'Название не длиннее 500 символов.');input.title=v.value;}else if(p.kind==='edit_description')input.description=v.value;else if(p.kind==='edit_price'){const price=parsePrice(v.price);assert(price!==null,400,'Укажите корректную цену в рублях.');input.price=price;}else input.assigneeId=v.assignee||p.target!;await editTask(u,t.id,input,p.version!,v.reason);result='Изменение сохранено в задаче и истории.'}
  else if(p.kind==='permission_request'){await requestTaskEdit(u,p.id!,p.version!,v.reason);result='Запрос отправлен постановщику задачи.';}
  else if(p.kind==='permission_approve'||p.kind==='permission_reject'){
   const approved=p.kind==='permission_approve';
   await decideTaskEdit(u,p.id!,p.target!,approved?'approve':'reject',v.comment||'');
   result=approved?'Исполнителю разрешено одно сохранение карточки.':'Запрос на редактирование отклонён.';
  }
  else if(p.kind==='answer'){await answerControl(u,p.target!,{reason:v.reason,progress:v.progress,plan:v.plan});result='Ответ сохранён и доступен руководителю.'}
  else if(p.kind==='deadline'){await requestApproval(u,p.id!,{type:'deadline',reason:v.reason,plan:v.plan,proposedDeadline:v.deadline,expectedVersion:p.version!});result='Новый срок предложен. Текущий крайний срок изменится после согласования.'}
  else if(p.kind==='clarification'){await answerClarification(u,p.target!,v.answer);result='Ответ отправлен согласующему. Этап ожидает его решения.'}
  else if(['approve','reject','later','clarify'].includes(p.kind!)){const r=await decide(u,p.target!,{decision:p.kind as 'approve'|'reject'|'later'|'clarify',comment:v.comment||'',expectedStep:p.step,expectedRevision:p.revision,remindMinutes:p.minutes});result=r.state==='stale'?'Задача изменилась. Нужен новый запрос.':p.kind==='clarify'?'Вопрос отправлен автору запроса.':p.kind==='later'?'Напоминание назначено через час.':r.state==='pending'?'Ваш этап согласован. Запрос передан следующему руководителю.':p.kind==='reject'?'Запрос отклонён. Причина сохранена.':'Согласование завершено.'}
  else{await reviewTask(u,p.id!,p.kind as 'submit'|'accept'|'return',v.comment||'',p.version!);result=p.kind==='submit'?'Результат передан на приёмку. Ожидается решение руководителя.':p.kind==='return'?'Задача возвращена. Замечания сохранены для исполнителя.':'Результат принят. Задача завершена.'}
  const undo=await lastUndo(u,undefined,db);
  if(p.id&&(await db.query("SELECT 1 FROM bitrix_operations WHERE task_id=$1 AND payload->>'actorId'=$2 AND created_at>=transaction_timestamp() AND state='pending' LIMIT 1",[p.id,u.id])).rowCount)result+='\n\nДействие сохранено в РУСПЭТ. Обмен с Битрикс24 выполняется по очереди; состояние видно в карточке задачи.';
  if(resultTask&&p.kind==='delegate')result+='\nПоручение создано локально: автоматическое создание задач в Битрикс24 пока не включено.';
  const response=await screen(u,ch,result,[...(resultTask?[[button(p.kind==='create_task'?'Открыть задачу':'Открыть поручение','task',{id:resultTask})]]:[]),[...(p.id?[button('К задаче','task',{id:p.id,list:p.list})]:[]),button('Нужно действие','inbox')],...(undo?[[button('Отменить последнее действие','undo_prepare',{id:undo.task_id,target:undo.id})]]:[])],db);
  await db.query('UPDATE bot_buttons SET receipt=$2 WHERE token=$1',[token,JSON.stringify(response)]);
  const context=resultTask||p.id;
  if(context)await saveDialog(db,u,ch,{payload:{op:'context',id:context},fields:[],index:0,values:{}},15);
  else await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);
  return response;
 });
}
export async function botText(u:User,ch:string,text:string,inputId:string):Promise<BotScreen>{
 return transaction(db=>handleBotText(db,u,ch,text,inputId));
}
async function handleBotText(db:Db,u:User,ch:string,text:string,inputId:string):Promise<BotScreen>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);const old=(await db.query('SELECT screen FROM bot_inputs WHERE actor_id=$1 AND channel=$2 AND input_id=$3',[u.id,ch,inputId])).rows[0];if(old)return old.screen;
  const row=(await db.query('SELECT * FROM bot_sessions WHERE actor_id=$1 AND channel=$2 AND expires_at>now() FOR UPDATE',[u.id,ch])).rows[0];
  const d=row?.data as Dialog|undefined;
  if(!d||['search','context'].includes(d.payload.op)){
   const response=await renderBotNavigation(u,ch,{op:'search',query:text.trim()},db);
   if(d)await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);
   await db.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4)',[u.id,ch,inputId,JSON.stringify(response)]);
   return response;
  }
  const f=d.fields[d.index];
  d.values[f.key]=await normalizeActionField(u,d.payload,f,text,db,parseMoscowInput);
  if(d.payload.kind==='delegate_client'){
   const id=d.payload.id!,clients=await delegationClients(u,id,d.values.client,db);
   if(clients.length)await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);
   const response=await screen(u,ch,clients.length?'Выберите клиента.':'Клиенты по этому запросу не найдены. Введите другое название или ИНН.',[
    ...clients.map(company=>[button(company.name.slice(0,55),'delegate_list',{id,values:{companyId:company.id}})]),
    [button('К поручению','delegate_list',{id})]
   ],db);
   await db.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4)',[u.id,ch,inputId,JSON.stringify(response)]);
   return response;
  }
  d.index++;nextMissing(d);
  let response:BotScreen;if(d.index<d.fields.length){await db.query('UPDATE bot_sessions SET data=$3 WHERE actor_id=$1 AND channel=$2',[u.id,ch,JSON.stringify(d)]);response=await prompt(u,ch,d,db)}else{
   // The draft is now immutable and bound to a one-time confirmation button.
   await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);response=await confirmation(u,ch,d,db);
  }
  await db.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4)',[u.id,ch,inputId,JSON.stringify(response)]);return response;
}

export async function alertScreen(u:User,ch:string,alert:{id:string;task_id:string|null;body:string;links?:{text:string;url:string}[];report_id?:string|null}):Promise<BotScreen>{const result=await screen(u,ch,alert.body,[[button('ОК, увидел','confirm',{kind:'alert_ack',target:alert.id,id:alert.task_id||undefined})],...(alert.task_id?[[button('Открыть задачу','task',{id:alert.task_id}),button('Новое напоминание','reminder_days',{id:alert.task_id})]]:[]),...(alert.report_id?[[button('Открыть отчёт','reports',{id:alert.report_id}),button('PDF','report_pdf',{id:alert.report_id})]]:[]),[button('Мои задачи','tasks')]]);return {...result,text:linkedText(alert.body,alert.links||[]),format:'HTML'};}
