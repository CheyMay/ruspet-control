import {useState,type FormEvent} from 'react';
import type {User} from '../shared/types.js';
import {api} from './api.js';
import {roleDetails,roleLabels} from './employee-roles.js';
export function EmployeeProfileEditor({person,own,close,saved}:{person:User;own:boolean;close:()=>void;saved:()=>void|Promise<void>}){
 const [name,setName]=useState(person.name),[position,setPosition]=useState(person.position),[role,setRole]=useState(person.role),[branch,setBranch]=useState(person.branch_id);
 const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(event:FormEvent){
  event.preventDefault();setBusy(true);setError('');
  try{await api('/system/access/'+encodeURIComponent(person.id),'PATCH',{name,position,role,branchId:branch,expectedVersion:person.version??1,reason});await saved();close();}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className="modal-backdrop"><form className="modal employee-editor" role="dialog" aria-modal="true" aria-label="Должность и доступ" onSubmit={e=>void submit(e)}>
  <div className="panel-heading"><h2>Должность и доступ</h2><button type="button" className="icon-button" aria-label="Закрыть" disabled={busy} onClick={close}>✕</button></div>
  {error&&<p className="alert error" role="alert">{error}</p>}
  <label>Имя<input autoFocus value={name} onChange={e=>setName(e.target.value)} required maxLength={200}/></label>
  <label>Должность<input value={position} onChange={e=>setPosition(e.target.value)} maxLength={200} placeholder="Например, руководитель отдела"/></label>
  <label>Подразделение или филиал<input required value={branch} maxLength={100} onChange={e=>setBranch(e.target.value)}/></label>
  <label>Права в системе<select disabled={own} value={role} onChange={e=>setRole(e.target.value as User['role'])}>{Object.entries(roleLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
  <p className="muted">{roleDetails[role]} {own&&'Вашу роль может изменить другой администратор.'}</p>
  {(role!==person.role||branch.trim()!==person.branch_id)&&<p className="muted">Изменение прав или подразделения завершит действующие замещения. Активные согласования с участием сотрудника потребуют повторного запроса.</p>}
  <label>Комментарий к изменению<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000}/></label>
  <div className="drawer-actions"><button className="button primary" disabled={busy}>Сохранить данные</button><button type="button" className="button secondary" disabled={busy} onClick={close}>Отмена</button></div>
 </form></div>;
}
