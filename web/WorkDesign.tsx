import {CompanyWork} from './CompanyWork.js';
import {CompanyPicker} from './TaskComposeTools.js';
import {useEffect,useState,type FormEvent} from 'react';
import {api} from './api.js';
import {moscowTimestamp} from './SystemHealth.js';
import type {User} from '../shared/types.js';

export const companyStates={prospect:'Потенциальный клиент',active:'В работе',former:'Бывший клиент'} as const;
type CompanyState=keyof typeof companyStates;
type Company={id:string;name:string;tax_id:string|null;status:CompanyState;contact:string;notes:string;version:number;updated_at:string};
export const canUseOkb=(user:User)=>['admin','director','sales_head'].includes(user.role);
const errorText=(error:unknown)=>error instanceof Error?error.message:'Не удалось выполнить запрос.';

export function Okb({initialId,users,openTask,createTask}:{initialId:string|null;users:User[];openTask:(id:string)=>void;createTask:(companyId:string)=>void}){
 const [rows,setRows]=useState<Company[]|null>(null),[query,setQuery]=useState(''),[reload,setReload]=useState(0);
 const [editor,setEditor]=useState<Company|'new'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let current=true;
  const timer=setTimeout(()=>void api<Company[]>('/okb/companies?q='+encodeURIComponent(query.trim())).then(v=>{
   if(current){setRows(v);setError('');}
  }).catch(e=>{if(current)setError(errorText(e));}),200);
  return()=>{current=false;clearTimeout(timer);};
 },[query,reload]);
 useEffect(()=>{
  if(!initialId)return;
  let active=true;
  void api<Company>('/okb/companies/'+initialId).then(row=>{if(active)setEditor(row);}).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[initialId]);
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();setBusy(true);setError('');
  const f=new FormData(event.currentTarget),existing=editor&&editor!=='new'?editor:null;
  try{
   await api('/okb/companies'+(existing?'/'+existing.id:''),existing?'PUT':'POST',{
    name:f.get('name'),taxId:String(f.get('taxId')||'').trim()||null,status:f.get('status'),contact:f.get('contact'),notes:f.get('notes'),version:existing?.version
   });
   setEditor(null);setReload(n=>n+1);
  }catch(e){setError(errorText(e));}finally{setBusy(false);}
 }
 const company=editor&&editor!=='new'?editor:null;
 return <>
  <section className="panel automation-settings"><div className="automation-heading"><div><h2>Реестр компаний</h2><p className="muted">До 100 карточек в текущей выборке. Поиск по названию и ИНН.</p></div><button className="button primary" onClick={()=>{setError('');setEditor('new');}}>Добавить компанию</button></div>
   <div className="filters"><input aria-label="Поиск по ОКБ" placeholder="Название или ИНН" value={query} onChange={e=>setQuery(e.target.value)}/><button className="button secondary" onClick={()=>setReload(n=>n+1)}>Обновить</button></div>
   {!editor&&error&&<p className="alert error" role="alert">{error}</p>}
   {!rows&&!error&&<p role="status">Загружаем компании…</p>}
   {rows?.length===0&&<p>В выборке нет компаний.</p>}
   {!!rows?.length&&<div className="table-scroll"><table><thead><tr><th>Компания</th><th>ИНН</th><th>Статус</th><th>Контакт</th><th>Обновлена</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}>
    <td><button className="text-button" onClick={()=>{setError('');setEditor(row);}}>{row.name}</button></td><td>{row.tax_id||'—'}</td><td>{companyStates[row.status]}</td><td>{row.contact||'—'}</td><td>{moscowTimestamp(row.updated_at)}</td>
   </tr>)}</tbody></table></div>}
  </section>
  {editor&&<div className="modal-backdrop"><div className="modal task-editor" role="dialog" aria-modal="true" aria-label="Карточка компании"><form key={company?.id||'new'} className="work-design-form" onSubmit={save}>
   <div className="panel-heading"><h2>{company?'Карточка компании':'Новая компания'}</h2><button className="text-button" type="button" disabled={busy} onClick={()=>setEditor(null)}>Закрыть</button></div>
   {error&&<p className="alert error" role="alert">{error}</p>}
   <label>Название<input name="name" required minLength={2} maxLength={250} defaultValue={company?.name}/></label>
   <div className="editor-grid"><label>ИНН<input name="taxId" inputMode="numeric" pattern="[0-9]{10}|[0-9]{12}" maxLength={12} defaultValue={company?.tax_id??''}/></label><label>Статус<select name="status" defaultValue={company?.status??'prospect'}>{Object.entries(companyStates).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label></div>
   <label>Контакт<input name="contact" maxLength={500} defaultValue={company?.contact}/></label>
   <label>Заметки<textarea name="notes" maxLength={4000} defaultValue={company?.notes}/></label>
   <button className="button primary" disabled={busy}>Сохранить компанию</button>
  </form>
  {company&&<CompanyWork key={company.id} id={company.id} users={users}
    openTask={id=>{setEditor(null);openTask(id);}} createTask={()=>{setEditor(null);createTask(company.id);}}
    onContact={()=>{setReload(n=>n+1);void api<Company>('/okb/companies/'+company.id).then(row=>setEditor(current=>current&&current!=='new'&&current.id===row.id?row:current)).catch(()=>{});}}/>}
  </div></div>}
 </>;
}

