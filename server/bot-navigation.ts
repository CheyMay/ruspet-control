import {button,htmlScreen,type Payload,type ListOrigin} from './bot-ui.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {botDue,botTaskStatus,sortBotTasks} from './bot-presentation.js';
import {escapeHtml as h,workdayReports} from '../shared/report-links.js';
import {activeTaskApproval,canComplete,taskNextAction} from '../shared/actions.js';
import {workCount,workLabels,workQueue,workQueueTitle,type WorkBucket} from '../shared/work-queue.js';
import {approvalHierarchy,approvalScope} from './approval-hierarchy.js';
import {businessDay,elapsedToday,taskQueue} from '../shared/queues.js';
import {moscowClock} from '../shared/personal-calendar.js';
import {summarize} from '../shared/analytics.js';
import {bootstrap,getReport,visibleTasks} from './service.js';
import {assert,canManage} from './domain.js';
import {hasCompanyOverview} from '../shared/report-parameters.js';
import {directorBatchTasks} from './management-notices.js';
import {lastUndo} from './undo.js';
import {pool,type Db} from './db.js';
import {personalNotifications} from './notifications.js';
import {personalCalendar} from './personal-calendar.js';
import {groupNotifications} from '../shared/notifications.js';
import type {PersonalTaskScope,Report,User,Task} from '../shared/types.js';

const tasksPerPage=4;
type TaskListItem={task:Task;hint?:string;pending?:boolean};
async function taskList(u:User,ch:string,p:Payload,items:TaskListItem[],label:string,now:Date,name:(id:string)=>string,db:Db=pool){
 const pages=Math.max(1,Math.ceil(items.length/tasksPerPage)),page=Math.max(0,Math.min(p.page||0,pages-1));
 const start=page*tasksPerPage,slice=items.slice(start,start+tasksPerPage);
 const lines=slice.map(({task:t,hint,pending})=>{
  const facts=['#'+t.id,hint||botTaskStatus(t,now,pending)];
  if(t.status!=='completed')facts.push(botDue(t,now));
  return `<b>${h(compactTaskTitle(t.title,126))}</b>\n${h(facts.join(' · '))}\nИсполнитель · ${h(name(t.assignee_id))}\nПостановщик · ${h(name(t.creator_id))}`;
 });
 const list:ListOrigin={op:p.op,page,filter:p.filter,owner:p.owner,query:p.query,target:p.target};
 const scope=approvalScope(await approvalHierarchy(db));
 const choices=slice.map(({task:t,pending})=>[button('#'+t.id,'task',{id:t.id,list}),
  ...(!pending&&canComplete(u,t,scope)?[button('Завершить #'+t.id,'form',{id:t.id,list,version:t.version,kind:'complete'})]:[])]);
 const range=slice.length===1?String(start+1):`${start+1}–${start+slice.length}`;
 const count=pages>1?`${range} из ${items.length}`:String(items.length);
 const taskScope:PersonalTaskScope|undefined=p.op==='tasks'&&(!p.owner||p.owner===u.id)?(p.filter==='created'?'created':'mine'):undefined;
 const result=await htmlScreen(u,ch,`<b>${h(label)}</b> · ${count}\n\n${lines.join('\n\n')||'Здесь пока нет задач.'}`,[
  ...(taskScope&&ch.startsWith('telegram:')?[[button('Я исполнитель','tasks',{filter:'mine'}),button('Я постановщик','tasks',{filter:'created'})]]:[]),
  ...choices,
  [...(page?[button('← Назад',p.op,{...list,page:page-1})]:[]),...(page+1<pages?[button('Дальше →',p.op,{...list,page:page+1})]:[])],
  [...(p.op==='plan_tasks'?[button('К плану','reports',{id:p.target,filter:p.filter})]:p.op==='director_batch'?[]:
   p.op==='inbox'?[button('К срокам и действиям','inbox')]:[button('Фильтры','task_filters',{owner:p.owner})]),...(p.owner&&p.owner!==u.id?[button('К команде','team')]:[]),button('Меню','home')]
 ],db);
 return {...result,taskScope};
}

