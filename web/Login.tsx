import {TelegramLogin} from './TelegramLogin.js';
import {useState,type FormEvent} from 'react';
import {ThemeToggle} from './ThemeToggle.js';
import {CapMark} from './CapMark.js';
import {api} from './api.js';
import type {Bootstrap} from '../shared/types.js';
export function Login({mobile,onLogin}:{mobile:boolean;onLogin:(data:Bootstrap)=>void}){
 const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');try{await api('/auth/login','POST',{username,password});onLogin(await api<Bootstrap>('/bootstrap'));}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 const telegram=<TelegramLogin key="telegram" mobile={mobile} onLogin={onLogin}/>;
 return <main className="login-page"><div className="login-card">
  <div className="login-brand"><CapMark/><ThemeToggle/></div>
  <div><span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span><h1>Вход в РУСПЭТ</h1><p>Контроль задач и согласований</p></div>
  {mobile&&telegram}
  <form key="password" className="password-login" onSubmit={submit}>
   <label>Логин<input autoComplete="username" required maxLength={32} value={username} onChange={e=>setUsername(e.target.value)}/></label>
   <label>Пароль<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>
   {error&&<p role="alert" className="login-error">{error}</p>}
   <button className={'button '+(mobile?'secondary':'primary')} disabled={busy}>{busy?'Проверяем…':mobile?'Войти по паролю':'Войти'}</button>
  </form>
  {!mobile&&telegram}
 </div></main>;
}
