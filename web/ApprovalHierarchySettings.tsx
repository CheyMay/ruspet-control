import {useEffect,useState} from 'react';
import {api} from './api.js';
import type {User} from '../shared/types.js';
import {canApproveBranch} from '../shared/branches.js';
import {EmployeeFilter} from './SearchFilter.js';

type Hierarchy={branch_manager_id:string;sales_head_id:string;sales_head_approves_all:boolean;direct_assignee_ids:string[]|null;
 creator_approver_id:string|null;extra_deadline_assignee_ids:string[];only_self_direct:boolean;creator_first:boolean};
export function ApprovalHierarchySettings({users}:{users:User[]}){
 const [branch,setBranch]=useState(''),[sales,setSales]=useState(''),[loaded,setLoaded]=useState(false);
 const [approveAll,setApproveAll]=useState(false),[creatorFirst,setCreatorFirst]=useState(false);
 const [direct,setDirect]=useState(false),[assignees,setAssignees]=useState<string[]>([]),[query,setQuery]=useState('');
 const [creator,setCreator]=useState(''),[onlySelfDirect,setOnlySelfDirect]=useState(false);
 const [deadlineAssignees,setDeadlineAssignees]=useState<string[]>([]);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;
  void api<Hierarchy|null>('/approval-hierarchy').then(value=>{
   if(active){setBranch(value?.branch_manager_id??'');setSales(value?.sales_head_id??'');setApproveAll(!!value?.sales_head_approves_all);setCreatorFirst(!!value?.creator_first);
    setDirect(!!value?.direct_assignee_ids);setAssignees(value?.direct_assignee_ids??[]);
    setCreator(value?.creator_approver_id??'');setOnlySelfDirect(!!value?.only_self_direct);
    setDeadlineAssignees(value?.extra_deadline_assignee_ids??[]);setLoaded(true);}
  }).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[]);
 async function save(){
  setBusy(true);setMessage('');setError('');
  try{await api('/approval-hierarchy','PUT',{branchId:branch,salesId:sales,approveAll,directAssigneeIds:direct?assignees:null,
   creatorApproverId:creator||null,extraDeadlineAssigneeIds:deadlineAssignees,onlySelfDirect});setMessage('Маршрут сохранён.');}
  catch(e){setError((e as Error).message);}
  finally{setBusy(false);}
 }
 const options=(choose:(person:User)=>boolean)=>users.filter(person=>!person.root_access&&choose(person))
  .map(person=><option key={person.id} value={person.id}>{person.name}</option>);
 return <form className="panel automation-settings" onSubmit={event=>{event.preventDefault();void save();}}>
  <h2>Маршрут согласования переносов срока</h2>
  {creatorFirst?<p>Первый этап — постановщик. Затем руководитель продаж рассматривает переносы менеджеров по продажам, руководителей филиалов и отмеченных задач. Результат принимает постановщик.</p>:<><label className="check"><input type="checkbox" checked={direct} onChange={e=>setDirect(e.target.checked)}/> Один согласующий для выбранных сотрудников</label>
  <p className="muted">{direct?'Контроль сроков настраивается в разделе «Сотрудники и права».':'Первый этап обычного маршрута определяется филиалом задачи.'} Результат работы принимает постановщик задачи.</p></>}
  <div className="editor-grid">
   {!creatorFirst&&(!direct||!branch)&&<label>Приоритет в своём подразделении<select required value={branch} onChange={e=>setBranch(e.target.value)}><option value="">Выберите руководителя подразделения</option>{options(canApproveBranch)}</select></label>}
   <label>{creatorFirst?'Руководитель продаж':direct?'Согласующий':'Второй этап'}<select required value={sales} onChange={e=>setSales(e.target.value)}><option value="">Руководитель продаж или директор</option>{options(person=>person.role==='sales_head'||person.role==='director')}</select></label>
  </div>
  {!creatorFirst&&<>{direct?<details className="source-banner"><summary>Исполнители в отдельном маршруте · {assignees.length}</summary>
   <label>Поиск сотрудника<input type="search" value={query} onChange={e=>setQuery(e.target.value)} /></label>
   <div style={{maxHeight:240,overflow:'auto'}}>
    {users.filter(person=>person.role==='employee'&&(assignees.includes(person.id)||person.name.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU'))))
     .map(person=><label key={person.id} className="check"><input type="checkbox" checked={assignees.includes(person.id)} onChange={e=>setAssignees(ids=>e.target.checked?[...ids,person.id]:ids.filter(id=>id!==person.id))}/> {person.name}</label>)}
   </div>
  </details>:<label className="check"><input type="checkbox" checked={approveAll} onChange={e=>setApproveAll(e.target.checked)}/> Согласовывать все переносы у руководителя продаж</label>}
  <label className="check"><input type="checkbox" checked={onlySelfDirect} onChange={e=>setOnlySelfDirect(e.target.checked)}/> Сразу применять только переносы и закрытие задач, поставленных себе</label>
  <details className="source-banner">
   <summary>Маршрут по постановщику и цене</summary>
   <EmployeeFilter caption="Постановщик для особого маршрута" label="Постановщик для особого маршрута" value={creator}
    onChange={setCreator} people={users.filter(person=>!person.root_access&&person.id!==sales)} empty={{value:'',label:'Без особого маршрута'}}/>
   <p className="muted">До 5 000 ₽ решение принимает постановщик. От 5 000 ₽ и без цены добавляется руководитель продаж.</p>
   <EmployeeFilter caption="Исполнители, чьи переносы всегда рассматривает руководитель продаж" label="Добавить исполнителя в маршрут переносов"
    value="" onChange={id=>{if(id)setDeadlineAssignees(ids=>[...ids,id]);}}
    people={users.filter(person=>!person.root_access&&person.id!==sales&&!deadlineAssignees.includes(person.id))}
    empty={{value:'',label:'Добавить исполнителя'}}/>
   {deadlineAssignees.map(id=><label className="check" key={id}><input type="checkbox" checked
    onChange={()=>setDeadlineAssignees(ids=>ids.filter(value=>value!==id))}/> {users.find(person=>person.id===id)?.name??id}</label>)}
  </details></>}
  <div className="task-card-buttons"><button className="button primary" disabled={!loaded||busy||!branch||!sales||branch===sales||direct&&!assignees.length}>Сохранить маршрут</button></div>
  {message&&<p role="status">{message}</p>}{error&&<p className="alert error" role="alert">{error}</p>}
 </form>;
}
