import {button,htmlScreen,type Payload,type ListOrigin} from './bot-ui.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {botDue,botTaskStatus,sortBotTasks} from './bot-presentation.js';
import {escapeHtml as h} from '../shared/report-links.js';
import {actionItems} from '../shared/actions.js';
import {taskQueue} from '../shared/queues.js';
import {summarize} from '../shared/analytics.js';
import {bootstrap,visibleTasks} from './service.js';
import {assert,canManage} from './domain.js';
import {hasCompanyOverview} from '../shared/report-parameters.js';
import {directorBatchTasks} from './management-notices.js';
import {lastUndo} from './undo.js';
import {pool,type Db} from './db.js';
import {personalNotifications} from './notifications.js';
import {groupNotifications} from '../shared/notifications.js';
import type {User,Task} from '../shared/types.js';

const tasksPerPage=4;
type TaskListItem={task:Task;hint?:string;pending?:boolean};
async function taskList(u:User,ch:string,p:Payload,items:TaskListItem[],label:string,now:Date,name:(id:string)=>string,db:Db=pool){
 const pages=Math.max(1,Math.ceil(items.length/tasksPerPage)),page=Math.max(0,Math.min(p.page||0,pages-1));
 const start=page*tasksPerPage,slice=items.slice(start,start+tasksPerPage);
 const lines=slice.map(({task:t,hint,pending})=>{
  const facts=['#'+t.id,hint||botTaskStatus(t,now,pending)];
  if(t.status!=='completed')facts.push(botDue(t,now));
  if(t.assignee_id!==u.id)facts.push(name(t.assignee_id));
  return `<b>${h(compactTaskTitle(t.title,126))}</b>\n${h(facts.join(' · '))}`;
 });
 const list:ListOrigin={op:p.op,page,filter:p.filter,owner:p.owner,query:p.query,target:p.target};
 const choices=slice.map(({task:t})=>button('#'+t.id,'task',{id:t.id,list}));
 const range=slice.length===1?String(start+1):`${start+1}–${start+slice.length}`;
 const count=pages>1?`${range} из ${items.length}`:String(items.length);
 return htmlScreen(u,ch,`<b>${h(label)}</b> · ${count}\n\n${lines.join('\n\n')||'Здесь пока нет задач.'}`,[
  ...Array.from({length:Math.ceil(choices.length/2)},(_,i)=>choices.slice(i*2,i*2+2)),
  [...(page?[button('← Назад',p.op,{...list,page:page-1})]:[]),...(page+1<pages?[button('Дальше →',p.op,{...list,page:page+1})]:[])],
  [...(p.op==='director_batch'?[]:[button('Фильтры','task_filters',{owner:p.owner})]),...(p.owner&&p.owner!==u.id?[button('К команде','team')]:[]),button('Меню','home')]
 ],db);
}

