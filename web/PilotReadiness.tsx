import {TaskId} from './TaskId.js';
import {useEffect,useState} from 'react';
import {api} from './api.js';
import {integrationLabels} from '../shared/integration-status.js';
type Readiness={ready:boolean;linkedExchange:boolean;enabled:boolean;writeEnabled:boolean;checks:{level:'block'|'warning'|'ok';message:string}[]};
type Entry={event_id:string;task_id:string;state:string;phase:string;error:string|null};
export function PilotReadiness({root=false}:{root?:boolean}){
 const [value,setValue]=useState<Readiness|null>(null),[queue,setQueue]=useState<Entry[]>([]),[error,setError]=useState(''),[version,setVersion]=useState(0);
 const [saving,setSaving]=useState(false),[operationError,setOperationError]=useState('');
 async function changeExchange(enabled:boolean){
  if(saving||!window.confirm(enabled?'Возобновить обмен по активированным задачам?':'Приостановить обмен? Очередь сохранится.'))return;
  setSaving(true);setOperationError('');
  try{await api('/owner/bitrix/exchange','PUT',{enabled,confirmed:true});setVersion(n=>n+1);}
  catch(e){setOperationError((e as Error).message);}finally{setSaving(false);}
 }
 useEffect(()=>{
  let active=true,pending=false;
  async function load(){if(pending)return;pending=true;try{const [status,entries]=await Promise.all([api<Readiness>('/system/pilot'),api<Entry[]>('/system/pilot/queue')]);if(active){setValue(status);setQueue(entries);setError('');}}catch(e){if(active)setError((e as Error).message);}finally{pending=false}}
  void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load()},30000);return()=>{active=false;clearInterval(timer)};
 },[version]);
 return <section className="panel automation-settings"><div className="automation-heading"><div><h2>Обмен с Битрикс24</h2><p className="muted">Состояние подключений и очереди изменений по связанным задачам.</p></div><button className="button secondary" onClick={()=>setVersion(n=>n+1)}>Обновить проверку</button></div>
 {error&&<p className="alert error">{error}</p>}{value?<><p className={value.ready?'source-banner':'alert error'}>{value.enabled?(value.ready?'Запись включена':'Запись включена, есть пункты для проверки'):(value.ready?'Запись на паузе':'Запись на паузе, есть препятствия для запуска')}</p><details open={!value.ready}><summary>Требуют внимания · {value.checks.filter(c=>c.level==='block').length}</summary><ul>{value.checks.map((c,i)=><li key={i}><strong>{c.level==='ok'?'Готово':'Проверьте'}</strong> · {c.message}</li>)}</ul></details></>:<p>Проверяем подключения…</p>}
 {root&&value&&<div className="pilot-controls">
  <button className="button secondary" disabled={saving||(!value.enabled&&!value.linkedExchange&&(!value.ready||!value.writeEnabled))} onClick={()=>void changeExchange(!value.enabled)}>{value.enabled?'Приостановить обмен':'Возобновить обмен'}</button>
  {!value.linkedExchange&&!value.writeEnabled&&!value.enabled&&<small>Для запуска сначала настройте обработчик на сервере.</small>}
  {operationError&&<p className="alert error" role="alert">{operationError}</p>}
 </div>}
 {queue.length>0&&<><h3>Очередь обмена · первые {queue.length}</h3><div className="table-scroll"><table><thead><tr><th>Задача</th><th>Состояние</th><th>Операция для сверки</th></tr></thead><tbody>{queue.map(q=><tr key={q.event_id}><td><TaskId number={q.task_id}/> <a className="text-button" href={'/?view=tasks&task='+encodeURIComponent(q.task_id)}>Открыть</a></td><td>{integrationLabels[q.state]||q.state}{q.error&&<p>{q.error}</p>}</td><td><code>{q.event_id}</code><br/><small>{q.phase}</small></td></tr>)}</tbody></table></div></>}
 </section>;
}