type Schedule={id:string;title:string;frequency:string;every:number;next_at:string;enabled:boolean;last_task_id:string|null;last_error:string|null};
type Trigger='company_status'|'company_quiet'|'task_accepted';
const triggerLabels:Record<Trigger,string>={company_status:'Новая компания или смена статуса',company_quiet:'Давно не было контакта',task_accepted:'Результат задачи принят'};
type Definition={trigger?:Trigger;companyId?:string|null;quietDays?:number;description?:string;customFields?:ProcessDraft['customFields'];name:string;field:string;operator:string;value:string;branch:'yes'|'no';title:string;assigneeId:string;price:number;deadlineHours:number|null};
type Process={id:string;name:string;definition:Definition;enabled:boolean};
type Run={process_id:string;branch:'yes'|'no';task_id:string|null;error:string|null;created_at:string};
type Preview={branch:'yes'|'no';title:string|null};
export type ProcessDraft={companyId?:string|null;title:string;assigneeId:string;price:number;description:string;customFields:{label:string;value:string}[]};

export function WorkDesign({user,users,draft,open}:{user:User;users:User[];draft:ProcessDraft|null;open:(id:string)=>void}){
 const [schedules,setSchedules]=useState<Schedule[]|null>(null),[processes,setProcesses]=useState<{items:Process[];runs:Run[]}|null>(null);
 const [reload,setReload]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [operator,setOperator]=useState('='),[field,setField]=useState('company.status'),[branch,setBranch]=useState<'yes'|'no'>('yes'),[preview,setPreview]=useState<Preview|null>(null);
 const [trigger,setTrigger]=useState<Trigger>('company_status'),[companyId,setCompanyId]=useState<string|null>(draft?.companyId??null);
 const [editing,setEditing]=useState<Process|null>(null);
 const template=editing?.definition??draft;
 const canProcess=canUseOkb(user);
 useEffect(()=>{
  let current=true;
  const load=async()=>{
   try{
    const schedules=await api<Schedule[]>('/work-design/schedules');
    if(current)setSchedules(schedules);
    if(canProcess){
     const processes=await api<{items:Process[];runs:Run[]}>('/work-design/processes');
     if(current)setProcesses(processes);
    }
   }catch(e){if(current)setError(errorText(e));}
  };
  void load();
  const timer=setInterval(()=>void load(),30000);
  return()=>{current=false;clearInterval(timer);};
 },[reload,canProcess]);
 async function toggle(path:string,enabled:boolean){
  setBusy(true);setError('');
  try{await api(path,'PATCH',{enabled});setReload(n=>n+1);}catch(e){setError(errorText(e));}finally{setBusy(false);}
 }
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  const f=new FormData(event.currentTarget);
  const definition:Definition={trigger,companyId,quietDays:trigger==='company_quiet'?Number(f.get('quietDays')):undefined,description:String(f.get('description')),customFields:template?.customFields,name:String(f.get('name')),field,operator,value:String(f.get('value')||''),branch,
   title:String(f.get('title')),assigneeId:String(f.get('assigneeId')),price:Number(f.get('price')),deadlineHours:f.get('deadlineHours')?Number(f.get('deadlineHours')):null};
  const test=(event.nativeEvent as SubmitEvent).submitter?.getAttribute('value')==='preview';
  setBusy(true);setError('');setNotice('');
  try{
   if(test)setPreview(await api<Preview>('/work-design/processes/preview','POST',{definition,sample:{name:f.get('sampleName'),status:f.get('sampleStatus'),previousStatus:f.get('samplePrevious')||null},task:trigger==='task_accepted'?{title:f.get('sampleTask'),assigneeId:f.get('sampleOwner')}:undefined}));
   else{await api('/work-design/processes'+(editing?'/'+editing.id:''),editing?'PUT':'POST',definition);setNotice('Черновик сохранён. Включите его в списке, когда будете готовы.');setReload(n=>n+1);}
  }catch(e){setError(errorText(e));}finally{setBusy(false);}
 }
 return <>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {canProcess&&<section className="panel automation-settings">
   <div className="automation-heading"><div><h2>Конструктор процессов</h2><p className="muted">Выберите событие, задайте условие и действие. Черновик можно проверить на примере.</p></div></div>
   <form key={editing?.id||"new"} className="work-design-form" onSubmit={submit} onChange={()=>setPreview(null)}>
    <label>Название процесса<input name="name" required minLength={3} maxLength={120} defaultValue={editing?.name} placeholder="Например, начать работу с новым клиентом"/></label>
    <label>Событие<select value={trigger} onChange={e=>{setTrigger(e.target.value as Trigger);setField('company.status');setOperator('=');}}>
     {Object.entries(triggerLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
    </select></label>
    {trigger==='company_quiet'&&<label>Дней без контакта<input name="quietDays" type="number" min="1" max="365" required defaultValue={editing?.definition.quietDays??14}/></label>}
    <CompanyPicker value={companyId} onChange={setCompanyId}/>
    <p className="muted">{companyId?'Процесс будет работать только для выбранной компании.':'Без привязки процесс проверяет все подходящие события.'}</p>
    <div className="process-flow"><div><small>СОБЫТИЕ</small><strong>{triggerLabels[trigger]}</strong></div><div><small>УСЛОВИЕ</small><strong>Проверить значение поля</strong></div><div><small>ДА</small><strong>{branch==='yes'?'Создать задачу':'Завершить'}</strong></div><div><small>НЕТ</small><strong>{branch==='no'?'Создать задачу':'Завершить'}</strong></div></div>
    <div className="editor-grid">
     <label>Поле<select value={field} onChange={e=>{setField(e.target.value);if(operator==='contains')setOperator('=');}}><option value="company.status">Новый статус</option>{trigger==='company_status'&&<option value="company.previousStatus">Прежний статус</option>}<option value="company.name">Название компании</option>{trigger==='task_accepted'&&<><option value="task.title">Название принятой задачи</option><option value="task.assigneeId">Исполнитель принятой задачи</option></>}</select></label>
     <label>Оператор<select value={operator} onChange={e=>setOperator(e.target.value)}><option value="=">Равно</option><option value="!=">Не равно</option>{['company.name','task.title'].includes(field)&&<option value="contains">Содержит</option>}<option value="exists">Заполнено</option></select></label>
     {operator!=='exists'&&<label>Значение{['company.name','task.title'].includes(field)?<input key={field} name="value" required maxLength={250} defaultValue={editing?.definition.field===field?editing.definition.value:undefined}/>:field==='task.assigneeId'?<select key={field} name="value" defaultValue={editing?.definition.value}>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select>:<select key={field} name="value" defaultValue={editing?.definition.field===field?editing.definition.value:undefined}>{Object.entries(companyStates).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>}</label>}
     <label>Создать задачу в ветке<select value={branch} onChange={e=>setBranch(e.target.value as 'yes'|'no')}><option value="yes">Да</option><option value="no">Нет</option></select></label>
    </div>
    <label>Название задачи<input name="title" required minLength={3} maxLength={500} defaultValue={template?.title||'Связаться с {{company.name}}'}/></label>
    <label>Описание задачи<textarea name="description" maxLength={10000} defaultValue={template?.description}/></label>
    {!!template?.customFields?.length&&<p className="muted">Дополнительные поля из шаблона · {template.customFields.map(f=>f.label).join(", ")}</p>}
    <p className="muted">Подставить название компании можно через <code>{'{{company.name}}'}</code>.</p>
    <div className="editor-grid"><label>Исполнитель<select name="assigneeId" defaultValue={template?.assigneeId||user.id}>{users.map(u=><option value={u.id} key={u.id}>{u.name}</option>)}</select></label>
     <label>Цена задачи · ₽<input name="price" type="number" min="0" max="999999999999.99" step="0.01" required defaultValue={template?.price??0}/></label>
     <label>Срок после запуска · часов<input name="deadlineHours" type="number" min="1" max="8760" defaultValue={editing?.definition.deadlineHours??undefined} placeholder="Без срока"/></label></div>
    <details><summary>Пробный запуск</summary><div className="editor-grid"><label>Название<input name="sampleName" defaultValue="Тестовая компания" maxLength={250}/></label>
     <label>Новый статус<select name="sampleStatus" defaultValue="active">{Object.entries(companyStates).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
     <label>Прежний статус<select name="samplePrevious"><option value="">Отсутствует</option>{Object.entries(companyStates).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label></div>
     {trigger==='task_accepted'&&<div className="editor-grid"><label>Название принятой задачи<input name="sampleTask" defaultValue="Проверить заказ" maxLength={500}/></label><label>Исполнитель принятой задачи<select name="sampleOwner" defaultValue={user.id}>{users.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label></div>}
     <button className="button secondary" value="preview" disabled={busy}>Проверить условие</button>
     {preview&&<p role="status">Ветка «{preview.branch==='yes'?'Да':'Нет'}». {preview.title?'Будет создана задача «'+preview.title+'».':'Действие отсутствует.'}</p>}
    </details>
    <div className="heading-actions"><button className="button primary" disabled={busy}>Сохранить черновик</button>{editing&&<button type="button" className="button secondary" onClick={()=>{setEditing(null);setTrigger("company_status");setCompanyId(draft?.companyId??null);setField("company.status");setOperator("=");setBranch("yes");setPreview(null);}}>Новый процесс</button>}</div>{notice&&<p role="status">{notice}</p>}
   </form>
   <h3>Сохранённые процессы</h3>
   {!processes&&<p>Загружаем процессы…</p>}
   {processes?.items.length===0&&<p>Процессов пока нет.</p>}
   {processes?.items.map(p=><div className="automation-run" key={p.id}><div><strong>{p.name}</strong><p>{p.enabled?'Включён':'Отключён'} · {triggerLabels[p.definition.trigger??'company_status']} · {p.definition.title}</p></div><div className="heading-actions">{!p.enabled&&<button type="button" className="button secondary" disabled={busy} onClick={()=>{setEditing(p);setTrigger(p.definition.trigger??"company_status");setCompanyId(p.definition.companyId??null);setField(p.definition.field);setOperator(p.definition.operator);setBranch(p.definition.branch);setPreview(null);setNotice("");}}>Изменить</button>}<button className="button secondary" disabled={busy} onClick={()=>void toggle('/work-design/processes/'+p.id,!p.enabled)}>{p.enabled?'Остановить':'Включить'}</button></div></div>)}
   {!!processes?.runs.length&&<details className="automation-log"><summary>Журнал последних запусков</summary>{processes.runs.map((r,i)=><div className="automation-run" key={r.process_id+i}><span>{moscowTimestamp(r.created_at)} · {processes.items.find(p=>p.id===r.process_id)?.name} · {r.branch==='yes'?'Да':'Нет'}</span>{r.error?<span className="red-text">{r.error}</span>:r.task_id?<button className="text-button" onClick={()=>open(r.task_id!)}>#{r.task_id}</button>:<span>Без задачи</span>}</div>)}</details>}
  </section>}
  <section className="panel automation-settings"><h2>Периодические задачи</h2><p className="muted">Новое расписание создаётся из формы задачи. После паузы появится не более одной пропущенной задачи за запуск.</p>
   {!schedules&&<p>Загружаем расписания…</p>}
   {schedules?.length===0&&<p>Расписаний пока нет.</p>}
   {schedules?.map(s=><div className="automation-run" key={s.id}><div><strong>{s.title}</strong><p>{s.enabled?'Следующий запуск · '+moscowTimestamp(s.next_at):'На паузе'} · Интервал {s.every} {s.frequency==='daily'?'дн.':s.frequency==='weekly'?'нед.':'мес.'}</p>{s.last_error&&<p className="red-text">{s.last_error}</p>}{s.last_task_id&&<button className="text-button" onClick={()=>open(s.last_task_id!)}>Последняя задача #{s.last_task_id}</button>}</div>
    <button className="button secondary" disabled={busy} onClick={()=>void toggle('/work-design/schedules/'+s.id,!s.enabled)}>{s.enabled?'На паузу':'Возобновить'}</button></div>)}
  </section>
 </>;
}
