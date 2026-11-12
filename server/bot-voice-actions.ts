import type {Db} from './db.js';
import {assert,canEdit,canManage,canRequest,canSee,globalAccess} from './domain.js';
import {canReview} from '../shared/actions.js';
import {parsePrice} from '../shared/pricing.js';
import type {Approval,Task,User} from '../shared/types.js';
import {delegationTargets,taskAssignees} from './workflow.js';
import {lastUndo} from './undo.js';
import {spokenDeadline,spokenPrice,spokenTime,type VoiceIntent,type VoiceKind} from './voice-intent.js';
import type {Payload} from './bot-ui.js';

export type Field={key:string;label:string;min:number;max?:number};
export const voiceLabels:Record<VoiceKind,string>={
 create_task:'Поставить задачу',comment:'Добавить комментарий',submit:'Передать результат на приёмку',
 deadline:'Запросить перенос срока',accept:'Принять результат',return:'Вернуть на доработку',
 approve:'Согласовать запрос',reject:'Отклонить запрос',clarify:'Запросить уточнение',clarification:'Ответить на уточнение',answer:'Ответить на запрос',
 edit_title:'Изменить название',edit_description:'Изменить описание',edit_price:'Изменить цену',edit_assignee:'Сменить исполнителя',
 delegate:'Делегировать задачу',reminder_once:'Поставить разовое напоминание',reminder:'Поставить напоминание по расписанию',
 reminder_cancel_voice:'Отменить напоминание',undo:'Отменить последнее действие',
};

const field=(key:string,label:string,min=5,max?:number):Field=>({key,label,min,max});
const deadlineField=field('deadline','Дата и время по Москве, например «завтра в 15:00»',1);
const assigneeField=field('assignee','Имя и фамилия исполнителя или «себе»',2,200);
const priceField=field('price','Цена задачи в рублях',1,80);
const reasonField=field('reason','Причина изменения');
const descriptionField=field('description','Описание задачи или «пропустить»',1);

export function taskActionFields(kind:string|undefined,min:number,withAssignee=true):Field[]{
 switch(kind){
  case 'create_task':return [field('title','Название задачи',3,500),assigneeField,priceField,field('deadline','Крайний срок по Москве или «без срока»',1),descriptionField];
  case 'reminder_once':return [deadlineField];
  case 'reminder':return [field('days','Дни недели, например «понедельник и среда»',1),field('times','Время по Москве, например 09:00 или 09:00, 15:30',4),field('weeks','Число недель от 1 до 52',1)];
  case 'edit_price':return [priceField,reasonField];
  case 'edit_title':return [field('value','Новое название задачи',3,500),reasonField];
  case 'edit_description':return [field('value','Новое описание задачи',1),reasonField];
  case 'edit_assignee':return [...(withAssignee?[assigneeField]:[]),field('reason','Почему меняется исполнитель?')];
  case 'delegate':return [assigneeField,field('instruction','Поручение сотруднику или «пропустить»',1)];
  case 'delegate_client':return [field('client','Введите название клиента или ИНН',2,150)];
  case 'answer':return [field('reason','Что помешало выполнить задачу?',min),field('progress','Что уже сделано?',min),field('plan','Что будете делать дальше?',min)];
  case 'deadline':return [deadlineField,field('reason','Почему нужен новый срок?',min),field('plan','Что будет сделано к новому сроку?',min)];
  case 'clarification':return [field('answer','Ответьте на вопрос согласующего')];
  case 'comment':return [field('comment','Комментарий к задаче')];
  case 'submit':return [field('comment','Опишите готовый результат')];
  case 'return':return [field('comment','Что конкретно нужно исправить?')];
  case 'reject':return [field('comment','Почему запрос отклонён?')];
  case 'clarify':return [field('comment','Что нужно уточнить?')];
  case 'undo':
  case 'reminder_cancel_voice':return [];
  default:return [field('comment','Комментарий к решению')];
 }
}

const tokenNames=(text:string)=>text.toLocaleLowerCase('ru-RU').replaceAll('ё','е').match(/[\p{L}\d-]+/gu)||[];
const personName=(text:string)=>tokenNames(text).sort().join(' ');
function relatedName(a:string,b:string){
 if(a===b)return true;
 const stem=(s:string)=>s.length>3?s.replace(/(?:у|ю|е|а|я|ом|ем|ым)$/u,''):s;
 return stem(a)===stem(b);
}
async function availableAssignees(actor:User,payload:Payload,db:Db){
 if(payload.kind==='delegate')return (await delegationTargets(actor,payload.id!,undefined,db)).people;
 if(payload.kind==='edit_assignee')return taskAssignees(actor,payload.id!);
 return (await db.query<User>('SELECT * FROM users WHERE id=$1 OR NOT root_access AND ($2 OR ($3 AND branch_id=$4)) ORDER BY name',[actor.id,globalAccess(actor),actor.role==='branch_manager',actor.branch_id])).rows;
}
export async function resolveAssignee(actor:User,payload:Payload,value:string,db:Db){
 const people=await availableAssignees(actor,payload,db);
 if(/^(?:себе|мне|я)$/iu.test(value))return people.find(person=>person.id===actor.id);
 const exact=people.filter(person=>person.id.toLowerCase()===value.toLowerCase()||personName(person.name)===personName(value));
 if(exact.length===1)return exact[0];
 const wanted=tokenNames(value);
 if(!wanted.length||exact.length>1)return undefined;
 const matches=people.filter(person=>{
  const tokens=tokenNames(person.name);
  return wanted.every(word=>tokens.some(token=>relatedName(token,word)));
 });
 return matches.length===1?matches[0]:undefined;
}

