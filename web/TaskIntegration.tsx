import {useEffect,useState} from 'react';
import {api} from './api.js';
import {integrationLabels} from '../shared/integration-status.js';
type Integration={linked:boolean;state:string;error:string|null;paused?:boolean;fetchedAt?:string;fields:{code:string;title:string;value:unknown}[]};
export function TaskIntegration({id,version}:{id:string;version:number}){
 const [value,setValue]=useState<Integration|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  let active=true,pending=false;setValue(null);setError('');
  async function refresh(){if(pending)return;pending=true;try{const result=await api<Integration>('/tasks/'+encodeURIComponent(id)+'/integration');if(active){setValue(result);setError('');}}catch(e){if(active)setError((e as Error).message);}finally{pending=false;}}
  void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh()},15000);return()=>{active=false;clearInterval(timer)};
 },[id,version]);
 if(error)return <p className="source-banner" role="alert">Не удалось проверить обмен: {error}</p>;
 if(!value)return <p className="muted">Проверяем состояние обмена…</p>;
 return <section className="task-integration" aria-label="Обмен с Битрикс24"><strong role="status">{integrationLabels[value.state]||value.state}</strong>{value.paused&&value.state!=='paused'&&<p>Отправка приостановлена.</p>}{value.error&&<p className="alert error">{value.error}</p>}
 {value.fields.length>0&&<details><summary>Все полученные поля Битрикс24 · {value.fields.length}</summary><p className="muted">Получены: {value.fetchedAt?new Date(value.fetchedAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК':'—'}. Файлы представлены идентификаторами и метаданными.</p><dl>{value.fields.map(f=><div key={f.code}><dt>{f.title} <small>{f.code}</small></dt><dd><pre>{typeof f.value==='string'?f.value:JSON.stringify(f.value,null,2)??'—'}</pre></dd></div>)}</dl></details>}</section>;
}
