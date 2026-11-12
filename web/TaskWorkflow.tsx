import {CompanyPicker,TaskHints,TaskTemplates,deadlineShortcut,type TemplateContent} from './TaskComposeTools.js';
import {taskPrice} from '../shared/pricing.js';
import {api} from './api.js';
import {useEffect,useState} from 'react';
import type {Task,User} from '../shared/types.js';
import {plannedInterval} from '../shared/analytics.js';
type Act=(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>;
export function ReviewActions({task,user,busy,pending,act}: {task:Task;user:User;busy:boolean;pending:boolean;act:Act}){
 const [comment,setComment]=useState('');
 const submit=user.id===task.assignee_id||user.id===task.creator_id||['admin','director','sales_head','branch_manager'].includes(user.role);
 const reviewer=user.id!==task.assignee_id&&(user.id===task.creator_id||['admin','director','sales_head','branch_manager'].includes(user.role));
 if(task.status==='completed'||task.status==='active'&&!submit||task.status==='review'&&!reviewer)return null;
 return <section className="review-actions"><h3>{task.status==='review'?'Принять результат работы':'Сдать работу на приёмку'}</h3><p>{task.status==='review'?'Примите результат или верните задачу исполнителю с замечаниями.':'Укажите выполненный результат. Задача перейдёт в отдельную очередь приёмки.'}</p><label>{task.status==='review'?'Комментарий (при возврате обязателен)':'Результат работы'}<textarea value={comment} maxLength={4000} onChange={e=>setComment(e.target.value)} placeholder="Что выполнено, где результат или что нужно исправить…"/></label><div className="drawer-actions">{(task.status==='review'?['accept','return']:['submit']).map(action=><button key={action} className={`button ${action==='return'?'secondary':'primary'}`} disabled={busy||pending||(action!=='accept'&&comment.trim().length<5)} onClick={()=>void act(`/tasks/${task.id}/review`,{action,comment,expectedVersion:task.version}).then(ok=>{if(ok)setComment('');})}>{({submit:'Передать на приёмку',accept:'Принять и завершить',return:'Вернуть в работу'} as Record<string,string>)[action]}</button>)}</div>{pending&&<p className="muted">Сначала завершите активный маршрут согласования.</p>}</section>;
}
const localDate=(value:string|null|undefined)=>value?new Date(new Date(value).getTime()+10800000).toISOString().slice(0,16):'';
export function TaskEditor({task,copyOf,users,user,busy,save,saveError,close,showPlanning,onConditional,companyId:initialCompany,canLink,availableTasks}:{
 task:Task|null;showPlanning:boolean;users:User[];user:User;busy:boolean;save:Act;close:()=>void;
 copyOf?:Task;
 saveError?:string;
 onConditional?:(draft:import('./WorkDesign.js').ProcessDraft)=>void;
 companyId?:string|null;canLink:boolean;availableTasks:Task[];
}){
 const initial=task??copyOf;
 const [copyRequestId]=useState(()=>copyOf?crypto.randomUUID():undefined);
 const [error,setError]=useState(''),[assignees,setAssignees]=useState(users);
 const [title,setTitle]=useState(initial?.title??''),[description,setDescription]=useState(initial?.description??'');
 const [price,setPrice]=useState(initial?String(taskPrice(initial)??''):'');
 const [owner,setOwner]=useState(initial?.assignee_id||user.id),[deadline,setDeadline]=useState(localDate(copyOf?.deadline));
 const [companyId,setCompanyId]=useState(initial?.company_id??initialCompany??null);
 const [important,setImportant]=useState(initial?.important??null),[risk,setRisk]=useState(initial?.customer_risk??null);
 const [mode,setMode]=useState('once'),[fields,setFields]=useState(initial?.custom_fields??[]);
 useEffect(()=>{
  if(!task)return;
  let live=true;
  api<User[]>(`/tasks/${task.id}/assignees`).then(a=>{if(live)setAssignees(a);}).catch(e=>{if(live)setError(e.message);});
  return()=>{live=false;};
 },[task?.id,user.id]);
 function applyTemplate(value:TemplateContent){
  if(!title.trim())setTitle(value.title);
  if(!description.trim())setDescription(value.description);
  if(price===''&&value.price!==undefined)setPrice(String(value.price));
  const known=new Set(fields.map(f=>f.label.toLocaleLowerCase('ru-RU')));
  setFields([...fields,...value.customFields.filter(f=>!known.has(f.label.toLocaleLowerCase('ru-RU')))].slice(0,12));
  if(important===null&&value.important!==undefined)setImportant(value.important);
  if(risk===null&&value.customerRisk!==undefined)setRisk(value.customerRisk);
 }
 const plan=initial?plannedInterval(initial):{start:null,end:null};
 const allowedOwners=assignees.filter(person=>person.id===task?.assignee_id||user.id===task?.creator_id||['admin','director','sales_head'].includes(user.role)||person.id===user.id||user.role==='branch_manager'&&person.branch_id===user.branch_id);
 const ownerAllowed=allowedOwners.some(person=>person.id===owner);
 const heading=task?'Редактировать задачу':copyOf?'Копия задачи':'Новая задача';
 return <div className="modal-backdrop"><form className="modal task-editor task-compose-editor" role="dialog" aria-modal="true" aria-label={heading} onSubmit={async e=>{
  e.preventDefault();
  if(!ownerAllowed)return;
  const f=new FormData(e.currentTarget);
  const date=(key:string,original?:string|null)=>{
   const value=f.get(key);
   return value?original&&localDate(original)===value?original:new Date(String(value)+':00+03:00').toISOString():null;
  };
  const common={price:Number(f.get('price')),title:String(f.get('title')),description:String(f.get('description')),
   assigneeId:owner,customFields:fields,...(canLink?{companyId}:{})};
  const body={...common,deadline:task?task.deadline:date('deadline',copyOf?.deadline),plannedStart:showPlanning?date('plannedStart',plan.start):initial?.planned_start||null,
   plannedEnd:showPlanning?date('plannedEnd',plan.end):initial?.planned_end||null,important,customerRisk:risk,
   parentId:String(f.get('parentId')||'').trim()||null,...(task?{expectedVersion:task.version,reason:f.get('reason')}:copyOf?{requestId:copyRequestId}:{})};
  if(mode==='conditional'&&onConditional){onConditional(common);return;}
  const success=mode==='repeat'?await save('/work-design/schedules',{
   template:body,frequency:f.get('frequency'),every:Number(f.get('every')),startsAt:date('startsAt'),
   deadlineHours:f.get('deadlineHours')?Number(f.get('deadlineHours')):null
  },'POST','Расписание сохранено'):await save(task?`/tasks/${encodeURIComponent(task.id)}`:copyOf?`/tasks/${encodeURIComponent(copyOf.id)}/copy`:'/tasks',body,task?'PUT':'POST',copyOf?'Копия создана':undefined);
  if(success)close();
 }}>
  <div className="panel-heading"><div><h2>{heading}</h2>{copyOf&&<p>Исходная задача #{copyOf.id}. Проверьте поля перед созданием.</p>}</div><button type="button" className="icon-button" onClick={close} aria-label="Закрыть">✕</button></div>
  {(saveError||error)&&<p className="alert error" role="alert">{saveError||error}</p>}
  {!initial&&<fieldset className="task-mode"><legend>Когда создавать</legend><div>
   {([{id:'once',label:'Один раз',detail:'Создать сейчас'},{id:'repeat',label:'По расписанию',detail:'Повторять по календарю'},
    ...(onConditional?[{id:'conditional',label:'По условию',detail:'По событию в процессе'}]:[])]).map(item=><label key={item.id}>
    <input type="radio" name="createMode" value={item.id} checked={mode===item.id} onChange={()=>setMode(item.id)}/>
    <span><strong>{item.label}</strong><small>{item.detail}</small></span>
   </label>)}
  </div></fieldset>}
  {!initial&&<TaskTemplates user={user} canShare={canLink} read={()=>({title,description,price:price===''?undefined:Number(price),customFields:fields,important,customerRisk:risk})} apply={applyTemplate}/>}
  <label>Название<input autoFocus name="title" required minLength={3} maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
  <label>Описание<textarea name="description" maxLength={10000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
  <div className="editor-grid">
   <label>Исполнитель<select name="assigneeId" value={owner} onChange={e=>setOwner(e.target.value)}>
    {!ownerAllowed&&<option value={owner} disabled>{users.find(person=>person.id===owner)?.name||owner} · выберите доступного сотрудника</option>}
    {allowedOwners.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}
   </select></label>
   <label>Цена задачи · ₽<input name="price" type="number" required min="0" max="999999999999.99" step="0.01" value={price} onChange={e=>setPrice(e.target.value)}/></label>
  </div>
  {canLink&&<CompanyPicker value={companyId} onChange={setCompanyId}/>}
  {!task&&mode==='once'&&<><label>Крайний срок · МСК<input type="datetime-local" name="deadline" value={deadline} onChange={e=>setDeadline(e.target.value)}/></label>
   <div className="task-quick-actions">{[[0,'Сегодня, 18:00'],[1,'Завтра, 18:00'],[7,'Через неделю']].map(([days,label])=><button className="button secondary" key={days} type="button" disabled={new Date(deadlineShortcut(Number(days))+':00+03:00')<=new Date()} onClick={()=>setDeadline(deadlineShortcut(Number(days)))}>{label}</button>)}</div>
   {deadline&&new Date(deadline+':00+03:00')<new Date()&&<p className="muted">Этот срок уже прошёл. Проверьте дату перед сохранением.</p>}
  </>}
  {!initial&&<TaskHints title={title} description={description} companyId={companyId} tasks={availableTasks} users={users} owner={owner}/>}
  {mode==='repeat'&&<div className="editor-grid">
   <label>Первый запуск · МСК<input type="datetime-local" name="startsAt" required/></label>
   <label>Повторять<select name="frequency"><option value="daily">По дням</option><option value="weekly">По неделям</option><option value="monthly">По месяцам</option></select></label>
   <label>Интервал<input name="every" type="number" required min="1" max="30" defaultValue="1"/></label>
   <label>Срок после запуска · часов<input name="deadlineHours" type="number" min="1" max="8760" placeholder="Без срока"/></label>
  </div>}
  {task&&<p className="muted">Крайний срок меняется через запрос переноса. Изменение параметров отменит актуальность открытого согласования.</p>}
  {mode!=='conditional'&&<>
   <div className="editor-grid">{showPlanning&&mode==='once'&&<><label>Плановое начало · МСК<input name="plannedStart" type="datetime-local" defaultValue={localDate(plan.start)}/></label><label>Плановое окончание · МСК<input name="plannedEnd" type="datetime-local" defaultValue={localDate(plan.end)}/></label></>}
    {[{name:'important',label:'Важная задача',value:important,set:setImportant},{name:'customerRisk',label:'Риск потери клиента',value:risk,set:setRisk}].map(v=><label key={v.name}>{v.label}<select name={v.name} value={v.value===true?'yes':v.value===false?'no':'unknown'} onChange={e=>v.set(e.target.value==='unknown'?null:e.target.value==='yes')}><option value="unknown">Не указано</option><option value="yes">Да</option><option value="no">Нет</option></select></label>)}
   </div>
   <label>ID родительской задачи<input name="parentId" defaultValue={initial?.parent_id||''} placeholder="Необязательно"/></label>
  </>}
  <fieldset className="task-custom-fields"><legend>Дополнительные поля</legend>
   {fields.map((field,index)=><div className="field-row" key={index}>
    <input aria-label={'Название поля '+(index+1)} placeholder="Поле, например номер заказа" required maxLength={80} value={field.label} onChange={e=>setFields(fields.map((item,i)=>i===index?{...item,label:e.target.value}:item))}/>
    <input aria-label={'Значение поля '+(index+1)} placeholder="Значение" maxLength={500} value={field.value} onChange={e=>setFields(fields.map((item,i)=>i===index?{...item,value:e.target.value}:item))}/>
    <button className="icon-button" aria-label={'Удалить поле '+(index+1)} type="button" onClick={()=>setFields(fields.filter((_,i)=>i!==index))}>✕</button>
   </div>)}
   <button className="text-button" type="button" disabled={fields.length>=12} onClick={()=>setFields([...fields,{label:'',value:''}])}>+ Добавить поле</button>
  </fieldset>
  {task&&<label>Причина изменения<textarea name="reason" required minLength={5} maxLength={4000} placeholder="Что меняется и почему"/></label>}
  <div className="drawer-actions task-editor-actions"><button type="button" className="button secondary" onClick={close}>Отмена</button><button disabled={busy||!ownerAllowed} className="button primary">{mode==='conditional'?'Настроить условие':mode==='repeat'?'Сохранить расписание':copyOf?'Создать копию':task?'Сохранить изменения':'Создать задачу'}</button></div>
 </form></div>;
}
