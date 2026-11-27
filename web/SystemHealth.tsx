import {useEffect,useState} from 'react';
import type {User} from '../shared/types.js';
import {api,viewAsLink} from './api.js';
import {EmployeeProfileEditor,type StaffDraft} from './EmployeeProfileEditor.js';
import {mayManageStaffAccounts,mayManageStaffIdentity} from '../shared/workspace-access.js';
import {EmployeeFilter,matchesFilter} from './SearchFilter.js';
import {useRememberedFilter} from './remembered-filter.js';

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
 bitrix:{linked:number;conflicts:number;lastSuccess:string|null;eventsEnabled:boolean;lastEvent:string|null;lastInbound:string|null;oldestTaskRefresh:string|null;inboundWaiting:number;inboundErrors:number;writesEnabled:boolean;outboundWaiting:number;outboundErrors:number;lastWrite:string|null};
 okbBackups:Status['backups'];
 offsiteBackup?:{backup:RecordStatus;attempt:RecordStatus};
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
 const bitrix=value?.bitrix;
 const bitrixStalled=!!bitrix?.oldestTaskRefresh&&Date.now()-Date.parse(bitrix.oldestTaskRefresh)>5*60000&&
  (!bitrix.lastSuccess||Date.now()-Date.parse(bitrix.lastSuccess)>5*60000);
 const delivery=(state:string)=>tg?.delivery.find(row=>row.state===state)?.count??0;
 return <section className="panel automation-settings">
  <div className="automation-heading"><div><h2>Состояние системы</h2><p className="muted">Telegram, обмен с Битрикс24, автоматические отчёты и резервные копии.</p></div><button className="button secondary" disabled={busy} onClick={refresh}>Обновить</button></div>
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
    <div><span>Копия на втором VPS</span><strong>{value.offsiteBackup?.backup?'Обе базы в зашифрованном архиве':'Копия пока не подтверждена'}</strong><small>Загрузка · {moscowTimestamp(value.offsiteBackup?.backup?.at)}</small>{isLate(value.offsiteBackup?.backup??null,26)&&<small className="red-text">Копия старше 26 часов</small>}{value.offsiteBackup?.attempt?.ok===false&&<small className="red-text">Последняя отправка завершилась ошибкой</small>}</div>
    <div><span>Битрикс24 → РУСПЭТ</span><strong>{!value.bitrix.eventsEnabled?'Приём событий выключен':bitrixStalled?'Нет ответа на запросы к Битрикс24':value.bitrix.inboundErrors?'Часть обновлений требует проверки':'Приём событий включён'}</strong>
     <small>Последнее принятое событие · {moscowTimestamp(value.bitrix.lastEvent)}</small><small>Последняя обработка · {moscowTimestamp(value.bitrix.lastInbound)}</small>
     {value.bitrix.oldestTaskRefresh&&<small>Старейшее обновление задачи в очереди · {moscowTimestamp(value.bitrix.oldestTaskRefresh)}</small>}
     <small>В очереди · {value.bitrix.inboundWaiting} · С ошибкой · {value.bitrix.inboundErrors}</small></div>
    <div><span>РУСПЭТ → Битрикс24</span><strong>{!value.bitrix.writesEnabled?'Отправка на паузе':bitrixStalled?'Ожидаем связи с Битрикс24':value.bitrix.outboundErrors?'Есть операции для проверки':'Отправка включена'}</strong>
     <small>Последняя запись · {moscowTimestamp(value.bitrix.lastWrite)}</small>
     {value.bitrix.outboundErrors>0&&<small className="red-text">Записи одной задачи идут по порядку. Ошибка может задержать следующие изменения по ней.</small>}<small>В очереди · {value.bitrix.outboundWaiting} · Требуют проверки · {value.bitrix.outboundErrors}</small>
     <small>Связано задач · {value.bitrix.linked} · Конфликты · {value.bitrix.conflicts}</small><small>Последний ответ REST · {moscowTimestamp(value.bitrix.lastSuccess)}</small></div>
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