export async function renderBotNavigation(u:User,ch:string,p:Payload,db:Db=pool){
 if(p.op==='personal_plan'){
  const now=new Date(),today=businessDay(now);
  const tomorrow=businessDay(new Date(+now+86400000));
  const awaiting=p.filter==='awaiting';
  const day=p.filter&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(p.filter)?p.filter:today;
  const calendar=await personalCalendar(u,day.slice(0,7),db,now);
  const list=awaiting?calendar.awaiting:calendar.scheduled.filter(task=>businessDay(task.plan.plannedAt!)===day);
  const page=Math.max(0,Math.min(p.page||0,Math.ceil(list.length/tasksPerPage)-1));
  const rows=list.slice(page*tasksPerPage,(page+1)*tasksPerPage);
  const heading=awaiting?'Нужно принять':day===today?'Мой план на сегодня':day===tomorrow?'Мой план на завтра':'Мой план · '+day.split('-').reverse().join('.');
  const text=rows.map(task=>[
   task.plan.plannedAt?moscowClock(task.plan.plannedAt).slice(11)+' МСК':null,'#'+task.id,compactTaskTitle(task.title,105),task.plan.nextStep?'Шаг: '+task.plan.nextStep.slice(0,120):null,
   task.status==='completed'?'Завершена':task.status==='review'?'На приёмке':null
  ].filter(Boolean).join(' · '));
  const origin={op:p.op,filter:awaiting?'awaiting':day,page};
  return htmlScreen(u,ch,'<b>'+h(heading)+'</b> · '+list.length+'\n\n'+(text.length?text.map(h).join('\n\n'):'Здесь пока нет задач.'),[
   ...rows.map(task=>[button((awaiting?'Принять #':'Открыть #')+task.id,'task',{id:task.id,list:origin})]),
   [...(page?[button('← Назад',p.op,{...origin,page:page-1})]:[]),...((page+1)*tasksPerPage<list.length?[button('Дальше →',p.op,{...origin,page:page+1})]:[])],
   [button('Сегодня',p.op,{filter:today}),button('Завтра',p.op,{filter:tomorrow}),...(calendar.awaiting.length?[button('Нужно принять · '+calendar.awaiting.length,p.op,{filter:'awaiting'})]:[])],
   [button('Меню','home')]
  ],db);
 }
 if(p.op==='plan_tasks'){
  const report:Report=await getReport(u,p.target!);
  assert(report.kind==='nextday',404,'План не найден.');
  const taskIds=new Set(report.summary?.tomorrow.ids??report.rows.map(t=>t.id));
  const tasks=new Map((await visibleTasks(u,db)).filter(t=>taskIds.has(t.id)&&t.status==='active').map(t=>[t.id,t]));
  const people=new Map((await db.query<{id:string;name:string}>('SELECT id,name FROM users WHERE id=ANY($1)',[
   [...new Set([...tasks.values()].flatMap(t=>[t.assignee_id,t.creator_id]))],
  ])).rows.map(person=>[person.id,person.name]));
  const items=[...taskIds].flatMap(id=>tasks.has(id)?[{task:tasks.get(id)!}]:[]);
  return taskList(u,ch,p,items,'Задачи из плана',new Date(),id=>people.get(id)||id,db);
 }
 if(p.op==='notice_menu')return htmlScreen(u,ch,'Уведомления',[[button('Открыть уведомления','notices'),button(workQueueTitle,'inbox')]]);
 if(p.op==='notices'){
  const groups=groupNotifications(await personalNotifications(u,true)).slice(0,5);
  const lines=groups.map(group=>{
   const item=group[0];
   const text=item.task_notice?item.body.split('\n\n').map(section=>section.split('\n')[0]).join(' · '):item.body.slice(0,item.management_notice?530:190);
   return h(text)+(group.length>1?' · ещё '+(group.length-1):'');
  });
  const taskNotices=groups.map(group=>group[0].task_notice);
  return htmlScreen(u,ch,'<b>Новые уведомления</b>\n\n'+(lines.join('\n\n')||'Все уведомления прочитаны.'),[
   ...groups.filter(group=>group[0].task_id).map(group=>[button('Открыть #'+group[0].task_id,'task',{id:group[0].task_id!,list:{op:'notices'}})]),
   ...groups.flatMap(([item])=>item.management_notice?.kind==='director-approvals'?[[button('Открыть пакет','director_batch',{target:item.management_notice.batchId})]]:
    item.management_notice?.kind==='morning-report'?[[button('Открыть утренний отчёт','reports',{id:item.management_notice.reportId})]]:
    workdayReports(item.management_notice).map(report=>[button(report.label,'reports',{id:report.id,filter:report.view})])),
   [...(taskNotices.some(notice=>notice?.hasDeadlines)?[button(workQueueTitle,'inbox')]:[]),
    ...(taskNotices.some(notice=>notice?.hasAssignments)?[button('Мои задачи','tasks',{filter:'mine'})]:[])],
   ...(groups.length?[[button('Отметить показанные прочитанными','notices_read',{noticeIds:groups.flat().map(item=>item.id)})]]:[]),
   [button('Меню','home')]
  ]);
 }
 if(p.op==='search_prompt'){
  const draft={payload:{op:'search'},fields:[{key:'query',label:'Название, номер задачи или имя исполнителя',min:2}],index:0,values:{}};
  await pool.query("INSERT INTO bot_sessions(actor_id,channel,data,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT(actor_id,channel) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",[u.id,ch,JSON.stringify(draft)]);
  return htmlScreen(u,ch,'<b>Поиск задач</b>\n\nНапишите номер, часть названия или имя исполнителя.',[[button('Отмена','cancel')]]);
 }
 if(p.op==='search'){
  const query=(p.query||'').trim().replace(/^#\s*/,'').toLocaleLowerCase('ru-RU');assert(query.length>=2&&query.length<=100,400,'Для поиска введите от 2 до 100 символов.');
  const now=new Date(),tasks=await visibleTasks(u,db);
  const people=(await db.query('SELECT id,name FROM users WHERE id=ANY($1)',[[...new Set(tasks.map(t=>t.assignee_id))]])).rows;
  const names=new Map<string,string>(people.map(person=>[person.id,person.name]));
  const name=(id:string)=>names.get(id)||id;
  const list=sortBotTasks(tasks.filter(t=>t.id.toLocaleLowerCase('ru-RU').includes(query)||t.title.toLocaleLowerCase('ru-RU').includes(query)||name(t.assignee_id).toLocaleLowerCase('ru-RU').includes(query)),now);
  list.sort((a,b)=>Number(b.id.toLocaleLowerCase('ru-RU')===query)-Number(a.id.toLocaleLowerCase('ru-RU')===query));
  const pending=new Set((await db.query<{task_id:string}>("SELECT task_id FROM approvals WHERE task_id=ANY($1) AND state='pending'",[list.map(t=>t.id)])).rows.map(row=>row.task_id));
  return taskList(u,ch,p,list.map(task=>({task,pending:pending.has(task.id)})),`Поиск · ${p.query}`,now,name,db);
 }
 const data=await bootstrap(u,true),now=new Date(data.serverTime),name=(id:string)=>data.users.find(x=>x.id===id)?.name||id;
 const taskIndex=new Map(data.tasks.map(task=>[task.id,task]));
 const activeApprovals=new Map(data.approvals.filter(a=>activeTaskApproval(taskIndex.get(a.task_id)!,a)).map(a=>[a.task_id,a]));
 const pausedTasks=new Set(activeApprovals.keys());
 if(p.op==='director_batch'){
  const batch=await directorBatchTasks(u,p.target!);
  const tasks=new Map(data.tasks.map(task=>[task.id,task]));
  return taskList(u,ch,p,batch.flatMap(a=>tasks.has(a.task_id)?[{task:tasks.get(a.task_id)!,pending:true}]:[]),'Пакет согласований',now,name,db);
 }
 const own=data.tasks.filter(task=>task.assignee_id===u.id);
 const teamIds=new Set(data.teamIds);
 if(p.op==='team'){
  assert(canManage(u),403,'Задачи команды доступны руководителю.');
  const owners=new Map<string,Task[]>();
  for(const task of data.tasks.filter(task=>teamIds.has(task.assignee_id))){
   const assigned=owners.get(task.assignee_id)??[];
   assigned.push(task);owners.set(task.assignee_id,assigned);
  }
  const people=[...owners].map(([id,tasks])=>({id,name:name(id),open:tasks.filter(t=>t.status!=='completed').length,...summarize(tasks,now,pausedTasks)}))
   .sort((a,b)=>b.overdue-a.overdue||b.today-a.today||b.open-a.open||a.name.localeCompare(b.name,'ru'));
  const page=Math.max(0,Math.min(p.page||0,Math.ceil(people.length/6)-1));
  const shown=people.slice(page*6,page*6+6);
  return htmlScreen(u,ch,'<b>Задачи команды</b>\nВыберите сотрудника. Числа под именем относятся к его задачам.\n\n'+
   (shown.map(person=>`<b>${h(person.name)}</b>\nОткрыто: ${person.open} · Просрочено: ${person.overdue} · Сегодня: ${person.today}`).join('\n\n')||'У сотрудников пока нет задач.'),[
   ...shown.map(person=>[button(person.name,'tasks',{owner:person.id,filter:'open'})]),
   [...(page?[button('← Назад','team',{page:page-1})]:[]),...((page+1)*6<people.length?[button('Дальше →','team',{page:page+1})]:[])],
   [button('Отчёт команды','reports',{filter:'team'}),button('Меню','home')]
  ],db);
 }
 const owner=p.owner||u.id;
 const scoped=data.tasks.filter(task=>task.assignee_id===owner);
 const placed=data.tasks.filter(task=>task.creator_id===u.id);
 if(p.owner&&owner!==u.id)assert(canManage(u)&&scoped.length&&(teamIds.has(owner)||hasCompanyOverview(u)),404,'Сотрудник вне доступной команды.');
 const matches=(t:Task,filter:string)=>{
  if(filter==='open'||filter==='mine')return t.status!=='completed';
  if(filter==='active')return t.status==='active';
  if(filter==='review'||filter==='completed')return t.status===filter;
  if(pausedTasks.has(t.id))return false;
  const deadline=taskQueue(t,now),expired=elapsedToday(t,now);
  if(filter==='my_due')return ['today','overdue'].includes(deadline);
  if(filter==='overdue')return deadline==='overdue'||expired;
  if(filter==='today')return deadline==='today'&&!expired;
  return deadline===filter;
 };
 const queue=workQueue(data);
 if(p.op==='task_filters'){
  const count=(filter:string)=>filter==='created'?placed.length:scoped.filter(t=>matches(t,filter)).length;
  const choice=(text:string,filter:string)=>button(`${text} · ${count(filter)}`,'tasks',{filter,owner});
  return htmlScreen(u,ch,'<b>'+h(owner===u.id?'Мои задачи':name(owner))+' · фильтры</b>\n\nВремя — московское.',[
   ...(owner===u.id?[[choice('Мои сроки','my_due')]]:[]),
   [choice('Просрочены','overdue'),choice('Срок сегодня','today')],
   [choice('В работе','active'),choice('На приёмке','review')],
   [choice('Без срока','no_deadline'),choice('Завершены','completed')],
   [choice('Все незавершённые','open'),...(owner===u.id?[choice('Я постановщик','created')]:[])],
   [button('Поиск','search_prompt'),button('Меню','home')]
  ]);
 }
 if(['inbox','tasks','day'].includes(p.op)){
  if(p.op==='inbox'){
   if(p.filter&&Object.hasOwn(workLabels,p.filter)){
    const key=p.filter as WorkBucket;
    return taskList(u,ch,p,queue[key].map(item=>({
     task:item.task,hint:item.label+(key==='waiting'&&item.ownerId?' · '+name(item.ownerId):''),
     pending:item.pendingApproval||key==='waiting'||item.needsAcceptance||!!item.action
    })),workLabels[key],now,name,db);
   }
   const earlier=queue.overdue.filter(item=>item.deadlineState==='earlier').length;
   const expired=queue.overdue.length-earlier;
   return htmlScreen(u,ch,`<b>${workQueueTitle}</b>\n\nПросрочено с прошлых дней · ${earlier}\nИстекло сегодня · ${expired}\nНа сегодня · ${queue.today.length}\nОтветы и решения · ${queue.next.length}\nЖдут решения других · ${queue.waiting.length}`,[
    [button('Просрочено · '+queue.overdue.length,'inbox',{filter:'overdue'}),button('На сегодня · '+queue.today.length,'inbox',{filter:'today'})],
    [button('Ответы и решения · '+queue.next.length,'inbox',{filter:'next'}),button('Ждут решения · '+queue.waiting.length,'inbox',{filter:'waiting'})],
    [button('Меню','home')]
   ],db);
  }
  const filter=p.op==='day'?'today':p.filter||'mine',labels:Record<string,string>={open:'Незавершённые',active:'В работе',today:'Срок сегодня',overdue:'Просрочены',review:'На приёмке',completed:'Завершены',no_deadline:'Без срока',mine:'Мои задачи',my_due:'Мои сроки',created:'Я постановщик'};
  const tasks=sortBotTasks(filter==='created'?placed:scoped.filter(t=>matches(t,filter)),now);
  const label=owner===u.id?labels[filter]||'Мои задачи':name(owner)+' · '+(labels[filter]||'Задачи');
  return taskList(u,ch,{...p,owner},tasks.map(task=>{
   const approval=activeApprovals.get(task.id);
   const onApproval=!!approval&&activeTaskApproval(task,approval);
   const next=taskNextAction(task,approval,data.approvalScope);
   const hint=(onApproval||task.status==='review')&&next?.userId?next.label+' · '+name(next.userId):undefined;
   return {task,pending:onApproval,hint};
  }),label,now,name);
 }
 if(p.op==='menu_more'){
  const last=await lastUndo(u);
  return htmlScreen(u,ch,'<b>Другие разделы</b>',[
   [button('Напоминания','alerts'),...(!canManage(u)?[button('Отчёты','reports',{filter:'mine'})]:[])],
   [button('Мой календарь','personal_plan')],
   ...(canManage(u)?[[button('Сводка команды','brief',{filter:'team'})]]:[]),
   ...(last?[[button('Отменить последнее действие','undo_prepare',{id:last.task_id,target:last.id})]]:[]),
   [button('Как пользоваться','help')],[button('Меню','home')]
  ]);
 }
 if(p.op==='help')return htmlScreen(u,ch,'<b>Как пользоваться ботом</b>\n\n1. «Сроки и действия» — начните с просрочек и сроков на сегодня. Там же новые назначения, ответы и решения.\n2. «Ждут решения» — по этим задачам сейчас ход за другим участником.\n3. В карточке сверху ближайшее действие, ниже описание и обсуждение.\n4. В «Ещё действиях» есть перенос срока, напоминания и история.\n\nДля поиска напишите название, номер или имя исполнителя. Изменения выполняются после подтверждения.',[[button('Найти задачу','search_prompt')],[button('Меню','home')]]);
 const s=summarize(own,now,pausedTasks);
 const company=hasCompanyOverview(u);

 return htmlScreen(u,ch,`<b>РУСПЭТ · Мои задачи</b>\n${h(u.name)}\n\nВ работе и на приёмке · ${s.unfinished}\nПросрочено · ${queue.overdue.length} · На сегодня · ${queue.today.length}\nОтветы и решения · ${queue.next.length}`,[
  [button(workQueueTitle+' · '+workCount(queue),'inbox')],
  [button('Мои задачи','tasks',{owner:u.id}),button('Я постановщик','tasks',{filter:'created'}),...(canManage(u)?[button('Задачи команды','team')]:[])],
  ...(company?[[button('Сводка компании','brief',{filter:'company'}),button('Отчёты','reports')]]:
   canManage(u)?[[button('Мои отчёты','reports',{filter:'mine'})]]:[]),
  ...(data.pendingAssignments?[[button('Новые задачи к приёму · '+data.pendingAssignments,'personal_plan',{filter:'awaiting'})]]:[]),
  [button('Новая задача','form',{kind:'create_task'}),button('Поиск','search_prompt'),button('Уведомления','notices')],
  [button('Ещё разделы','menu_more')]
 ]);
}
