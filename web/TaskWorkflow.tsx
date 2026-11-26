import {TaskId} from './TaskId.js';
import {taskNumber} from '../shared/task-number.js';
import {TaskGroupPicker} from './TaskGroups.js';
import {VoiceRecorder} from './VoiceRecorder.js';
import {transcribeVoice} from './ClientNotes.js';
import {CompanyPicker,TaskHints,TaskTemplates,deadlineShortcut,type TemplateContent} from './TaskComposeTools.js';
import {taskPrice} from '../shared/pricing.js';
import {api} from './api.js';
import {useEffect,useState} from 'react';
import type {ApprovalScope,Task,User} from '../shared/types.js';
import {canComplete,canReview} from '../shared/actions.js';
import {TaskPeople} from './TaskPeople.js';
import {EmployeeFilter} from './SearchFilter.js';
import {plannedInterval} from '../shared/analytics.js';
import {unassignedBranch} from '../shared/branches.js';
import {taskRequiresResult} from '../shared/queues.js';
type Act=(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>;
const deadlineWithdrawalNote='Запрос на перенос снимется. Крайний срок останется прежним.';
export function TaskPriceEditor({task,busy,act}:{task:Task;busy:boolean;act:Act}){
 const [open,setOpen]=useState(false),[price,setPrice]=useState('');
 if(!open)return <button type="button" className="text-button" onClick={()=>{setPrice(String(taskPrice(task)??''));setOpen(true);}}>Изменить цену</button>;
 return <form className="task-price-editor" onSubmit={e=>{
  e.preventDefault();
  void act('/tasks/'+task.id+'/price',{price:Number(price),expectedVersion:task.version},'PATCH','Цена задачи сохранена').then(ok=>{if(ok)setOpen(false);});
 }}>
  <label>Новая цена, ₽<input autoFocus type="number" required min="0" max="999999999999.99" step="0.01" value={price}
   onChange={e=>setPrice(e.target.value)}/></label>
  <div className="task-price-actions">
   <button className="button primary" disabled={busy}>Сохранить</button>
   <button type="button" className="text-button" onClick={()=>setOpen(false)}>Отмена</button>
  </div>
 </form>;
}
export function ReviewActions({task,user,busy,act,scope,withdrawsDeadline=false}: {task:Task;user:User;busy:boolean;act:Act;scope?:ApprovalScope|null;withdrawsDeadline?:boolean}){
 const [comment,setComment]=useState('');
 const submit=user.id===task.assignee_id||user.id===task.creator_id||['admin','director','sales_head','branch_manager'].includes(user.role);
 const reviewer=canReview(user,task,scope);
 if(canComplete(user,task,scope)||task.status==='completed'||task.status==='active'&&!submit||task.status==='review'&&!reviewer)return null;
 const requiresResult=taskRequiresResult(task);
 return <section className="review-actions"><h3>{task.status==='review'?'Принять результат работы':'Сдать работу на приёмку'}</h3><p>{task.status==='review'?'Примите результат или верните задачу исполнителю с замечаниями.':requiresResult?'Укажите выполненный результат. Задача перейдёт в отдельную очередь приёмки.':'Передайте выполненную задачу постановщику. При необходимости добавьте комментарий.'}</p>{withdrawsDeadline&&<p className="muted">{deadlineWithdrawalNote}</p>}<label>{task.status==='review'?'Комментарий (при возврате обязателен)':requiresResult?'Результат работы':'Результат или комментарий · необязательно'}<textarea value={comment} maxLength={4000} onChange={e=>setComment(e.target.value)} placeholder="Что выполнено, где результат или что нужно исправить…"/></label><div className="drawer-actions">{(task.status==='review'?['accept','return']:['submit']).map(action=><button key={action} className={`button ${action==='return'?'secondary':'primary'}`} disabled={busy||((action==='return'||action==='submit'&&requiresResult)&&comment.trim().length<5)} onClick={()=>void act(`/tasks/${task.id}/review`,{action,comment,expectedVersion:task.version}).then(ok=>{if(ok)setComment('');})}>{({submit:'Передать на приёмку',accept:'Принять и завершить',return:'Вернуть в работу'} as Record<string,string>)[action]}</button>)}</div></section>;
}
export function CompleteTaskDialog({task,users,busy,error,save,close,withdrawsDeadline=false,action='complete'}:{
 task:Task;users:User[];busy:boolean;error:string;save:(comment:string)=>Promise<boolean>;close:()=>void;withdrawsDeadline?:boolean;action?:'complete'|'submit'|'accept';
}){
 const [comment,setComment]=useState('');
 const requiresResult=action!=='accept'&&taskRequiresResult(task);
 const title=action==='accept'?'Принять результат':action==='submit'?'Сдать результат':'Завершить задачу';
 return <div className="modal-backdrop"><form className="modal task-editor" role="dialog" aria-modal="true" aria-labelledby="complete-task-heading"
  onSubmit={async event=>{event.preventDefault();if(await save(comment))close();}}>
  <div className="panel-heading"><h2 id="complete-task-heading">{title}</h2>
   <button className="icon-button" type="button" disabled={busy} onClick={close} aria-label="Закрыть">✕</button></div>
  <p className="eyebrow"><TaskId number={taskNumber(task)}/></p><h3>{task.title}</h3>
  <TaskPeople task={task} users={users}/>
  {action==='submit'&&<p className="muted">Результат будет передан постановщику на приёмку.</p>}
  {withdrawsDeadline&&<p className="muted">{deadlineWithdrawalNote}</p>}
  <label>{requiresResult?'Результат работы · обязательно':'Результат или комментарий · необязательно'}<textarea required={requiresResult} minLength={requiresResult?5:undefined} maxLength={4000} value={comment} onChange={event=>setComment(event.target.value)}/></label>
  {error&&<p className="alert error" role="alert">{error}</p>}
  <div className="drawer-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Отмена</button>
   <button type="submit" className="button primary" disabled={busy||task.status==='completed'}>{task.status==='completed'?'Задача завершена':title}</button></div>
 </form></div>;
}
const localDate=(value:string|null|undefined)=>value?new Date(new Date(value).getTime()+10800000).toISOString().slice(0,16):'';
type TaskDraft={
 title:string;description:string;price:string;owner:string;deadline:string;branch:string;companyId:string|null;
 important:boolean|null;risk:boolean|null;mode:string;fields:NonNullable<Task['custom_fields']>;
 schedule:Record<string,string>;extra:Record<string,string>;
};
function readDraft(key:string):Partial<TaskDraft>{
 try{return JSON.parse(sessionStorage.getItem(key)||'{}')??{};}catch{return {};}
}
function storeDraft(key:string,value?:TaskDraft){
 try{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);}catch{}
}
export function TaskEditor({task,copyOf,parent,users,user,busy,save,saveError,close,showPlanning,onConditional,companyId:initialCompany,canLink,availableTasks}:{
 task:Task|null;showPlanning:boolean;users:User[];user:User;busy:boolean;save:Act;close:()=>void;
 copyOf?:Task;parent?:Task;
 saveError?:string;
 onConditional?:(draft:import('./WorkDesign.js').ProcessDraft)=>void;
 companyId?:string|null;canLink:boolean;availableTasks:Task[];
}){
 const initial=task??copyOf;
 const draftKey='ruspet-task-draft:'+user.id+':'+(task?'edit:'+task.id+':'+task.version:copyOf?'copy:'+copyOf.id:'new:'+(parent?.id??initialCompany??''));
 const [draft]=useState(()=>readDraft(draftKey));
 const [copyRequestId]=useState(()=>copyOf?crypto.randomUUID():undefined);
 const [error,setError]=useState(''),[assignees,setAssignees]=useState<User[]|null>(null),[assigneeRetry,setAssigneeRetry]=useState(0);
 const [title,setTitle]=useState(draft.title??initial?.title??''),[description,setDescription]=useState(draft.description??initial?.description??'');
 const [price,setPrice]=useState(draft.price??(initial?String(taskPrice(initial)??''):''));
 const [owner,setOwner]=useState(draft.owner??initial?.assignee_id??user.id),[deadline,setDeadline]=useState(draft.deadline??localDate(copyOf?.deadline));
 const [branch,setBranch]=useState(draft.branch??(initial&&initial.branch_id!==unassignedBranch?initial.branch_id:''));
 const [companyId,setCompanyId]=useState(draft.companyId===undefined?initial?.company_id??initialCompany??parent?.company_id??null:draft.companyId);
 const [important,setImportant]=useState(draft.important===undefined?initial?.important??null:draft.important);
 const [risk,setRisk]=useState(draft.risk===undefined?initial?.customer_risk??null:draft.risk);
 const [mode,setMode]=useState(draft.mode==='conditional'&&!onConditional?'once':draft.mode??'once'),[fields,setFields]=useState(draft.fields??initial?.custom_fields??[]);
 const [schedule,setSchedule]=useState(draft.schedule??{});
 const [extra,setExtra]=useState(draft.extra??{});
 const [edited,setEdited]=useState(false),[voice,setVoice]=useState(false),[voiceHint,setVoiceHint]=useState('');
 useEffect(()=>{
  if(initial)return;
  let live=true;
  void api<{enabled:boolean}>('/bot/voice').then(value=>{if(live)setVoice(value.enabled);}).catch(()=>{});
  return()=>{live=false;};
 },[initial]);
 useEffect(()=>{
  if(edited)storeDraft(draftKey,{title,description,price,owner,deadline,branch,companyId,important,risk,mode,fields,schedule,extra});
 },[edited,draftKey,title,description,price,owner,deadline,branch,companyId,important,risk,mode,fields,schedule,extra]);
 useEffect(()=>{
  let live=true;
  setError('');setAssignees(null);
  api<User[]>(task?`/tasks/${encodeURIComponent(task.id)}/assignees`:'/task-assignees')
   .then(options=>{if(live)setAssignees(options);}).catch(e=>{if(live)setError(e.message);});
  return()=>{live=false;};
 },[task?.id,user.id,assigneeRetry]);
 function applyTemplate(value:TemplateContent){
  setEdited(true);
  if(!title.trim())setTitle(value.title);
  if(!description.trim())setDescription(value.description);
  if(price===''&&value.price!==undefined)setPrice(String(value.price));
  const known=new Set(fields.map(f=>f.label.toLocaleLowerCase('ru-RU')));
  setFields([...fields,...value.customFields.filter(f=>!known.has(f.label.toLocaleLowerCase('ru-RU')))].slice(0,12));
  if(important===null&&value.important!==undefined)setImportant(value.important);
  if(risk===null&&value.customerRisk!==undefined)setRisk(value.customerRisk);
 }
 const plan=initial?plannedInterval(initial):{start:null,end:null};
 const canSetBranch=['admin','director','sales_head'].includes(user.role);
 const allowedOwners=assignees??users.filter(person=>person.id===owner);
 const branches=[...new Set(users.map(person=>person.branch_id).filter(id=>id&&id!==unassignedBranch))].sort((a,b)=>a.localeCompare(b,'ru'));
 const ownerAllowed=!!assignees?.some(person=>person.id===owner);
 const assignedToCreator=mode!=='conditional'&&owner===(task?.creator_id??user.id);
 const heading=task?'Редактировать задачу':copyOf?'Копия задачи':parent?'Новая подзадача':'Новая задача';
 return <div className="modal-backdrop"><form className="modal task-editor task-compose-editor" role="dialog" aria-modal="true" aria-label={heading}
  onChangeCapture={()=>setEdited(true)}
  onInvalid={event=>{const section=(event.target as HTMLElement).closest('details');if(section)section.open=true;}}
  onSubmit={async e=>{
  e.preventDefault();
  if(!ownerAllowed)return;
  const f=new FormData(e.currentTarget);
  const date=(key:string,original?:string|null)=>{
   const value=f.get(key);
   return value?original&&localDate(original)===value?original:new Date(String(value)+':00+03:00').toISOString():null;
  };
  const common={price:Number(f.get('price')),title:String(f.get('title')),description:String(f.get('description')),
   assigneeId:owner,customFields:fields,priority:extra.priority??initial?.priority??'normal',
   critical:(extra.critical??String(initial?.critical??false))==='true',resultRequired:(extra.resultRequired??String(initial?.result_required??true))==='true',...(canLink?{companyId}:{}),...(canSetBranch&&branch&&mode!=='conditional'?{branchId:branch}:{})};
  const body={...common,deadline:task?task.deadline:date('deadline',copyOf?.deadline),plannedStart:showPlanning?date('plannedStart',plan.start):initial?.planned_start||null,
   plannedEnd:showPlanning?date('plannedEnd',plan.end):initial?.planned_end||null,important,customerRisk:risk,
   parentId:String(f.get('parentId')||'').trim()||null,...(!task&&mode==='once'&&extra.groupId?{groupId:extra.groupId}:{}),...(task?{expectedVersion:task.version,reason:f.get('reason')}:copyOf?{requestId:copyRequestId}:{})};
  if(mode==='conditional'&&onConditional){storeDraft(draftKey);onConditional(common);return;}
  const success=mode==='repeat'?await save('/work-design/schedules',{
   template:body,frequency:f.get('frequency'),every:Number(f.get('every')),startsAt:date('startsAt'),
   deadlineHours:f.get('deadlineHours')?Number(f.get('deadlineHours')):null
  },'POST','Расписание сохранено'):await save(task?`/tasks/${encodeURIComponent(task.id)}`:copyOf?`/tasks/${encodeURIComponent(copyOf.id)}/copy`:'/tasks',body,task?'PUT':'POST',copyOf?'Копия создана':undefined);
  if(success){storeDraft(draftKey);close();}
 }}>
  <div className="panel-heading"><div><h2>{heading}</h2>{parent&&<p>Родительская задача <TaskId number={taskNumber(parent)}/> · {parent.title}</p>}{copyOf&&<p>Исходная задача <TaskId number={taskNumber(copyOf)}/>. Проверьте поля перед созданием.</p>}</div><button type="button" className="icon-button" onClick={close} aria-label="Закрыть">✕</button></div>
  <div className="task-compose-body">
  {draft.title!==undefined&&<div className="task-draft-banner"><span>Черновик восстановлен</span><button type="button" className="text-button" onClick={()=>{storeDraft(draftKey);close();}}>Удалить черновик</button></div>}
  {saveError&&<p className="alert error" role="alert">{saveError}</p>}
  {!initial&&<fieldset className="task-mode"><legend>Когда создавать</legend><div>
   {([{id:'once',label:'Разовая',detail:'Поставить сейчас'},{id:'repeat',label:'Регулярная',detail:'По расписанию'},
    ...(onConditional?[{id:'conditional',label:'По условию',detail:'При событии в процессе'}]:[])]).map(item=><label key={item.id}>
    <input type="radio" name="createMode" value={item.id} checked={mode===item.id} onChange={()=>setMode(item.id)}/>
    <span><strong>{item.label}</strong><small>{item.detail}</small></span>
   </label>)}
  </div></fieldset>}
  {!initial&&<TaskTemplates user={user} canShare={canLink} read={()=>({title,description,price:price===''?undefined:Number(price),customFields:fields,important,customerRisk:risk})} apply={applyTemplate}/>}
  {voice&&!initial&&<div className="task-voice-draft">
   <div className="drawer-actions"><VoiceRecorder label="Заполнить голосом" hint="Назовите задачу, исполнителя, цену и крайний срок. Например: «Сверить договор. Исполнитель Иван Петров. Цена 1500. Срок завтра в 15:00»." disabled={busy} onSend={async audio=>{
    const draft=await transcribeVoice(audio,'task'),values=draft.values??{};
    setEdited(true);setTitle((values.title||draft.transcript).slice(0,500));
    if(values.description)setDescription(values.description.slice(0,10000));
    if(values.price&&Number.isFinite(Number(values.price)))setPrice(values.price);
    if(draft.deadline)setDeadline(localDate(draft.deadline));
    else if(/^без срока$/iu.test(values.deadline??''))setDeadline('');
    if(draft.assigneeId){setOwner(draft.assigneeId);setBranch('');}
    setVoiceHint(values.assignee&&!draft.assigneeId?'Уточните исполнителя вручную. Черновик заполнен.':'Черновик заполнен. Проверьте поля перед созданием.');
   }}/></div>
   {voiceHint&&<small role="status">{voiceHint}</small>}
  </div>}
  <label>Название<input autoFocus name="title" required minLength={3} maxLength={500} value={title} onChange={e=>setTitle(e.target.value)}/></label>
  <label>Описание<textarea name="description" maxLength={10000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
  <div className="editor-grid">
   <div>
    <EmployeeFilter caption="Исполнитель" label="Исполнитель задачи" value={owner} people={allowedOwners} disabled={!assignees} onChange={value=>{
     setEdited(true);setOwner(value);setBranch(value===initial?.assignee_id&&initial.branch_id!==unassignedBranch?initial.branch_id:'');
    }}/>
    {!assignees&&(error?<div className="alert error" role="alert">Не удалось загрузить список сотрудников. <button type="button" className="text-button" onClick={()=>setAssigneeRetry(n=>n+1)}>Повторить</button></div>:
     <small className="muted" role="status">Загружаем сотрудников…</small>)}
    {assignees&&!ownerAllowed&&<small className="muted">Выберите доступного исполнителя.</small>}
   </div>
   <label>Цена задачи · ₽<input name="price" type="number" required min="0" max="999999999999.99" step="0.01" value={price} onChange={e=>setPrice(e.target.value)}/></label>
  </div>
  {canSetBranch&&mode!=='conditional'&&<label>Филиал или подразделение задачи<select value={branch} onChange={e=>setBranch(e.target.value)}>
   <option value="">По умолчанию · {initial?.assignee_id===owner?initial.branch_id:allowedOwners.find(person=>person.id===owner)?.branch_id??unassignedBranch}</option>
   {branch&&!branches.includes(branch)&&<option value={branch}>{branch}</option>}
   {branches.map(id=><option key={id} value={id}>{id}</option>)}
  </select></label>}
  <div className="editor-grid">
   <label>Приоритет<select value={extra.priority??initial?.priority??'normal'} onChange={e=>setExtra({...extra,priority:e.target.value})}><option value="normal">Обычный</option><option value="high">Высокий</option></select></label>
   <label>Критичность<select value={extra.critical??String(initial?.critical??false)} onChange={e=>setExtra({...extra,critical:e.target.value})}><option value="false">Обычная</option><option value="true">Критичная</option></select></label>
   {(!task||task.creator_id===user.id||user.role==='admin')&&<label>Результат при завершении<select disabled={assignedToCreator} value={assignedToCreator?'false':extra.resultRequired??String(initial?.result_required??true)} onChange={e=>setExtra({...extra,resultRequired:e.target.value})}><option value="true">Обязателен</option><option value="false">{assignedToCreator?'Необязателен для задачи себе':'Необязателен'}</option></select></label>}
  </div>
  {!task&&mode==='once'&&<TaskGroupPicker value={extra.groupId??''} onChange={id=>{setEdited(true);setExtra(current=>({...current,groupId:id}));}}/>}
  {canLink&&<CompanyPicker value={companyId} onChange={value=>{setEdited(true);setCompanyId(value);}}/>}
  {!task&&mode==='once'&&<><label>Крайний срок · МСК<input type="datetime-local" name="deadline" value={deadline} onChange={e=>setDeadline(e.target.value)}/></label>
   <div className="task-quick-actions">{[[0,'Сегодня, 18:00'],[1,'Завтра, 18:00'],[7,'Через неделю']].map(([days,label])=><button className="button secondary" key={days} type="button" disabled={new Date(deadlineShortcut(Number(days))+':00+03:00')<=new Date()} onClick={()=>{setEdited(true);setDeadline(deadlineShortcut(Number(days)));}}>{label}</button>)}</div>
   {deadline&&new Date(deadline+':00+03:00')<new Date()&&<p className="muted">Этот срок уже прошёл. Проверьте дату перед сохранением.</p>}
  </>}
  {!initial&&<TaskHints title={title} description={description} companyId={companyId} tasks={availableTasks} users={users} owner={owner}/>}
  {mode==='repeat'&&<div className="editor-grid">
   <label>Первый запуск · МСК<input type="datetime-local" name="startsAt" required value={schedule.startsAt??''} onChange={e=>setSchedule({...schedule,startsAt:e.target.value})}/></label>
   <label>Повторять<select name="frequency" value={schedule.frequency??'daily'} onChange={e=>setSchedule({...schedule,frequency:e.target.value})}><option value="daily">По дням</option><option value="weekly">По неделям</option><option value="monthly">По месяцам</option></select></label>
   <label>Интервал<input name="every" type="number" required min="1" max="30" value={schedule.every??'1'} onChange={e=>setSchedule({...schedule,every:e.target.value})}/></label>
   <label>Срок после запуска · часов<input name="deadlineHours" type="number" min="1" max="8760" placeholder="Без срока" value={schedule.deadlineHours??''} onChange={e=>setSchedule({...schedule,deadlineHours:e.target.value})}/></label>
  </div>}
  {task&&<p className="muted">Крайний срок меняется через запрос переноса. Открытое согласование сохранится и покажет, какие поля изменились.</p>}
  <details className="compose-extra"><summary>Дополнительные параметры{fields.length?' · '+fields.length+' полей':''}</summary>
  {mode!=='conditional'&&<>
   <div className="editor-grid">{showPlanning&&mode==='once'&&<><label>Плановое начало · МСК<input name="plannedStart" type="datetime-local" value={extra.plannedStart??localDate(plan.start)} onChange={e=>setExtra({...extra,plannedStart:e.target.value})}/></label><label>Плановое окончание · МСК<input name="plannedEnd" type="datetime-local" value={extra.plannedEnd??localDate(plan.end)} onChange={e=>setExtra({...extra,plannedEnd:e.target.value})}/></label></>}
    {[{name:'important',label:'Важная задача',value:important,set:setImportant},{name:'customerRisk',label:'Риск потери клиента',value:risk,set:setRisk}].map(v=><label key={v.name}>{v.label}<select name={v.name} value={v.value===true?'yes':v.value===false?'no':'unknown'} onChange={e=>v.set(e.target.value==='unknown'?null:e.target.value==='yes')}><option value="unknown">Не указано</option><option value="yes">Да</option><option value="no">Нет</option></select></label>)}
   </div>
   <label>ID родительской задачи<input name="parentId" value={extra.parentId??parent?.id??initial?.parent_id??''} onChange={e=>setExtra({...extra,parentId:e.target.value})} placeholder="Необязательно"/></label>
  </>}
  <fieldset className="task-custom-fields"><legend>Дополнительные поля</legend>
   {fields.map((field,index)=><div className="field-row" key={index}>
    <input aria-label={'Название поля '+(index+1)} placeholder="Поле, например номер заказа" required maxLength={80} value={field.label} onChange={e=>setFields(fields.map((item,i)=>i===index?{...item,label:e.target.value}:item))}/>
    <input aria-label={'Значение поля '+(index+1)} placeholder="Значение" maxLength={500} value={field.value} onChange={e=>setFields(fields.map((item,i)=>i===index?{...item,value:e.target.value}:item))}/>
    <button className="icon-button" aria-label={'Удалить поле '+(index+1)} type="button" onClick={()=>{setEdited(true);setFields(fields.filter((_,i)=>i!==index));}}>✕</button>
   </div>)}
   <button className="text-button" type="button" disabled={fields.length>=12} onClick={()=>{setEdited(true);setFields([...fields,{label:'',value:''}]);}}>+ Добавить поле</button>
  </fieldset>
  </details>
  {task&&<label>Причина изменения<textarea name="reason" required minLength={5} maxLength={4000} placeholder="Что меняется и почему" value={extra.reason??''} onChange={e=>setExtra({...extra,reason:e.target.value})}/></label>}
  </div>
  <div className="drawer-actions task-editor-actions"><button type="button" className="button secondary" onClick={close}>Отмена</button><button disabled={busy||!ownerAllowed} className="button primary">{mode==='conditional'?'Настроить условие':mode==='repeat'?'Сохранить расписание':copyOf?'Создать копию':task?'Сохранить изменения':'Создать задачу'}</button></div>
 </form></div>;
}
