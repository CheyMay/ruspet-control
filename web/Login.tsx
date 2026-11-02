import {useState,type FormEvent} from 'react';
import {CapMark} from './CapMark.js';
import {api} from './api.js';
import type {Bootstrap} from '../shared/types.js';
export function Login({onLogin}:{onLogin:(data:Bootstrap)=>void}){
 const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e:FormEvent){e.preventDefault();setBusy(true);setError('');try{await api('/auth/login','POST',{username,password});onLogin(await api<Bootstrap>('/bootstrap'));}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <main className="login-page"><form className="login-card" onSubmit={submit}><CapMark/><div><span className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</span><h1>Вход в РУСПЭТ</h1><p>Контроль задач и согласований</p></div><label>Логин<input autoComplete="username" required maxLength={32} value={username} onChange={e=>setUsername(e.target.value)}/></label><label>Пароль<input type="password" autoComplete="current-password" required value={password} onChange={e=>setPassword(e.target.value)}/></label>{error&&<p role="alert" className="login-error">{error}</p>}<button className="button primary" disabled={busy}>{busy?'Проверяем…':'Войти'}</button></form></main>;
}
