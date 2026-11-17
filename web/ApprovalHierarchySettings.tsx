import {useEffect,useState} from 'react';
import {api} from './api.js';
import type {User} from '../shared/types.js';
import {canApproveBranch} from '../shared/branches.js';

type Hierarchy={branch_manager_id:string;sales_head_id:string};
export function ApprovalHierarchySettings({users}:{users:User[]}){
 const [branch,setBranch]=useState(''),[sales,setSales]=useState(''),[loaded,setLoaded]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;
  void api<Hierarchy|null>('/approval-hierarchy').then(value=>{
   if(active){setBranch(value?.branch_manager_id??'');setSales(value?.sales_head_id??'');setLoaded(true);}
  }).catch(e=>{if(active)setError(e.message);});
  return()=>{active=false;};
 },[]);
 async function save(){
  setBusy(true);setMessage('');setError('');
  try{await api('/approval-hierarchy','PUT',{branchId:branch,salesId:sales});setMessage('Маршрут сохранён. Применяется к новым запросам.');}
  catch(e){setError((e as Error).message);}
  finally{setBusy(false);}
 }
 const options=(choose:(person:User)=>boolean)=>users.filter(person=>!person.root_access&&choose(person))
  .map(person=><option key={person.id} value={person.id}>{person.name}</option>);
 return <form className="panel automation-settings" onSubmit={event=>{event.preventDefault();void save();}}>
  <h2>Маршрут согласования задач</h2>
  <p className="muted">Первый этап определяется филиалом задачи. Если у подразделения несколько руководителей, приоритет действует только внутри подразделения выбранного руководителя. Второй этап открывается по отметке контроля или букве В в коде.</p>
  <div className="editor-grid">
   <label>Приоритет в своём подразделении<select required value={branch} onChange={e=>setBranch(e.target.value)}><option value="">Выберите руководителя подразделения</option>{options(canApproveBranch)}</select></label>
   <label>Второй этап<select required value={sales} onChange={e=>setSales(e.target.value)}><option value="">Руководитель продаж или директор</option>{options(person=>person.role==='sales_head'||person.role==='director')}</select></label>
  </div>
  <div className="task-card-buttons"><button className="button primary" disabled={!loaded||busy||!branch||!sales||branch===sales}>Сохранить маршрут</button></div>
  {message&&<p role="status">{message}</p>}{error&&<p className="alert error" role="alert">{error}</p>}
 </form>;
}
