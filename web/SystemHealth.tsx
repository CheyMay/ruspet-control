import {useEffect,useState} from 'react';
import type {User} from '../shared/types.js';
import {api} from './api.js';

export function moscowTimestamp(value:string|null|undefined){
 return value?new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'})+' МСК':'—';
}

function usePanelData<T>(path:string,interval=0){
 const [value,setValue]=useState<T|null>(null),[error,setError]=useState(''),[reload,setReload]=useState(0),[busy,setBusy]=useState(true);
 useEffect(()=>{
  let active=true,pending=false;
  async function load(){
   if(pending)return;
   pending=true;setBusy(true);
   try{const result=await api<T>(path);if(active){setValue(result);setError('');}}
   catch(e){if(active)setError((e as Error).message);}
   finally{pending=false;if(active)setBusy(false);}
  }
  void load();
  const timer=interval?setInterval(()=>void load(),interval):undefined;
  return()=>{active=false;clearInterval(timer);};
 },[path,interval,reload]);
 return {value,error,busy,refresh:()=>setReload(n=>n+1)};
}

type RecordStatus={at:string;ok:boolean|null;copies:number|null;tasks:number|null}|null;
type Status={
 telegram:{enabled:boolean;deliveryEnabled:boolean;bindings:number;lastPoll:string|null;error:string|null;pending:number;delivery:{state:string;count:number}[];timings:{kind:string;samples:number;errors:number;median:number|null;p95:number|null}[]};
 reports:{enabled:boolean;alive:boolean;heartbeat:string|null;runs:{state:string;finished_at:string|null}[]};
 bitrix:{staged:number;linked:number;conflicts:number;lastSuccess:string|null};
 okbBackups:Status['backups'];
 backups:{backup:RecordStatus;restore:RecordStatus;backupAttempt:RecordStatus;restoreAttempt:RecordStatus};
};
function isLate(record:RecordStatus,hours:number){
 return !!record&&Date.now()-Date.parse(record.at)>hours*3600000;
}
const timingNames={menu:'Главное меню',task:'Карточка задачи',pdf:'Отправка PDF'};
export function SystemHealth(){
 const {value,error,busy,refresh}=usePanelData<Status>('/system/status',30000);
 const tg=value?.telegram, reports=value?.reports, backups=value?.backups;
 const currentPoll=!!tg?.lastPoll&&Date.now()-Date.parse(tg.lastPoll)<90000;
 const delivery=(state:string)=>tg?.delivery.find(row=>row.state===state)?.count??0;
 return <section className="panel automation-settings">
  <div className="automation-heading"><div><h2>Состояние системы</h2><p className="muted">Telegram, автоматические отчёты и резервные копии.</p></div><button className="button secondary" disabled={busy} onClick={refresh}>Обновить</button></div>
  {error&&<p role="alert" className="alert error">{error}</p>}
  {!value&&busy&&<p role="status">Проверяем состояние…</p>}
  {tg&&reports&&backups&&<>
   <div className="automation-plan">
    <div><span>Связь с Telegram</span><strong>{!tg.enabled?'Выключена':currentPoll&&!tg.error?'Работает':'Нужна проверка'}</strong><small>Последний успешный опрос · {moscowTimestamp(tg.lastPoll)}</small><small>Подключено сотрудников · {tg.bindings}</small>{tg.error&&<small className="red-text">{tg.error}</small>}</div>
    <div><span>Фоновые уведомления</span><strong>{tg.deliveryEnabled&&tg.enabled?tg.pending+' в очереди':'Выключены'}</strong><small>Отправляются · {delivery('sending')} · Ошибки · {delivery('failed')}</small><small>Доставка не подтверждена · {delivery('uncertain')}</small></div>
    <div><span>Автоматические отчёты</span><strong>{!reports.enabled?'Выключены':reports.alive?'Работают':'Нет сигнала'}</strong><small>Последний готовый · {moscowTimestamp(reports.runs.find(r=>r.state==='done')?.finished_at)}</small><small>Последняя ошибка · {moscowTimestamp(reports.runs.find(r=>r.state==='failed')?.finished_at)}</small></div>
    <div><span>Копия базы данных</span><strong>{backups.backup?.copies!=null?backups.backup.copies+' на сервере':'Нет данных'}</strong><small>Последняя копия · {moscowTimestamp(backups.backup?.at)}</small><small>Ежедневно в 03:30 МСК</small>{isLate(backups.backup,26)&&<small className="red-text">Копия старше 26 часов</small>}{backups.backupAttempt?.ok===false&&<small className="red-text">Ошибка последней попытки · {moscowTimestamp(backups.backupAttempt.at)}</small>}</div>
    <div><span>Пробное восстановление</span><strong>{backups.restore?.tasks!=null?backups.restore.tasks+' задач в проверенной копии':'Нет данных'}</strong><small>Проверено · {moscowTimestamp(backups.restore?.at)}</small><small>По воскресеньям в 04:15 МСК</small>{isLate(backups.restore,170)&&<small className="red-text">Проверка просрочена</small>}{backups.restoreAttempt?.ok===false&&<small className="red-text">Ошибка последней попытки · {moscowTimestamp(backups.restoreAttempt.at)}</small>}</div>
    <div><span>Резервные копии ОКБ</span><strong>{value.okbBackups.backup?.copies!=null?value.okbBackups.backup.copies+' на сервере':'Нет данных'}</strong><small>Копия · {moscowTimestamp(value.okbBackups.backup?.at)}</small><small>Пробное восстановление · {moscowTimestamp(value.okbBackups.restore?.at)}</small>{(value.okbBackups.backupAttempt?.ok===false||value.okbBackups.restoreAttempt?.ok===false)&&<small className="red-text">Ошибка последней попытки</small>}</div>
    <div><span>Битрикс24 · пилот</span><strong>{value.bitrix.lastSuccess?'Связано задач: '+value.bitrix.linked:'Ожидает подключения'}</strong><small>Снимки в буфере · {value.bitrix.staged}</small><small>Требуют проверки · {value.bitrix.conflicts}</small><small>Последний ответ REST · {moscowTimestamp(value.bitrix.lastSuccess)}</small></div>
   </div>
   <p className="muted">При неподтверждённой доставке Telegram мог принять сообщение. Для таких отправок автоповтор отключён.</p>
   <h3>Скорость ответов Telegram · последние 7 дней</h3>
   <p className="muted">Время от начала обработки ботом до ответа Telegram. Включает подготовку карточки или PDF и отправку. P95 — время, в которое уложились 95% успешных замеров.</p>
   <div className="table-scroll"><table><thead><tr><th>Сценарий</th><th>Замеры</th><th>Ошибки отправки</th><th>Медиана</th><th>P95</th></tr></thead><tbody>{Object.entries(timingNames).map(([kind,label])=>{
    const row=tg.timings.find(r=>r.kind===kind);
    return <tr key={kind}><td>{label}</td><td>{row?.samples??0}</td><td>{row?.errors??0}</td><td>{row?.median==null?'—':row.median+' мс'}</td><td>{row?.p95!=null&&row.samples-row.errors>=20?row.p95+' мс':'Мало замеров'}</td></tr>;
   })}</tbody></table></div>
  </>}
 </section>;
}

