import {button,htmlScreen,type Payload,type ListOrigin} from './bot-ui.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {botDue,botTaskStatus,sortBotTasks} from './bot-presentation.js';
import {escapeHtml as h} from '../shared/report-links.js';
import {actionItems} from '../shared/actions.js';
import {taskQueue} from '../shared/queues.js';
import {summarize} from '../shared/analytics.js';
import {bootstrap,visibleTasks} from './service.js';
import {assert} from './domain.js';
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
  return `<b>${h(compactTaskTitle(t.title,76))}</b>\n${h(facts.join(' · '))}`;
 });
 const list:ListOrigin={op:p.op,page,filter:p.filter,query:p.query};
 const choices=slice.map(({task:t})=>button('#'+t.id,'task',{id:t.id,list}));
 const range=slice.length===1?String(start+1):`${start+1}–${start+slice.length}`;
 const count=pages>1?`${range} из ${items.length}`:String(items.length);
 return htmlScreen(u,ch,`<b>${h(label)}</b> · ${count}\n\n${lines.join('\n\n')||'Здесь пока нет задач.'}`,[
  ...Array.from({length:Math.ceil(choices.length/2)},(_,i)=>choices.slice(i*2,i*2+2)),
  [...(page?[button('← Назад',p.op,{...list,page:page-1})]:[]),...(page+1<pages?[button('Дальше →',p.op,{...list,page:page+1})]:[])],
  [button('Фильтры','task_filters'),button('Поиск','search_prompt'),button('Меню','home')]
 ],db);
}

export async function renderBotNavigation(u:User,ch:string,p:Payload,db:Db=pool){
 if(p.op==='notice_menu')return htmlScreen(u,ch,'Уведомления',[[button('Открыть уведомления','notices'),button('Нужно действие','inbox')]]);
 if(p.op==='notices'){
  const groups=groupNotifications(await personalNotifications(u,true)).slice(0,5);
  const lines=groups.map(group=>{
   const item=group[0];
   return h(item.body.slice(0,190))+(group.length>1?' · ещё '+(group.length-1):'');
  });
  return htmlScreen(u,ch,'<b>Новые уведомления</b>\n\n'+(lines.join('\n\n')||'Все уведомления прочитаны.'),[
   ...groups.filter(group=>group[0].task_id).map(group=>[button('Открыть #'+group[0].task_id,'task',{id:group[0].task_id!,list:{op:'notices'}})]),
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
 const myActions=actionItems(data).filter(a=>a.mine),actionTasks=new Set(myActions.map(a=>a.taskId));
 if(p.op==='task_filters'){
  const count=(filter:string)=>data.tasks.filter(t=>filter==='active'?t.status==='active':filter==='open'?t.status!=='completed':filter==='mine'?t.status!=='completed'&&t.assignee_id===u.id:filter==='created'?t.status!=='completed'&&t.creator_id===u.id:taskQueue(t,now)===filter).length;
  const choice=(text:string,filter:string)=>button(`${text} · ${count(filter)}`,'tasks',{filter});
  return htmlScreen(u,ch,'<b>Задачи · выберите список</b>\n\nСначала срочные, затем ближайшие по сроку.\nВремя — московское.',[
   [choice('Просрочены','overdue'),choice('Срок сегодня','today')],
   [choice('В работе','active'),choice('На приёмке','review')],
   [choice('Без срока','no_deadline'),choice('Завершены','completed')],
   [choice('Я исполнитель','mine'),choice('Я постановщик','created')],
   [choice('Все незавершённые','open')],[button('Поиск','search_prompt'),button('Меню','home')]
  ]);
 }
 if(['inbox','tasks','day'].includes(p.op)){
  if(p.op==='inbox'){
   const grouped=new Map<string,string[]>();for(const action of myActions){const labels=grouped.get(action.taskId)||[];if(!labels.includes(action.label))labels.push(action.label);grouped.set(action.taskId,labels);}
   const tasks=new Map(data.tasks.map(t=>[t.id,t]));
   return taskList(u,ch,p,[...grouped].flatMap(([id,labels])=>tasks.has(id)?[{task:tasks.get(id)!,hint:labels[0]+(labels.length>1?' +'+(labels.length-1):'')}]:[]),'Нужно ваше действие',now,name);
  }
  const filter=p.op==='day'?'today':p.filter||(u.role==='employee'?'mine':'open'),labels:Record<string,string>={open:'Все незавершённые',active:'В работе',today:'Срок сегодня',overdue:'Просрочены',review:'На приёмке',completed:'Завершены',no_deadline:'Без срока',mine:'Мои задачи',created:'Я постановщик'};
  const tasks=sortBotTasks(data.tasks.filter(t=>filter==='open'?t.status!=='completed':filter==='active'?t.status==='active':filter==='mine'?t.status!=='completed'&&t.assignee_id===u.id:filter==='created'?t.status!=='completed'&&t.creator_id===u.id:taskQueue(t,now)===filter),now);
  const pending=new Set(data.approvals.filter(a=>a.state==='pending').map(a=>a.task_id));
  return taskList(u,ch,p,tasks.map(task=>({task,pending:pending.has(task.id)})),labels[filter]||'Задачи',now,name);
 }
 if(p.op==='menu_more'){
  const last=await lastUndo(u);
  return htmlScreen(u,ch,'<b>Другие разделы</b>\n\nНапоминания, отчёты и помощь.',[
   [button('🔔 Напоминания','alerts'),...(u.role!=='employee'?[button('📁 Отчёты','reports')]:[])],
   ...(u.role!=='employee'?[[button('📊 Сводка команды','brief')]]:[]),
   ...(last?[[button('Отменить последнее действие','undo_prepare',{id:last.task_id,target:last.id})]]:[]),
   [button('Как пользоваться','help')],[button('Меню','home')]
  ]);
 }
 if(p.op==='help')return htmlScreen(u,ch,'<b>Как пользоваться ботом</b>\n\n1. «Нужно действие» — ответы, приёмка и согласования лично для вас.\n2. «Срок сегодня» и «Просрочены» — срочные задачи.\n3. Откройте задачу: сверху ближайшее действие, ниже описание и обсуждение.\n4. «Ещё действия» — новый срок, редактирование, напоминания и история.\n\nДля поиска просто напишите название, номер или имя исполнителя. Изменения выполняются после отдельного подтверждения.',[[button('Найти задачу','search_prompt')],[button('Меню','home')]]);
 const s=summarize(data.tasks,now);
 return htmlScreen(u,ch,`<b>РУСПЭТ · ${u.role==='employee'?'Мои задачи':'Задачи команды'}</b>\n${h(u.name)}\n\nНужно ваше действие: <b>${actionTasks.size}</b>\nСрок сегодня: ${s.today} · Просрочены: ${s.overdue}\n\nВыберите раздел или напишите, какую задачу найти.`,[
  [button(`📥 Нужно действие · ${actionTasks.size}`,'inbox')],
  [button(`Сегодня · ${s.today}`,'day'),button(`Просрочены · ${s.overdue}`,'tasks',{filter:'overdue'})],
  [button(u.role==='employee'?'Мои задачи':'Задачи команды','tasks'),button('Поиск','search_prompt')],
  [button('Новая задача','form',{kind:'create_task'}),button('Уведомления','notices')],
  [button('Ещё разделы','menu_more')]
 ]);
}
