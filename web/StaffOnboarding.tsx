import {useEffect,useRef,useState} from 'react';
import {api} from './api.js';
type Staff={id:string;name:string;organisation:string;department:string;user_id:string|null};
type Request={id:string;chat_id:string;entered_name:string;staff_id:string|null;own_contact_verified:boolean;phone_tail:string|null};
type Queue={requests:Request[];staff:Staff[];users:{id:string;name:string;role:string;branch_id:string}[]};
type Preview={digest:string;count:number;duplicates:number;rows:{name:string;organisation:string;department:string;hasPhone:boolean;matched:boolean;ambiguous:boolean}[]};
export function StaffOnboarding({roles}:{roles:Record<string,string>}){
 const fileInput=useRef<HTMLInputElement>(null);
 const [queue,setQueue]=useState<Queue|null>(null),[total,setTotal]=useState(0),[file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [selected,setSelected]=useState<Request|null>(null),[staffId,setStaffId]=useState(''),[userId,setUserId]=useState(''),[confirmed,setConfirmed]=useState(false);
 async function refresh(){try{const [q,s]=await Promise.all([api<Queue>('/system/registrations'),api<{total:number}>('/system/staff')]);setQueue(q);setTotal(s.total);}catch(e){setError((e as Error).message)}}
 useEffect(()=>{void refresh()},[]);
 async function upload(apply=false){
  if(!file||busy)return;setBusy(true);setError('');setNotice('');
  try{
   const response=await fetch('/api/system/staff/import'+(apply?'?confirmed='+preview!.digest:''),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream'},body:file});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Не удалось загрузить файл.');
   if(apply){setPreview(null);setFile(null);if(fileInput.current)fileInput.current.value='';setNotice(`Справочник обновлён: ${result.count} записей.`);await refresh()}else setPreview(result);
  }catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 async function review(action:'approve'|'reject'){
  if(!selected||(action==='approve'&&!confirmed)||busy)return;setBusy(true);setError('');
  try{await api('/system/registrations/'+selected.id,'POST',{action,confirmed:true,...(action==='approve'?{staffId,userId:userId&&userId!=='new'?userId:undefined,forceNew:userId==='new'}:{})});setSelected(null);setNotice(action==='approve'?'Сотрудник подключён. Попросите его отправить /start.':'Заявка отклонена.');await refresh()}
  catch(e){setError((e as Error).message)}finally{setBusy(false)}
 }
 return <section className="panel automation-settings staff-onboarding">
  <div className="automation-heading"><div><h2>Знакомство сотрудников с ботом</h2><p className="muted">В справочнике: {total}. Сотрудник пишет /start, вводит имя и фамилию и делится своим номером через кнопку Telegram.</p></div><button className="button secondary" disabled={busy} onClick={()=>void refresh()}>Обновить заявки</button></div>
  <p className="muted">Уникальное совпадение имени и собственного номера подтверждается автоматически. Если номер другой, есть тёзки или прежнюю привязку отключали — нужна проверка администратора. Роли существующих сотрудников сохраняются; новые получают роль сотрудника.</p>
  {error&&<p className="alert error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <label>Справочник сотрудников (.xlsx)<input ref={fileInput} type="file" accept=".xlsx" disabled={busy} onChange={e=>{setFile(e.target.files?.[0]||null);setPreview(null);setNotice('')}}/></label>
  <button className="button secondary" disabled={!file||busy} onClick={()=>void upload()}>{busy?'Обрабатываем…':'Проверить файл'}</button>
  {preview&&<div className="source-banner"><strong>К загрузке: {preview.count} записей</strong><p>Без телефона: {preview.rows.filter(r=>!r.hasPhone).length}. Неоднозначных совпадений с учётными записями: {preview.rows.filter(r=>r.ambiguous).length}. Повторных строк объединено: {preview.duplicates}.</p><p>Добавляются контакты из справочника. Задачи, роли и существующие Telegram-привязки сохраняются. Отсутствующие в файле записи не удаляются.</p><div className="table-scroll"><table><thead><tr><th>Сотрудник</th><th>Организация / отдел</th><th>Сопоставление</th></tr></thead><tbody>{preview.rows.map((r,i)=><tr key={i}><td>{r.name}</td><td>{r.organisation} · {r.department}</td><td>{r.ambiguous?'Проверит администратор':r.matched?'Существующая учётная запись':'Создадим при подтверждении личности'}{!r.hasPhone?' · нет телефона':''}</td></tr>)}</tbody></table></div><button className="button primary" disabled={busy} onClick={()=>void upload(true)}>Подтвердить загрузку справочника</button></div>}
  <h3>Ожидают проверки · {queue?.requests.length??'—'}</h3>
  {queue&&!queue.requests.length&&<p className="muted">Новых заявок нет.</p>}
  {queue?.requests.map(r=><div className="source-banner" key={r.id}><strong>{r.entered_name}</strong><p>Telegram ID: {r.chat_id}. {r.own_contact_verified?`Передан собственный контакт · номер заканчивается на ${r.phone_tail}`:'Собственный номер не подтверждён.'}</p><button className="button secondary" disabled={busy} onClick={()=>{setSelected(r);setStaffId(r.staff_id||'');setUserId('');setConfirmed(false);setError('')}}>Проверить личность</button></div>)}
  {selected&&<div className="source-banner"><strong>Проверка · {selected.entered_name}</strong><label>Сотрудник справочника<select aria-label="Сотрудник справочника" value={staffId} disabled={busy} onChange={e=>{setStaffId(e.target.value);setUserId('');setConfirmed(false)}}><option value="">Выберите сотрудника</option>{queue?.staff.map(s=><option key={s.id} value={s.id}>{s.name} · {s.organisation} · {s.department}</option>)}</select></label><label>Учётная запись в системе<select aria-label="Учётная запись в системе" value={userId} disabled={busy||!!queue?.staff.find(s=>s.id===staffId)?.user_id} onChange={e=>{setUserId(e.target.value);setConfirmed(false)}}><option value="">Использовать сопоставление справочника</option>{queue?.users.map(u=><option key={u.id} value={u.id}>{u.name} · {u.branch_id} · {roles[u.role]}</option>)}<option value="new">Создать нового сотрудника</option></select></label>{queue?.staff.find(s=>s.id===staffId)?.user_id&&<p>Будет подключена существующая учётная запись: {queue.users.find(u=>u.id===queue.staff.find(s=>s.id===staffId)?.user_id)?.name} · {roles[queue.users.find(u=>u.id===queue.staff.find(s=>s.id===staffId)?.user_id)?.role||'']}</p>}<p>Подтвердите личность через известный вам рабочий канал. Ввод ФИО сам по себе не подтверждает, кто пишет боту.</p><label className="staff-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Личность и выбранная учётная запись проверены</label><button className="button primary" disabled={!confirmed||!staffId||busy} onClick={()=>void review('approve')}>Подтвердить привязку</button><button className="button secondary" disabled={busy} onClick={()=>void review('reject')}>Отклонить заявку</button><button className="button secondary" disabled={busy} onClick={()=>setSelected(null)}>Закрыть</button></div>}
 </section>;
}