type AccessPerson=User&{suggestedLogin:string;accounts:{username:string;enabled:boolean;password_login?:boolean}[];visibleTasks:number;paired_at:string|null;telegram_id:string|null;invitation_expires:string|null;
 work_groups:string[]|null;work_control_override:boolean|null;work_controlled:boolean;active_session:boolean};
const groupLabels:Record<string,string>={sales:'Продажи',analytics:'Аналитика',leadership:'Руководители'};
type Rollout={enabled:boolean;missing:StaffDraft[]};
const accessFilters={all:'Все',ready:'Вход настроен',setup:'Нужно подключить',disabled:'Вход отключён'} as const;
type StaffAccess=Exclude<keyof typeof accessFilters,'all'>;
function staffLogin(person:AccessPerson):{state:StaffAccess;label:string}{
 const enabled=person.accounts.filter(account=>account.enabled);
 if(enabled.some(account=>account.password_login!==false||person.paired_at))return {state:'ready',label:accessFilters.ready};
 if(enabled.length)return {state:'setup',label:'Нужна привязка Telegram'};
 if(person.accounts.length)return {state:'disabled',label:accessFilters.disabled};
 return {state:'setup',label:'Профиль без входа'};
}

export function AccessDirectory({roles,actor}:{roles:Record<string,string>;actor:User}){
 const currentUserId=actor.id;
 const {value,error,busy,refresh}=usePanelData<AccessPerson[]>('/system/access');
 const rollout=usePanelData<Rollout>('/system/staff-rollout');
 const [group,setGroup]=useRememberedFilter(currentUserId,'AccessDirectory.group','work');
 const [controlBusy,setControlBusy]=useState(false),[controlError,setControlError]=useState('');
 const [draft,setDraft]=useState<true|StaffDraft|null>(null);
 const [matching,setMatching]=useState<StaffDraft|null>(null),[matchId,setMatchId]=useState('');
 function focusProfile(user:User){
  setQuery(user.name);setGroup('all');setAccess('all');refresh();rollout.refresh();
 }
 async function linkProfile(){
  if(!matching||!matchId)return;
  setControlBusy(true);setControlError('');
  try{
   const {user}=await api<{user:User}>('/system/staff-directory/'+matching.id+'/profile','PUT',{userId:matchId});
   setMatching(null);focusProfile(user);setNotice('Запись справочника связана с существующим профилем.');
  }catch(e){setControlError((e as Error).message);}finally{setControlBusy(false);}
 }
 async function changeControl(person:AccessPerson,enabled:boolean|null){
  setControlBusy(true);setControlError('');
  try{
   await api('/system/access/'+encodeURIComponent(person.id)+'/work-control','PUT',{enabled});
   setNotice(person.name+' · '+(enabled===null?'по правилам группы':enabled?'контроль включён':'контроль выключен'));
   refresh();
  }catch(e){setControlError((e as Error).message);}finally{setControlBusy(false);}
 }
 async function changeRollout(enabled:boolean){
  if(!window.confirm(enabled?'Включить рабочий контроль для продаж, аналитиков и руководителей?':'Вернуться к прежнему списку контроля сроков?'))return;
  setControlBusy(true);setControlError('');
  try{await api('/system/staff-rollout','PUT',{enabled,confirmed:true});rollout.refresh();refresh();}
  catch(e){setControlError((e as Error).message);}finally{setControlBusy(false);}
 }
 const [access,setAccess]=useRememberedFilter(currentUserId,'AccessDirectory.access','all');
 const [sort,setSort]=useRememberedFilter(currentUserId,'AccessDirectory.sort','name');
 const [query,setQuery]=useState(''),[invite,setInvite]=useState<{name:string;url:string}|null>(null),[creating,setCreating]=useState(false),[notice,setNotice]=useState(''),[inviteError,setInviteError]=useState('');
 const [accountPerson,setAccountPerson]=useState<AccessPerson|null>(null),[accountLogin,setAccountLogin]=useState(''),[accountBusy,setAccountBusy]=useState(false),[accountError,setAccountError]=useState(''),[newAccount,setNewAccount]=useState<{name:string;username:string;password:string}|null>(null);
 const [profile,setProfile]=useState<AccessPerson|null>(null);
 async function changeAccount(person:AccessPerson,username:string,action:'enable'|'disable'|'reset'){
  const label={enable:'Включить вход',disable:'Отключить вход и завершить сессии',reset:'Выдать новый пароль и завершить сессии'}[action];
  if(accountBusy||!window.confirm(label+' для '+person.name+'?'))return;
  setAccountBusy(true);setAccountError('');setNewAccount(null);setNotice('');
  try{
   const result=await api<{name:string;username:string;password?:string}>('/system/access/'+encodeURIComponent(person.id)+'/account/'+encodeURIComponent(username),'PUT',{action,confirmed:true});
   if(result.password)setNewAccount({...result,password:result.password});else setNotice('Настройки входа сохранены.');
   refresh();
  }catch(e){setAccountError((e as Error).message);}finally{setAccountBusy(false);}
 }
 async function createAccount(e:React.FormEvent){
  e.preventDefault();if(!accountPerson||accountBusy)return;setAccountBusy(true);setAccountError('');
  try{const result=await api<{name:string;username:string;password:string}>('/system/access/'+encodeURIComponent(accountPerson.id)+'/account','POST',{username:accountLogin});setNewAccount(result);setAccountPerson(null);refresh();}
  catch(e){setAccountError((e as Error).message);}finally{setAccountBusy(false);}
 }
 async function createInvite(person:AccessPerson){
  setCreating(true);setInvite(null);setInviteError('');setNotice('');
  try{
   const result=await api<{url:string}>('/telegram/pairing','POST',{userId:person.id});
   setInvite({name:person.name,url:result.url});refresh();
  }catch(e){setInviteError((e as Error).message);}finally{setCreating(false);}
 }
 const [telegramPerson,setTelegramPerson]=useState<AccessPerson|null>(null),[telegramId,setTelegramId]=useState(''),[telegramConfirmed,setTelegramConfirmed]=useState(false),[telegramBusy,setTelegramBusy]=useState(false);
 async function saveTelegram(e:React.FormEvent){
  e.preventDefault();if(!telegramPerson||!telegramConfirmed||telegramBusy)return;setTelegramBusy(true);setInviteError('');
  try{await api('/system/access/'+encodeURIComponent(telegramPerson.id)+'/telegram','PUT',{telegramId:telegramPerson.paired_at?null:telegramId.trim(),confirmed:true});setTelegramPerson(null);setInvite(null);refresh();}
  catch(e){setInviteError((e as Error).message)}finally{setTelegramBusy(false)}
 }
 const entries=value?.map(person=>({person,login:staffLogin(person)}));
 const working=entries?.filter(({person})=>person.work_controlled)??[];
 const scoped=entries?.filter(({person})=>group==='all'||(group==='work'?person.work_controlled:group==='off'?!!person.work_groups&&!person.work_controlled:person.work_groups?.includes(group)));
 const counts={all:scoped?.length??0,ready:0,setup:0,disabled:0};
 for(const entry of scoped??[])counts[entry.login.state]++;
 const rank=sort==='ready'?['ready','setup','disabled']:['setup','disabled','ready'];
 const people=scoped?.filter(({person:p,login})=>(access==='all'||access===login.state)&&
  matchesFilter([p.name,p.position,p.branch_id,roles[p.role],login.label,...(p.work_groups??[]).map(g=>groupLabels[g]),...p.accounts.map(a=>a.username)].join(' '),query))
  .sort((a,b)=>(sort==='name'?0:rank.indexOf(a.login.state)-rank.indexOf(b.login.state))||a.person.name.localeCompare(b.person.name,'ru'));
 return <section className="panel automation-settings">
  <div className="automation-heading"><div><h2>Сотрудники и права</h2><p className="muted">Вход, Telegram, роль и контроль сроков по каждому сотруднику.</p></div>
   <div className="task-scope-actions"><button className="button primary" onClick={()=>setDraft(true)}>Добавить сотрудника</button>
    <button className="button secondary" disabled={busy||rollout.busy} onClick={()=>{refresh();rollout.refresh();}}>Обновить</button></div>
  </div>
  {rollout.value&&value&&<div className="source-banner staff-rollout-status">
   <div><strong>{rollout.value.enabled?'Подключение продаж, аналитиков и руководителей':'Действует прежний список контроля'}</strong>
    <p>Под контролем {working.length} · Вход настроен у {working.filter(p=>p.login.state==='ready').length} · Telegram подключён у {working.filter(p=>p.person.paired_at).length}</p>
    <p>Галочка включает автоматические проверки, напоминания о сроках и рабочие сводки по назначенным задачам. Сняв галочку, сотрудника можно найти через «Без контроля».</p>
   </div>
   {actor.root_access&&<button className="button secondary" disabled={controlBusy} onClick={()=>void changeRollout(!rollout.value!.enabled)}>
    {rollout.value.enabled?'Вернуться к прежнему списку':'Включить рабочую группу'}
   </button>}
  </div>}
  {rollout.value&&rollout.value.missing.length>0&&<details className="report-more"><summary>Нужно сопоставить с профилем · {rollout.value.missing.length}</summary>
   {rollout.value.missing.map(person=><div className="staff-unlinked-row" key={person.id}>
    <span>{person.name} · {person.department}</span><div className="task-scope-actions">
     <button className="button secondary" onClick={()=>{setMatching(person);setMatchId('');}}>Сопоставить</button>
     <button className="button secondary" onClick={()=>{setMatching(null);setDraft(person);}}>Создать профиль</button>
    </div>
   </div>)}
  </details>}
  {matching&&<div className="source-banner">
   <strong>Сопоставить · {matching.name}</strong>
   <EmployeeFilter label="Существующий профиль" value={matchId} disabled={controlBusy} onChange={setMatchId}
    people={(value??[]).filter(person=>mayManageStaffIdentity(actor,person))}/>
   <button type="button" className="button primary" disabled={!matchId||controlBusy} onClick={()=>void linkProfile()}>Сохранить связь</button>
   <button type="button" className="button secondary" disabled={controlBusy} onClick={()=>setMatching(null)}>Отмена</button>
  </div>}
  {(controlError||rollout.error)&&<p className="alert error" role="alert">{controlError||rollout.error}</p>}
  {(error||inviteError)&&<p className="alert error" role="alert">{inviteError||error}</p>}
  {accountError&&<p className="alert error" role="alert">{accountError}</p>}
  {profile&&<EmployeeProfileEditor person={profile} actor={actor} close={()=>setProfile(null)} saved={refresh}/>}
  {draft&&<EmployeeProfileEditor actor={actor} staff={draft===true?undefined:draft} close={()=>setDraft(null)} saved={user=>{
   focusProfile(user);setNotice('Профиль создан. Выдайте сотруднику вход или приглашение.');
  }}/>}
  {notice&&!newAccount&&!invite&&<p role="status">{notice}</p>}
  {telegramPerson&&<form className="source-banner" onSubmit={e=>void saveTelegram(e)}><strong>{telegramPerson.paired_at?'Отключение Telegram':'Привязка Telegram'} · {telegramPerson.name}</strong>
   {telegramPerson.paired_at?<p>Telegram ID: {telegramPerson.telegram_id}. Входы через Telegram будут завершены, новые подтверждения отменены. Для повторного подключения выдайте новое приглашение.</p>:<><p>Предпочтительно выдать сотруднику персональное приглашение. Для ручной привязки нужен проверенный числовой ID личного аккаунта, а не @имя. Сотрудник должен открыть бота и нажать «Старт».</p><label>Telegram ID<input aria-label="Telegram ID сотрудника" inputMode="numeric" autoComplete="off" pattern="[1-9][0-9]*" maxLength={16} required value={telegramId} onChange={e=>setTelegramId(e.target.value)}/></label></>}
   <label><input type="checkbox" checked={telegramConfirmed} onChange={e=>setTelegramConfirmed(e.target.checked)}/>Подтверждаю {telegramPerson.paired_at?'отключение привязки':'личность сотрудника и правильность ID'}</label><button className="button primary" disabled={!telegramConfirmed||telegramBusy}>{telegramBusy?'Сохраняем…':telegramPerson.paired_at?'Отключить Telegram':'Привязать Telegram'}</button><button className="button secondary" type="button" disabled={telegramBusy} onClick={()=>setTelegramPerson(null)}>Отмена</button></form>}
  {accountPerson&&<form className="source-banner" onSubmit={e=>void createAccount(e)}><strong>Новый вход · {accountPerson.name}</strong><p>Пароль будет сгенерирован автоматически. Роль: {roles[accountPerson.role]}.</p><label>Логин<input aria-label="Логин нового сотрудника" autoComplete="off" required minLength={3} maxLength={32} pattern="[a-z0-9._-]+" value={accountLogin} disabled={accountBusy} onChange={e=>setAccountLogin(e.target.value.toLowerCase())}/></label><button className="button primary" disabled={accountBusy}>{accountBusy?'Создаём…':'Создать персональный вход'}</button><button className="button secondary" type="button" disabled={accountBusy} onClick={()=>setAccountPerson(null)}>Отмена</button></form>}
  {newAccount&&<div className="source-banner"><strong>Вход создан · {newAccount.name}</strong><p>Сохраните данные и передайте лично сотруднику. Пароль показывается один раз и не хранится в списке доступов.</p><label>Логин<input aria-label="Созданный логин" readOnly value={newAccount.username}/></label><label>Пароль<input aria-label="Созданный пароль" readOnly autoComplete="off" value={newAccount.password}/></label><button className="button secondary" onClick={()=>void navigator.clipboard.writeText(`Сотрудник: ${newAccount.name}\nЛогин: ${newAccount.username}\nПароль: ${newAccount.password}`).then(()=>setNotice('Данные скопированы')).catch(()=>setNotice('Выделите данные и скопируйте вручную.'))}>Копировать доступы</button><button className="button secondary" onClick={()=>{setNewAccount(null);setNotice('');}}>Скрыть данные</button><span role="status">{notice}</span></div>}
  {invite&&<div className="source-banner"><strong>{invite.name} · ссылка на 15 минут</strong><input aria-label="Ссылка подключения" readOnly value={invite.url} onFocus={e=>e.currentTarget.select()}/><button className="button secondary" onClick={()=>void navigator.clipboard.writeText(invite.url).then(()=>setNotice('Ссылка скопирована')).catch(()=>setNotice('Выделите ссылку и скопируйте вручную.'))}>Копировать</button><span role="status">{notice}</span></div>}
  {!value&&busy&&<p role="status">Загружаем список сотрудников…</p>}
  {people&&<>
   <div className="tabs access-filter-tabs" role="group" aria-label="Состояние входа">
    {(Object.keys(accessFilters) as (keyof typeof accessFilters)[]).map(id=><button type="button" key={id} aria-pressed={access===id}
     className={access===id?'selected':''} onClick={()=>setAccess(id)}>{accessFilters[id]} <small>{counts[id]}</small></button>)}
   </div>
   <div className="filters"><select aria-label="Группа сотрудников" value={group} onChange={e=>setGroup(e.target.value)}>
     <option value="work">Под контролем</option><option value="off">Без контроля</option><option value="all">Вся компания</option>
     {Object.entries(groupLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}
    </select><input aria-label="Поиск сотрудника" placeholder="Имя, должность, подразделение или логин" value={query} onChange={e=>setQuery(e.target.value)}/>
    <select aria-label="Сортировка сотрудников" value={sort} onChange={e=>setSort(e.target.value)}>
     <option value="name">По имени</option><option value="ready">С входом сначала</option><option value="setup">Без входа сначала</option>
    </select>
   </div>
   <div className="table-scroll"><table><thead><tr><th>Сотрудник и должность</th><th>Права в системе</th><th>Контроль сроков</th><th>Вход в панель</th><th>Telegram</th><th>Просмотр</th></tr></thead><tbody>{people.map(({person:p,login})=>{
   const editable=mayManageStaffIdentity(actor,p);
   const accountEditable=mayManageStaffAccounts(actor)&&!p.root_access&&p.id!==actor.id;
   return <tr key={p.id}>
    <td><strong>{p.name}</strong><br/><small>{[p.position,p.branch_id].filter(Boolean).join(' · ')}</small></td>
    <td>{p.root_access?'Владелец':roles[p.role]}{editable&&<div><button className="text-button" aria-label={'Изменить доступ для '+p.name} onClick={()=>setProfile(p)}>Изменить</button></div>}</td>
    <td>
     {rollout.value?.enabled&&p.work_groups?<label className="staff-control-toggle">
      <input type="checkbox" aria-label={'Контроль сроков: '+p.name} checked={p.work_controlled} disabled={busy||controlBusy}
       onChange={e=>void changeControl(p,e.target.checked)}/>
      {p.work_controlled?'Включён':'Выключен'}
     </label>:<strong>{p.work_controlled?'Включён':'—'}</strong>}
     {!!p.work_groups?.length&&<div><small>{p.work_groups.map(g=>groupLabels[g]).join(' · ')}</small></div>}
     {rollout.value?.enabled&&p.work_groups&&p.work_control_override!==null&&
      <button type="button" className="text-button" disabled={busy||controlBusy} onClick={()=>void changeControl(p,null)}>По правилам группы</button>}
    </td>
    <td><small className="access-login-status" data-state={login.state}>{login.label}</small>{p.active_session&&<small className="muted"> · есть активная сессия</small>}{p.accounts.length?p.accounts.map(a=><div key={a.username}>
     {a.password_login===false?'Telegram / QR':a.username}{a.enabled?'':' · отключён'}
     {accountEditable&&<div className="notice-actions">
      <button className="text-button" disabled={accountBusy} onClick={()=>void changeAccount(p,a.username,a.enabled?'disable':'enable')}>{a.enabled?'Отключить вход':'Включить вход'}</button>
      {a.enabled&&(a.password_login===false
       ?<button className="text-button" onClick={()=>{setAccountPerson(p);setAccountLogin(p.suggestedLogin);setNewAccount(null);setAccountError('');}}>Создать пароль</button>
       :<button className="text-button" disabled={accountBusy} onClick={()=>void changeAccount(p,a.username,'reset')}>Сбросить пароль</button>)}
     </div>}
    </div>):accountEditable&&<button className="text-button" disabled={accountBusy} onClick={()=>{setAccountPerson(p);setAccountLogin(p.suggestedLogin);setNewAccount(null);setNotice('');setAccountError('');}}>Создать вход</button>}</td>
    <td>{p.paired_at?<><span>Подключён · {moscowTimestamp(p.paired_at)}</span>{editable&&<><br/><button className="text-button" onClick={()=>{setTelegramPerson(p);setTelegramConfirmed(false);setInviteError('');}}>Отключить</button></>}</>:editable?<>{p.invitation_expires&&<small>Приглашение до {moscowTimestamp(p.invitation_expires)}<br/></small>}<button className="text-button" disabled={creating} onClick={()=>void createInvite(p)}>{p.invitation_expires?'Перевыпустить ссылку':'Создать приглашение'}</button><br/><button className="text-button" onClick={()=>{setTelegramPerson(p);setTelegramId('');setTelegramConfirmed(false);setInviteError('');}}>Привязать по ID</button></>:<small>Подключает владелец</small>}</td>
    <td>{!p.root_access&&<a className="text-button" href={viewAsLink(p.id)} target="_blank" rel="noopener" aria-label={`Открыть как ${p.name}`}>Открыть как сотрудник ↗</a>}<br/><small>{p.visibleTasks} задач</small></td>
   </tr>;})}</tbody></table></div>{!people.length&&<p>По этому запросу сотрудники не найдены.</p>}</>}
 </section>;
}