export async function renderBotNavigation(u:User,ch:string,p:Payload,db:Db=pool){
 if(p.op==='notice_menu')return htmlScreen(u,ch,'Уведомления',[[button('Открыть уведомления','notices'),button('Нужно действие','inbox')]]);
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
    item.management_notice?.kind==='morning-report'?[[button('Открыть утренний отчёт','reports',{id:item.management_notice.reportId})]]:[]),
   [...(taskNotices.some(notice=>notice?.hasDeadlines)?[button('Мои сроки','tasks',{filter:'my_due'})]:[]),
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
  const people=[...owners].map(([id,tasks])=>({id,name:name(id),open:tasks.filter(t=>t.status!=='completed').length,...summarize(tasks,now)}))
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
 if(p.owner&&owner!==u.id)assert(canManage(u)&&scoped.length&&(teamIds.has(owner)||hasCompanyOverview(u)),404,'Сотрудник вне доступной команды.');
 const matches=(t:Task,filter:string)=>filter==='my_due'?['today','overdue'].includes(taskQueue(t,now)):
  filter==='open'||filter==='mine'?t.status!=='completed':filter==='active'?t.status==='active':taskQueue(t,now)===filter;
 const myActions=actionItems(data).filter(a=>a.mine),actionTasks=new Set(myActions.map(a=>a.taskId));
 if(p.op==='task_filters'){
  const count=(filter:string)=>filter==='created'?data.tasks.filter(t=>t.status!=='completed'&&t.creator_id===u.id).length:scoped.filter(t=>matches(t,filter)).length;
  const choice=(text:string,filter:string)=>button(`${text} · ${count(filter)}`,'tasks',{filter,owner});
  return htmlScreen(u,ch,'<b>'+h(owner===u.id?'Мои задачи':name(owner))+' · фильтры</b>\n\nВремя — московское.',[
   [choice('Просрочены','overdue'),choice('Срок сегодня','today')],
   [choice('В работе','active'),choice('На приёмке','review')],
   [choice('Без срока','no_deadline'),choice('Завершены','completed')],
   [choice('Все незавершённые','open'),...(owner===u.id?[choice('Я постановщик','created')]:[])],
   [button('Поиск','search_prompt'),button('Меню','home')]
  ]);
 }
 if(['inbox','tasks','day'].includes(p.op)){
  if(p.op==='inbox'){
   const grouped=new Map<string,string[]>();for(const action of myActions){const labels=grouped.get(action.taskId)||[];if(!labels.includes(action.label))labels.push(action.label);grouped.set(action.taskId,labels);}
   const tasks=new Map(data.tasks.map(t=>[t.id,t]));
   return taskList(u,ch,p,[...grouped].flatMap(([id,labels])=>tasks.has(id)?[{task:tasks.get(id)!,hint:labels[0]+(labels.length>1?' +'+(labels.length-1):'')}]:[]),'Нужно ваше действие',now,name);
  }
  const filter=p.op==='day'?'today':p.filter||'mine',labels:Record<string,string>={open:'Незавершённые',active:'В работе',today:'Срок сегодня',overdue:'Просрочены',review:'На приёмке',completed:'Завершены',no_deadline:'Без срока',mine:'Мои задачи',my_due:'Мои сроки',created:'Я постановщик'};
  const tasks=sortBotTasks(filter==='created'?data.tasks.filter(t=>t.status!=='completed'&&t.creator_id===u.id):scoped.filter(t=>matches(t,filter)),now);
  const pending=new Set(data.approvals.filter(a=>a.state==='pending').map(a=>a.task_id));
  const label=owner===u.id?labels[filter]||'Мои задачи':name(owner)+' · '+(labels[filter]||'Задачи');
  return taskList(u,ch,{...p,owner},tasks.map(task=>({task,pending:pending.has(task.id)})),label,now,name);
 }
 if(p.op==='menu_more'){
  const last=await lastUndo(u);
  return htmlScreen(u,ch,'<b>Другие разделы</b>\n\nНапоминания, отчёты и помощь.',[
   [button('🔔 Напоминания','alerts'),...(u.role!=='employee'?[button('📁 Отчёты','reports')]:[])],
   ...(canManage(u)?[[button('Сводка команды','brief',{filter:'team'})]]:[]),
   ...(last?[[button('Отменить последнее действие','undo_prepare',{id:last.task_id,target:last.id})]]:[]),
   [button('Поиск','search_prompt'),button('Как пользоваться','help')],[button('Меню','home')]
  ]);
 }
 if(p.op==='help')return htmlScreen(u,ch,'<b>Как пользоваться ботом</b>\n\n1. «Нужно действие» — ответы, приёмка и согласования лично для вас.\n2. «Срок сегодня» и «Просрочены» — срочные задачи.\n3. Откройте задачу: сверху ближайшее действие, ниже описание и обсуждение.\n4. «Ещё действия» — новый срок, редактирование, напоминания и история.\n\nДля поиска просто напишите название, номер или имя исполнителя. Изменения выполняются после отдельного подтверждения.',[[button('Найти задачу','search_prompt')],[button('Меню','home')]]);
 const s=summarize(own,now);
 const company=hasCompanyOverview(u);
 const total=company?summarize(data.tasks,now):null;
 const overview=total?`\n\n<b>Вся компания</b>\nОткрыто: ${total.unfinished} · Просрочено: ${total.overdue} · Сегодня: ${total.today} · Приёмка: ${total.review}`:'';
 return htmlScreen(u,ch,`<b>РУСПЭТ · Мои задачи</b>\n${h(u.name)}\n\nМои задачи в работе и на приёмке: <b>${s.unfinished}</b>\nМои сроки · Сегодня: ${s.today} · Просрочено: ${s.overdue}\nНужно ваше действие: <b>${actionTasks.size}</b>${overview}`,[
  [button(`📥 Нужно действие · ${actionTasks.size}`,'inbox')],
  [button(`Сегодня · ${s.today}`,'day'),button(`Просрочены · ${s.overdue}`,'tasks',{filter:'overdue'})],
  [button('Мои задачи','tasks',{owner:u.id}),...(canManage(u)?[button('Задачи команды','team')]:[button('Поиск','search_prompt')])],
  ...(company?[[button('Сводка компании','brief',{filter:'company'}),button('Отчёты','reports')]]:
   canManage(u)?[[button('Мои отчёты','reports',{filter:'mine'}),button('Поиск','search_prompt')]]:[]),
  [button('Новая задача','form',{kind:'create_task'}),button('Уведомления','notices')],
  [button('Ещё разделы','menu_more')]
 ]);
}