type AccessPerson=User&{accounts:{username:string;enabled:boolean}[];visibleTasks:number;paired_at:string|null;invitation_expires:string|null};
export function AccessDirectory({roles}:{roles:Record<string,string>}){
 const {value,error,busy,refresh}=usePanelData<AccessPerson[]>('/system/access');
 const [query,setQuery]=useState(''),[invite,setInvite]=useState<{name:string;url:string}|null>(null),[creating,setCreating]=useState(false),[notice,setNotice]=useState(''),[inviteError,setInviteError]=useState('');
 async function createInvite(person:AccessPerson){
  setCreating(true);setInvite(null);setInviteError('');setNotice('');
  try{
   const result=await api<{url:string}>('/telegram/pairing','POST',{userId:person.id});
   setInvite({name:person.name,url:result.url});refresh();
  }catch(e){setInviteError((e as Error).message);}finally{setCreating(false);}
 }
 const people=value?.filter(p=>[p.name,p.branch_id,roles[p.role],...p.accounts.map(a=>a.username)].some(s=>s.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU'))));
 return <section className="panel automation-settings">
  <div className="automation-heading"><div><h2>Доступы сотрудников</h2><p className="muted">Роль, вход в панель, подключение к боту и число доступных рабочих задач.</p></div><button className="button secondary" disabled={busy} onClick={refresh}>Обновить</button></div>
  {(error||inviteError)&&<p className="alert error" role="alert">{inviteError||error}</p>}
  {invite&&<div className="source-banner"><strong>{invite.name} · ссылка на 15 минут</strong><input aria-label="Ссылка подключения" readOnly value={invite.url} onFocus={e=>e.currentTarget.select()}/><button className="button secondary" onClick={()=>void navigator.clipboard.writeText(invite.url).then(()=>setNotice('Ссылка скопирована')).catch(()=>setNotice('Выделите ссылку и скопируйте вручную.'))}>Копировать</button><span role="status">{notice}</span></div>}
  {!value&&busy&&<p role="status">Загружаем список сотрудников…</p>}
  {people&&<><div className="filters"><input aria-label="Поиск сотрудника" placeholder="Имя, филиал, роль или логин" value={query} onChange={e=>setQuery(e.target.value)}/></div>
   <div className="table-scroll"><table><thead><tr><th>Сотрудник</th><th>Роль</th><th>Доступно задач</th><th>Вход в панель</th><th>Telegram</th></tr></thead><tbody>{people.map(p=><tr key={p.id}>
    <td><strong>{p.name}</strong><br/><small>{p.branch_id}</small></td><td>{roles[p.role]}</td><td>{p.visibleTasks}</td>
    <td>{p.accounts.length?p.accounts.map(a=><div key={a.username}>{a.username}{a.enabled?'':' · отключён'}</div>):'Нет учётной записи'}</td>
    <td>{p.paired_at?<span>Подключён · {moscowTimestamp(p.paired_at)}</span>:<>{p.invitation_expires&&<small>Приглашение до {moscowTimestamp(p.invitation_expires)}<br/></small>}<button className="text-button" disabled={creating} onClick={()=>void createInvite(p)}>{p.invitation_expires?'Перевыпустить ссылку':'Создать приглашение'}</button></>}</td>
   </tr>)}</tbody></table></div>{!people.length&&<p>По этому запросу сотрудники не найдены.</p>}</>}
 </section>;
}
