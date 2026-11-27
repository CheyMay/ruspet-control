import {useEffect,useState,type FormEvent} from 'react';
import type {User} from '../shared/types.js';
import {mayManageStaffAccounts} from '../shared/workspace-access.js';
import {api} from './api.js';
import {SearchFilter} from './SearchFilter.js';
import './account-settings.css';

type Account={username:string;enabled:boolean;password_login:boolean};
type OwnAccounts={accounts:Account[];recentTelegram:boolean};
type StaffAccount={id:string;name:string;suggestedLogin:string;accounts:Account[]};
const loginPattern='[a-zA-Z0-9._\\-]{3,32}';

function PersonalCredentials({settings}:{settings:OwnAccounts}){
 const [accounts,setAccounts]=useState(settings.accounts),[selected,setSelected]=useState(settings.accounts[0]?.username??'');
 const [login,setLogin]=useState(selected),[oldPassword,setOldPassword]=useState(''),[password,setPassword]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
 const current=accounts.find(account=>account.username===selected);
 const editable=current&&(current.password_login||settings.recentTelegram);

 function choose(value:string){
  setSelected(value);setLogin(value);setOldPassword('');setPassword('');setError('');setStatus('');
 }
 async function submit(event:FormEvent){
  event.preventDefault();
  if(!editable||busy)return;
  setBusy(true);setError('');setStatus('');
  try{
   const result=await api<{username:string}>('/auth/accounts/'+encodeURIComponent(selected),'PUT',{
    username:login,password:password||undefined,currentPassword:current.password_login?oldPassword:undefined
   });
   setAccounts(old=>old.map(account=>account.username===selected?{...account,username:result.username,password_login:true}:account));
   choose(result.username);setStatus(password?'Данные входа сохранены. Другие сеансы завершены.':'Логин сохранён.');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }

 if(!current)return <p>Личный вход можно настроить после подключения через Telegram или получения логина.</p>;
 return <form className="account-fields" onSubmit={event=>void submit(event)}>
  {accounts.length>1&&<label>Мой вход<select value={selected} disabled={busy} onChange={event=>choose(event.target.value)}>
   {accounts.map(account=><option key={account.username} value={account.username}>{account.username}</option>)}
  </select></label>}
  {!editable&&<p className="muted">Чтобы задать первый пароль, войдите через Telegram заново и откройте эту вкладку в течение 10 минут.</p>}
  <label>Логин<input autoComplete="username" pattern={loginPattern} maxLength={32} required value={login}
   disabled={!editable||busy} onChange={event=>setLogin(event.target.value)}/></label>
  {current.password_login&&<label>Текущий пароль<input type="password" autoComplete="current-password" required value={oldPassword}
   disabled={busy} onChange={event=>setOldPassword(event.target.value)}/></label>}
  <label>Новый пароль<input type="password" autoComplete="new-password" minLength={10} maxLength={200} value={password}
   required={!current.password_login} disabled={!editable||busy} onChange={event=>setPassword(event.target.value)}/></label>
  <small className="muted">{current.password_login?'Оставьте поле нового пароля пустым, если меняете только логин. ':'Для входа по паролю понадобится логин. '}Пароль от 10 символов.</small>
  <button type="submit" className="button primary" disabled={!editable||busy||login.trim().toLowerCase()===selected&&!password}>Сохранить данные входа</button>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {status&&<p role="status">{status}</p>}
 </form>;
}

type StaffAction='rename'|'reset'|'enable'|'disable'|'create';

function StaffCredentials(){
 const [people,setPeople]=useState<StaffAccount[]>([]),[userId,setUserId]=useState(''),[selected,setSelected]=useState('');
 const [login,setLogin]=useState(''),[error,setError]=useState(''),[status,setStatus]=useState('');
 const [busy,setBusy]=useState(false),[password,setPassword]=useState<string>();
 const person=people.find(item=>item.id===userId),account=person?.accounts.find(item=>item.username===selected);
 useEffect(()=>{
  let live=true;
  void api<StaffAccount[]>('/system/accounts').then(result=>{if(live)setPeople(result);}).catch(e=>{if(live)setError(e.message);});
  return()=>{live=false;};
 },[]);
 function choose(id:string,username?:string){
  const target=people.find(item=>item.id===id);
  const option=username??target?.accounts[0]?.username??'';
  setUserId(id);setSelected(option);setLogin(option||target?.suggestedLogin||'');
  setError('');setStatus('');setPassword(undefined);
 }
 async function change(action:StaffAction){
  if(!person||busy)return;
  if((action==='reset'||action==='disable')&&!window.confirm(action==='reset'
   ?'Сбросить пароль и завершить сеансы сотрудника?':'Отключить вход и завершить сеансы сотрудника?'))return;
  setBusy(true);setError('');setStatus('');setPassword(undefined);
  const path='/system/access/'+encodeURIComponent(person.id)+'/account';
  try{
   const result=await api<{username:string;password?:string}>(action==='create'?path:path+'/'+encodeURIComponent(selected),
    action==='create'?'POST':'PUT',action==='create'?{username:login}:{action,confirmed:true,...(action==='rename'?{username:login}:{})});
   setSelected(result.username);setLogin(result.username);
   setPassword(result.password);setStatus('Данные входа сотрудника сохранены.');
   setPeople(await api<StaffAccount[]>('/system/accounts'));
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }

 return <section className="panel automation-settings account-settings">
  <h2>Входы сотрудников</h2>
  <SearchFilter label="Сотрудник" value={userId} disabled={busy} onChange={choose}
   options={people.map(item=>({value:item.id,label:item.name,hint:item.accounts.map(entry=>entry.username).join(', ')}))}
   empty={{value:'',label:'Выберите сотрудника'}}/>
  {person&&<form className="account-fields" onSubmit={event=>{event.preventDefault();void change(account?'rename':'create');}}>
   {person.accounts.length>1&&<label>Вход сотрудника<select value={selected} disabled={busy} onChange={event=>choose(person.id,event.target.value)}>
    {person.accounts.map(entry=><option key={entry.username} value={entry.username}>{entry.username}</option>)}
   </select></label>}
   <label>Логин сотрудника<input autoComplete="off" pattern={loginPattern} maxLength={32} required value={login}
    disabled={busy} onChange={event=>setLogin(event.target.value)}/></label>
   <div className="account-actions">
    <button type="submit" className="button primary" disabled={busy||!!account&&login.trim().toLowerCase()===selected}>{account?'Изменить логин':'Создать вход'}</button>
    {account?.enabled&&<button type="button" className="button secondary" disabled={busy}
     onClick={()=>void change(account.password_login?'reset':'create')}>{account.password_login?'Сбросить пароль':'Выдать пароль'}</button>}
    {account&&<button type="button" className="button secondary" disabled={busy}
     onClick={()=>void change(account.enabled?'disable':'enable')}>{account.enabled?'Отключить вход':'Включить вход'}</button>}
   </div>
   {password&&<label>Временный пароль<input readOnly value={password} onFocus={event=>event.target.select()}/></label>}
  </form>}
  {error&&<p className="alert error" role="alert">{error}</p>}
  {status&&<p role="status">{status}</p>}
 </section>;
}

export function AccountSettings({user}:{user:User}){
 const [settings,setSettings]=useState<OwnAccounts|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  let live=true;
  void api<OwnAccounts>('/auth/accounts').then(result=>{if(live)setSettings(result);}).catch(e=>{if(live)setError(e.message);});
  return()=>{live=false;};
 },[user.id]);
 return <>
  <section className="panel automation-settings account-settings">
   <h2>Мой вход</h2>
   {error?<p className="alert error" role="alert">{error}</p>:settings?<PersonalCredentials settings={settings}/>:<p role="status">Загружаем настройки входа…</p>}
  </section>
  {mayManageStaffAccounts(user)&&<StaffCredentials/>}
 </>;
}
