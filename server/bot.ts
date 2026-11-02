import {randomBytes} from 'node:crypto';
import {pool,transaction,type Db} from './db.js';
import {assert,canRequest} from './domain.js';
import {bootstrap,detail,answerControl,requestApproval,decide,config,getReport,listReports} from './service.js';
import {reviewTask} from './workflow.js';
import {actionItems,canReview} from '../shared/actions.js';
import {taskQueue} from '../shared/queues.js';
import {summarize,queueLabels} from '../shared/analytics.js';
import type {User,Task} from '../shared/types.js';
export type BotScreen={text:string;buttons:{text:string;token:string}[][]};
type Payload={op:string;id?:string;page?:number;filter?:string;query?:string;kind?:string;version?:number;target?:string;step?:number;values?:Record<string,string>;minutes?:number};
type Field={key:string;label:string;min:number};
type Dialog={payload:Payload;fields:Field[];index:number;values:Record<string,string>};
const date=(s:string|null)=>s?new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}):'Не назначен';
async function screen(u:User,ch:string,text:string,rows:{text:string;payload:Payload}[][],db:Db=pool):Promise<BotScreen>{
 const buttons=[];for(const row of rows){const result=[];for(const b of row){const token=randomBytes(18).toString('base64url');await db.query("INSERT INTO bot_buttons(token,actor_id,channel,payload,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours')",[token,u.id,ch,JSON.stringify(b.payload)]);result.push({text:b.text,token})}buttons.push(result)}return {text,buttons};
}
const button=(text:string,op:string,extra:Partial<Payload>={})=>({text,payload:{op,...extra}});
const home=[button('📅 Срок сегодня','day'),button('📥 Ждут решения','inbox')];
export async function clearBotDraft(u:User,ch:string){await transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch])})}
export async function botView(u:User,ch:string,p:Payload={op:'home'}):Promise<BotScreen>{
 const data=await bootstrap(u),now=new Date(data.serverTime),name=(id:string)=>data.users.find(x=>x.id===id)?.name||id;
 if(p.op==='search'){
  const query=(p.query||'').trim().toLocaleLowerCase('ru-RU');assert(query.length>=2&&query.length<=100,400,'Для поиска введите не менее 2 символов после /search.');
  const list=data.tasks.filter(t=>t.id.toLocaleLowerCase('ru-RU').includes(query)||t.title.toLocaleLowerCase('ru-RU').includes(query)||name(t.assignee_id).toLocaleLowerCase('ru-RU').includes(query));
  const page=Math.max(0,Math.min(p.page||0,Math.max(0,Math.ceil(list.length/6)-1))),slice=list.slice(page*6,page*6+6);
  return screen(u,ch,`Поиск: ${p.query}\nНайдено задач: ${list.length}\n\n${slice.map((t,i)=>`${i+1}. #${t.id} ${t.title.slice(0,150)}`).join('\n')||'Совпадений нет.'}\n\nСтраница ${page+1}/${Math.max(1,Math.ceil(list.length/6))}`, [...slice.map((t,i)=>[button(`${i+1}. Открыть #${t.id}`,'task',{id:t.id})]),[...(page?[button('← Назад','search',{query:p.query,page:page-1})]:[]),...(page*6+6<list.length?[button('Далее →','search',{query:p.query,page:page+1})]:[])],[button('Меню','home')]]);
 }
 if(['task','history'].includes(p.op)){
  const d=await detail(u,p.id!),t=d.task;
  if(p.op==='history'){
   const fields:Record<string,string>={title:'Название',description:'Описание',deadline:'Срок',status:'Состояние',assignee_id:'Исполнитель',planned_start:'Плановое начало',planned_end:'Плановое окончание'};
   const texts=d.events.flatMap(e=>{let text=`${date(e.created_at)} МСК · ${e.actor_id?name(e.actor_id):'Система'}\n${e.message}`;const before=e.data.before as Record<string,unknown>|undefined,after=e.data.after as Record<string,unknown>|undefined;
    if(before&&after)for(const [key,label] of Object.entries(fields))if(before[key]!==after[key])text+=`\n${label}: ${String(before[key]??'—')} → ${String(after[key]??'—')}`;
    for(const key of ['reason','progress','plan','comment','body'])if(e.data[key])text+=`\n${({reason:'Причина',progress:'Сделано',plan:'План / результат',comment:'Замечание / решение',body:'Комментарий'} as Record<string,string>)[key]}: ${String(e.data[key])}`;
    return Array.from({length:Math.max(1,Math.ceil(text.length/3000))},(_,i)=>text.slice(i*3000,(i+1)*3000));});
   const page=Math.max(0,Math.min(p.page||0,texts.length-1));return screen(u,ch,`История #${t.id} · ${page+1}/${Math.max(1,texts.length)}\n\n${texts[page]||'Записей пока нет.'}`,[[...(page? [button('← Ранее в списке','history',{id:t.id,page:page-1})]:[]),...(page+1<texts.length?[button('Дальше →','history',{id:t.id,page:page+1})]:[])],[button('К задаче','task',{id:t.id}),button('Меню','home')]]);
  }
  let text=`#${t.id} · ${t.title}\n${queueLabels[taskQueue(t,now)]}\nИсполнитель: ${name(t.assignee_id)}\nПостановщик: ${name(t.creator_id)}\nСрок: ${date(t.deadline)} МСК\n\n${t.description.slice(0,600)||'Описание не заполнено.'}`;
  const last=d.submissions[0];if(last)text+=`\n\nСдача №${last.round}: ${last.result.slice(0,500)}${last.remark?'\nЗамечание: '+last.remark.slice(0,500):''}`;
  const rows:ReturnType<typeof button>[][]=[];const pending=d.approvals.find(a=>a.state==='pending');
  const form=(label:string,kind:string,target?:string,step?:number)=>button(label,'form',{kind,id:t.id,version:t.version,target,step});
  if(pending){text+=`\n\nОжидается решение: ${name(pending.route[pending.current_step].userId)}\nПричина: ${pending.reason.slice(0,500)}\nПлан: ${pending.plan.slice(0,500)}`;if(pending.proposed_deadline)text+=`\nПредложенный срок: ${date(pending.proposed_deadline)} МСК`;
   if(pending.route[pending.current_step].userId===u.id)rows.push([form('Согласовать','approve',pending.id,pending.current_step),form('Отклонить','reject',pending.id,pending.current_step)],[button('Напомнить через час','confirm',{kind:'later',id:t.id,target:pending.id,step:pending.current_step,minutes:60,values:{}})]);
  }else if(t.status==='active'&&canRequest(u,t))rows.push([form(last?.state==='returned'?'Отправить доработку':'Сдать результат','submit')],[form('Предложить новый срок','deadline')]);
  else if(t.status==='review'&&canReview(u,t))rows.push([form('Принять результат','accept'),form('Вернуть с замечаниями','return')]);
  const control=d.controls.find(c=>['waiting','escalated'].includes(c.state)&&(c.assignee_id===u.id||u.role==='admin'));if(control)rows.push([form('Ответить на запрос','answer',control.id)]);
  rows.push([button('История','history',{id:t.id}),button('Меню','home')]);return screen(u,ch,text,rows);
 }
 if(p.op==='brief'){
  assert(u.role!=='employee',403,'Сводка команды доступна руководителям.');
  const s=summarize(data.tasks,now),pending=data.approvals.filter(a=>a.state==='pending').length;
  const urgent=data.tasks.filter(t=>taskQueue(t,now)==='overdue').sort((a,b)=>Number(!!b.customer_risk)-Number(!!a.customer_risk)||(a.deadline||'').localeCompare(b.deadline||'')).slice(0,3);
  return screen(u,ch,`📊 РУСПЭТ · сводка руководителя\n${date(data.serverTime)} МСК · ваша область доступа\n\nВсего задач: ${s.total}\nПросрочены ранее: ${s.overdue}\nПоследний день сегодня: ${s.today}\nСрок впереди: ${s.upcoming}\nБез срока: ${s.no_deadline}\nНа приёмке: ${s.review}\nЗавершены: ${s.completed}\n\nОтдельно: ${pending} согласований — входят в задачи выше.\n\nВ первую очередь\n${urgent.map(t=>`• #${t.id} ${t.title.slice(0,110)}\n  ${name(t.assignee_id)} · ${date(t.deadline)}`).join('\n')||'Просрочек с прошлых дней нет.'}\n\nЧек-листы и анализ невыполненных задач исключены. Это текущая сводка; сохранённые снимки — в архиве.`,[[button('Обновить сводку','brief')],[button('Архив отчётов','reports')],...urgent.map(t=>[button('Открыть #'+t.id,'task',{id:t.id})]),[button('В меню','home')]]);
 }
 if(p.op==='reports'){
  const page=p.page||0,archive=await listReports(u,{page:Math.floor(page/2)}),report=p.id?await getReport(u,p.id):null;
  const names:Record<string,string>={snapshot:'Обзор',today:'Сегодня',overdue:'Просрочки',review:'Приёмка',daily:'Итоги дня',nextday:'План'};
  const text=report?names[report.kind]+' · '+date(report.created_at)+' МСК\nВсего: '+report.metrics.total+'\nПросрочены ранее: '+report.metrics.overdue+'\nСегодня: '+report.metrics.today+'\nПриёмка: '+report.metrics.review+'\nЗавершены: '+report.metrics.completed+'\n\n'+(report.analysis?.notes||[]).join('\n\n'):'📁 Архив · '+archive.total+' отчётов.\nВыберите снимок: значения зафиксированы на момент создания.\n'+(!archive.total?'Первый отчёт можно сформировать в панели → Отчёты. Текущие цифры доступны в сводке руководителя.':'');
  const rows=archive.items.slice((page%2)*10,(page%2)*10+10).map((r:any)=>[button(date(r.created_at)+' · '+names[r.kind],'reports',{id:r.id,page})]);
  rows.push([...(page?[button('← Назад','reports',{page:page-1})]:[]),...((page+1)*10<archive.total?[button('Далее →','reports',{page:page+1})]:[])],home,[button('Меню','home')]);return screen(u,ch,((report&&report.formula_version!=='v4-task-selection'?'Архив до исключения служебных задач. Текущие данные — в сводке команды.\n\n':'')+text).slice(0,3800),rows);
 }
 if(['inbox','tasks','day'].includes(p.op)){
  const actions=actionItems(data).filter(a=>a.mine);const list=p.op==='inbox'?actions.map(a=>({id:a.taskId,label:a.label+' · '+a.title})):data.tasks.filter(t=>(t.assignee_id===u.id||u.role!=='employee')&&(p.op==='tasks'||taskQueue(t,now)==='today')).map(t=>({id:t.id,label:t.title}));
  const page=Math.max(0,Math.min(p.page||0,Math.max(0,Math.ceil(list.length/6)-1))),slice=list.slice(page*6,page*6+6);
  return screen(u,ch,`${p.op==='inbox'?'Нужно ваше действие':p.op==='day'?'Последний день сегодня':'Доступные задачи'} · ${list.length}\n${slice.map((t,i)=>`${i+1}. #${t.id} ${t.label.slice(0,180)}`).join('\n\n')||'Список пуст.'}\n\nСтраница ${page+1}/${Math.max(1,Math.ceil(list.length/6))}`, [...slice.map((t,i)=>[button(`${i+1}. Открыть #${t.id}`,'task',{id:t.id})]),[...(page?[button('← Назад',p.op,{page:page-1})]:[]),...(page*6+6<list.length?[button('Далее →',p.op,{page:page+1})]:[])],home,[button('Все задачи','tasks'),button('Меню','home')]]);
 }
 const s=summarize(data.tasks,now),actions=actionItems(data).filter(a=>a.mine).length;
 return screen(u,ch,`РУСПЭТ · ${u.role==='employee'?'Мои задачи':'Пульт руководителя'}\n${u.name}\n\n📥 Ждут вашего действия: ${actions}\n\nВсего доступно: ${s.total}\nПросрочены ранее: ${s.overdue}\nСрок сегодня: ${s.today}\nНа приёмке: ${s.review}\n\nНачните с «Ждут решения» — там ответы, приёмка и согласования. Откройте задачу, чтобы увидеть историю или отправить результат.\n\nПЭТ-преформы · крышки · упаковка\nБитрикс24 пока не подключён.`,[home,[button(u.role==='employee'?'Мои задачи':'Задачи команды','tasks')],...(u.role!=='employee'?[[button('📊 Сводка команды','brief'),button('📁 Отчёты','reports')]]:[])]);
}
export function parseMoscowInput(value:string){const match=value.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);assert(match,400,'Введите дату в формате ДД.ММ.ГГГГ ЧЧ:ММ, время московское.');const [,d,m,y,h,min]=match,raw=`${y}-${m}-${d}T${h}:${min}:00+03:00`,date=new Date(raw);assert(!isNaN(date.getTime())&&new Date(date.getTime()+10800000).toISOString().slice(0,16)===`${y}-${m}-${d}T${h}:${min}`,400,'Такой даты или времени нет.');assert(date>new Date(),400,'Новый срок должен быть в будущем.');return date.toISOString();}
async function prompt(u:User,ch:string,d:Dialog,db:Db){const f=d.fields[d.index];return screen(u,ch,`Задача #${d.payload.id}\nШаг ${d.index+1}/${d.fields.length}\n\n${f.label}\n${f.key==='deadline'?'Формат: ДД.ММ.ГГГГ ЧЧ:ММ · Москва':`Минимум ${f.min} символов. Можно указать ссылку на материалы.`}`,[[button('Отменить ввод','cancel')]],db)}
export async function botClick(u:User,ch:string,token:string):Promise<BotScreen>{
 const b=(await pool.query('SELECT * FROM bot_buttons WHERE token=$1 AND actor_id=$2 AND channel=$3 AND expires_at>now()',[token,u.id,ch])).rows[0];assert(b,409,'Кнопка устарела. Откройте меню заново.');const p=b.payload as Payload;
 if(!['form','confirm','cancel'].includes(p.op)){await clearBotDraft(u,ch);return botView(u,ch,p)}
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);
  const record=(await db.query('SELECT * FROM bot_buttons WHERE token=$1 FOR UPDATE',[token])).rows[0];if(record.receipt)return record.receipt as BotScreen;assert(!record.revoked,409,'Этот ввод отменён или заменён новым. Откройте актуальную задачу.');
  if(p.op==='cancel'||p.op==='form')await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel')",[u.id,ch]);
  if(p.op==='cancel'){await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);return screen(u,ch,'Ввод отменён. Изменения не отправлены.',[[button('Меню','home')]],db)}
  if(p.op==='form'){
   const min=(await config(db)).config.responseMinLength;
   const fields:Field[]=p.kind==='answer'?[{key:'reason',label:'Что помешало выполнить задачу?',min},{key:'progress',label:'Что уже сделано?',min},{key:'plan',label:'Что будете делать дальше?',min}]:p.kind==='deadline'?[{key:'deadline',label:'Предложите новый срок',min:1},{key:'reason',label:'Почему нужен новый срок?',min},{key:'plan',label:'Что будет сделано к новому сроку?',min}]:[{key:'comment',label:p.kind==='submit'?'Опишите готовый результат':p.kind==='return'?'Что конкретно нужно исправить?':p.kind==='reject'?'Почему запрос отклонён?':'Комментарий к решению',min:5}];
   const d:Dialog={payload:p,fields,index:0,values:{}};await db.query("INSERT INTO bot_sessions(actor_id,channel,data,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT(actor_id,channel) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at",[u.id,ch,JSON.stringify(d)]);return prompt(u,ch,d,db);
  }
  const v=p.values||{};let result='Действие сохранено.';
  if(p.kind==='answer'){await answerControl(u,p.target!,{reason:v.reason,progress:v.progress,plan:v.plan});result='Ответ сохранён и доступен руководителю.'}
  else if(p.kind==='deadline'){await requestApproval(u,p.id!,{type:'deadline',reason:v.reason,plan:v.plan,proposedDeadline:v.deadline,expectedVersion:p.version!});result='Новый срок предложен. Текущий срок изменится после согласования.'}
  else if(['approve','reject','later'].includes(p.kind!)){const r=await decide(u,p.target!,{decision:p.kind as 'approve'|'reject'|'later',comment:v.comment||'',expectedStep:p.step,remindMinutes:p.minutes});result=r.state==='stale'?'Задача изменилась. Нужен новый запрос.':p.kind==='later'?'Напоминание назначено через час.':r.state==='pending'?'Ваш этап согласован. Запрос передан следующему руководителю.':p.kind==='reject'?'Запрос отклонён. Причина сохранена.':'Согласование завершено.'}
  else{await reviewTask(u,p.id!,p.kind as 'submit'|'accept'|'return',v.comment,p.version!);result=p.kind==='submit'?'Результат передан на приёмку. Ожидается решение руководителя.':p.kind==='return'?'Задача возвращена. Замечания сохранены для исполнителя.':'Результат принят. Задача завершена.'}
  const response=await screen(u,ch,result,[[button('К задаче','task',{id:p.id}),button('Нужно действие','inbox')]],db);
  await db.query('UPDATE bot_buttons SET receipt=$2 WHERE token=$1',[token,JSON.stringify(response)]);await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);return response;
 });
}
export async function botText(u:User,ch:string,text:string,inputId:string):Promise<BotScreen>{
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id+':'+ch]);const old=(await db.query('SELECT screen FROM bot_inputs WHERE actor_id=$1 AND channel=$2 AND input_id=$3',[u.id,ch,inputId])).rows[0];if(old)return old.screen;
  const row=(await db.query('SELECT * FROM bot_sessions WHERE actor_id=$1 AND channel=$2 AND expires_at>now() FOR UPDATE',[u.id,ch])).rows[0];assert(row,400,'Сначала откройте задачу и выберите действие. Для поиска используйте /task НОМЕР.');const d=row.data as Dialog,f=d.fields[d.index];assert(text.trim().length>=f.min&&text.length<=4000,400,`Ответ: от ${f.min} до 4000 символов.`);
  d.values[f.key]=f.key==='deadline'?parseMoscowInput(text.trim()):text.trim();d.index++;
  let response:BotScreen;if(d.index<d.fields.length){await db.query('UPDATE bot_sessions SET data=$3 WHERE actor_id=$1 AND channel=$2',[u.id,ch,JSON.stringify(d)]);response=await prompt(u,ch,d,db)}else{
   // The draft is now immutable and bound to a one-time confirmation button.
   await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[u.id,ch]);const summary=d.fields.map(f=>f.label+'\n'+(f.key==='deadline'?date(d.values[f.key]):d.values[f.key])).join('\n\n');
   response=await screen(u,ch,`Проверьте перед отправкой · #${d.payload.id}\n\n${summary.length>3200?summary.slice(0,3200)+'\n… Введённые ответы сохранены полностью.':summary}`,[[button('Подтвердить и отправить','confirm',{...d.payload,op:'confirm',values:d.values})],[button('Ввести заново','form',d.payload),button('Отмена','cancel')]],db);
  }
  await db.query('INSERT INTO bot_inputs(actor_id,channel,input_id,screen) VALUES($1,$2,$3,$4)',[u.id,ch,inputId,JSON.stringify(response)]);return response;
 });
}
