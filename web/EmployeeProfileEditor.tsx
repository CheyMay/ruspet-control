import {useState,type FormEvent} from 'react';
import type {User} from '../shared/types.js';
import {protectedStaffRole} from '../shared/workspace-access.js';
import {unassignedBranch} from '../shared/branches.js';
import {api} from './api.js';
import {roleDetails,roleLabels} from './employee-roles.js';

export type StaffDraft={id:string;name:string;organisation:string;department:string};

export function EmployeeProfileEditor({person,staff,actor,close,saved}:{
 person?:User;staff?:StaffDraft;actor:User;close:()=>void;saved:(user:User)=>void|Promise<void>;
}){
 const [name,setName]=useState(person?.name??staff?.name??'');
 const [position,setPosition]=useState(person?.position??(staff?.department==='! рук филиала'?'Руководитель подразделения':staff?.department??''));
 const [role,setRole]=useState<User['role']>(person?.role??'employee');
 const [branch,setBranch]=useState(person?.branch_id??unassignedBranch);
 const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const own=actor.id===person?.id;
 const roles=Object.entries(roleLabels).filter(([id])=>actor.root_access||id===person?.role||!protectedStaffRole(id as User['role']));
 const title=person?'Должность и доступ':'Новый сотрудник';

 async function submit(event:FormEvent){
  event.preventDefault();
  setBusy(true);setError('');
  const profile={name,position,role,branchId:branch,reason};
  try{
   const result=person
    ?await api<{user:User}>('/system/access/'+encodeURIComponent(person.id),'PATCH',{...profile,expectedVersion:person.version??1})
    :await api<{user:User}>('/system/access','POST',{...profile,staffId:staff?.id});
   await saved(result.user);close();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }

 return <div className="modal-backdrop"><form className="modal employee-editor" role="dialog" aria-modal="true" aria-label={title} onSubmit={e=>void submit(e)}>
  <div className="panel-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Закрыть" disabled={busy} onClick={close}>✕</button></div>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {staff&&<p>Запись из справочника · {staff.organisation} / {staff.department}</p>}
  <label>Имя<input autoFocus value={name} onChange={e=>setName(e.target.value)} required maxLength={200}/></label>
  <label>Должность<input value={position} onChange={e=>setPosition(e.target.value)} maxLength={200} placeholder="Например, руководитель отдела"/></label>
  <label>Подразделение или филиал<input required value={branch} maxLength={100} onChange={e=>setBranch(e.target.value)}/></label>
  <label>Права в системе<select disabled={own} value={role} onChange={e=>setRole(e.target.value as User['role'])}>{roles.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
  <p className="muted">{roleDetails[role]} {own&&'Вашу роль меняет владелец.'}</p>
  {person&&(role!==person.role||branch.trim()!==person.branch_id)&&<p className="muted">При смене роли или подразделения проверьте замещения и открытые согласования сотрудника.</p>}
  {!person&&<p className="muted">После создания профиля можно выдать вход в панель и приглашение в Telegram.</p>}
  <label>Комментарий<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000}/></label>
  <div className="drawer-actions"><button className="button primary" disabled={busy}>{person?'Сохранить данные':'Создать профиль'}</button><button type="button" className="button secondary" disabled={busy} onClick={close}>Отмена</button></div>
 </form></div>;
}