const weekdays=['понедельник','вторник','сред','четверг','пятниц','суббот','воскресень'];
function parseDays(value:string){
 if(/будн/iu.test(value))return '1,2,3,4,5';
 if(/^\d(?:\s*,\s*\d)*$/.test(value)){
  const days=[...new Set(value.split(',').map(Number))];
  return days.every(day=>day>=1&&day<=7)?days.join(','):null;
 }
 const days=weekdays.flatMap((day,index)=>value.toLocaleLowerCase('ru-RU').includes(day)?[index+1]:[]);
 return days.length?days.join(','):null;
}
export async function normalizeActionField(actor:User,payload:Payload,f:Field,input:string,db:Db,parseDate:(value:string)=>string,now=new Date()){
 const value=input.trim();
 assert(value.length>=f.min&&value.length<=(f.max||4000),400,`Ответ: от ${f.min} до ${f.max||4000} символов.`);
 if(f.key==='deadline'){
  if(payload.kind==='create_task'&&/^без срока$/iu.test(value))return 'none';
  return parseDate(spokenDeadline(value,now,payload.values?.dueDay)?.stamp||value);
 }
 if(f.key==='assignee'){
  const person=await resolveAssignee(actor,payload,value,db);
  assert(person,400,'Исполнитель не определён. Назовите имя и фамилию из доступного списка или скажите «себе».');
  return person.id;
 }
 if(f.key==='price'){
  const price=parsePrice(spokenPrice(value));
  assert(price!==null,400,'Укажите цену в рублях, например 1500 или 5 тысяч.');
  return String(price);
 }
 if(f.key==='days'){
  const days=parseDays(value);assert(days,400,'Укажите дни недели, например «понедельник и среда».');return days;
 }
 if(f.key==='times'){
  const parsed=value.split(/\s*(?:,|\s+и\s+)\s*/u).map(time=>spokenTime(time));
  assert(parsed.every(time=>time&&!time.rest),400,'Время: ЧЧ:ММ, до 8 различных времён через запятую.');
  const times=parsed.map(time=>time!.time);
  assert(times.length<=8&&new Set(times).size===times.length,400,'Время: ЧЧ:ММ, до 8 различных времён через запятую.');
  return times.join(',');
 }
 if(f.key==='weeks'){
  const input=value.toLocaleLowerCase('ru-RU').replace(/\s+недел[юиь]$/u,'');
  const words:Record<string,string>={одна:'1',одну:'1',две:'2',три:'3',четыре:'4'};
  const weeks=words[input]||input;
  assert(/^\d{1,2}$/.test(weeks)&&Number(weeks)>=1&&Number(weeks)<=52,400,'Введите число недель от 1 до 52.');
  return weeks;
 }
 if((f.key==='description'||f.key==='instruction')&&/^пропустить$/iu.test(value))return '';
 return value;
}

export async function prepareVoiceAction(actor:User,intent:VoiceIntent,db:Db){
 if(intent.kind==='create_task')return {payload:{op:'form',kind:intent.kind} as Payload,title:''};
 const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1',[intent.id])).rows[0];
 assert(task&&canSee(actor,task),404,'Задача не найдена или недоступна. Проверьте номер в «Мои задачи».');
 let kind=intent.kind;
 if(kind==='submit'&&task.status==='review'&&canReview(actor,task))kind='accept';
 const payload:Payload={op:'form',id:task.id,kind,version:task.version};
 const pending=(await db.query<Approval>("SELECT * FROM approvals WHERE task_id=$1 AND state='pending' ORDER BY created_at DESC LIMIT 1",[task.id])).rows[0];
 if(kind==='submit'||kind==='deadline'){
  assert(canRequest(actor,task)&&task.status==='active',409,'Действие доступно по задаче в работе.');
  assert(!pending,409,'Сначала завершите активное согласование.');
 }
 if(kind==='accept'||kind==='return')assert(task.status==='review'&&canReview(actor,task)&&!pending,409,'Результат должен ожидать вашей приёмки.');
 if(['approve','reject','clarify','clarification'].includes(kind)){
  assert(pending,409,'Согласование уже завершено или ещё не началось.');
  const waiting=!!pending.clarification_requested_at&&!pending.clarification_answered_at;
  if(kind==='clarification')assert(waiting&&pending.requester_id===actor.id,403,'Ответ на уточнение ждут от автора запроса.');
  else assert(!waiting&&pending.route[pending.current_step]?.userId===actor.id,403,'Сейчас нужен ответ автора или решение другого согласующего.');
  Object.assign(payload,{target:pending.id,step:pending.current_step,revision:pending.action_revision});
 }
 if(kind==='answer'){
  const items=(await db.query("SELECT id FROM control_requests WHERE task_id=$1 AND state IN ('waiting','escalated') AND (assignee_id=$2 OR $3)",[task.id,actor.id,actor.role==='admin'])).rows;
  assert(items.length===1,409,'Откройте обсуждение задачи и выберите запрос, на который нужно ответить.');
  payload.target=items[0].id;
 }
 if(kind.startsWith('edit_'))assert(task.status==='active'&&canEdit(actor,task),403,'Редактирование доступно постановщику или руководителю по задаче в работе.');
 if(kind==='delegate')assert(canManage(actor)&&task.status==='active',403,'Делегирование доступно руководителю по задаче в работе.');
 if(kind==='reminder'||kind==='reminder_once')assert(task.status!=='completed',409,'Задача уже завершена.');
 if(kind==='undo'){
  const action=await lastUndo(actor,task.id,db);assert(action,409,'Нет действия, которое можно отменить за последние пять минут.');payload.target=action.id;
 }
 return {payload,title:task.title};
}
