import {useEffect,useState} from 'react';
import {api} from './api.js';
import type {User} from '../shared/types.js';

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
 const options=(roles:User['role'][])=>users.filter(person=>!person.root_access&&roles.includes(person.role))
  .map(person=><option key={person.id} value={person.id}>{person.name}</option>);
 return <form className="panel automation-settings" onSubmit={event=>{event.preventDefault();void save();}}>
  <h2>Маршрут согласования задач</h2>
  <p className="muted">Руководитель филиала получает первый этап по всем задачам. Второй этап открывается по отметке контроля или букве В в коде.</p>
  <div className="editor-grid">
   <label>Первый этап<select required value={branch} onChange={e=>setBranch(e.target.value)}><option value="">Руководитель филиала</option>{options(['branch_manager'])}</select></label>
   <label>Второй этап<select required value={sales} onChange={e=>setSales(e.target.value)}><option value="">Руководитель продаж или директор</option>{options(['sales_head','director'])}</select></label>
  </div>
  <div className="task-card-buttons"><button className="button primary" disabled={!loaded||busy||!branch||!sales||branch===sales}>Сохранить маршрут</button></div>
  {message&&<p role="status">{message}</p>}{error&&<p className="alert error" role="alert">{error}</p>}
 </form>;
}
