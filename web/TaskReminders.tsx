import {useEffect,useState} from 'react';
import {api} from './api.js';
import type {Task,User} from '../shared/types.js';
import type {TaskReminder} from '../server/reminders.js';
type Alert={id:string;recipient_id:string;due_at:string;acknowledged_at:string|null;canceled_at:string|null;delivery_state:string|null};
type State={schedules:TaskReminder[];alerts:Alert[];bound:string[]};
const days=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
export function TaskReminders({task,user,users,readOnly=false}:{readOnly?:boolean;task:Task;user:User;users:User[]}){
 const [data,setData]=useState<State|null>(null),[selected,setSelected]=useState([1,2,3,4,5]),[times,setTimes]=useState(['09:00']),[multi,setMulti]=useState(false),[repeat,setRepeat]=useState(false),[weeks,setWeeks]=useState(3),[recipient,setRecipient]=useState(user.id),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const canEdit=task.creator_id===user.id||user.role!=='employee';
 const name=(id:string)=>users.find(u=>u.id===id)?.name||id;
 async function refresh(){setData(await api<State>(`/tasks/${task.id}/reminders`));}
 useEffect(()=>{void refresh().catch(e=>setError(e.message));},[task.id,user.id]);
 async function run(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="task-reminders"><h3>Напоминания по задаче · МСК</h3><p className="muted">Каждое напоминание нужно подтвердить кнопкой «ОК, увидел» в боте. Без подтверждения — повтор каждые 30 минут до конца дня. Подтверждение не закрывает задачу.</p>
 {error&&<p className="alert error" role="alert">{error}</p>}
 {!readOnly&&task.status!=='completed'&&<form onSubmit={e=>{e.preventDefault();void run(()=>api(`/tasks/${task.id}/reminders`,'POST',{recipientId:recipient,days:selected,times:multi?times:times.slice(0,1),weeks:repeat?weeks:1}));}}>
  <label>Кому<select value={recipient} onChange={e=>setRecipient(e.target.value)}><option value={user.id}>Мне · {user.name}</option>{canEdit&&task.assignee_id!==user.id&&<option value={task.assignee_id}>Исполнителю · {name(task.assignee_id)}</option>}</select></label>
  <fieldset className="reminder-days"><legend>Дни недели</legend>{days.map((label,i)=><button type="button" key={label} aria-pressed={selected.includes(i+1)} onClick={()=>setSelected(a=>a.includes(i+1)?a.filter(d=>d!==i+1):[...a,i+1])}>{label}</button>)}</fieldset>
  <div className="reminder-times">{(multi?times:times.slice(0,1)).map((time,i)=><label key={i}>Время {i+1}<input aria-label={'Время напоминания '+(i+1)} type="time" required value={time} onChange={e=>setTimes(a=>a.map((t,j)=>j===i?e.target.value:t))}/>{multi&&i>0&&<button type="button" className="text-button" onClick={()=>setTimes(a=>a.filter((_,j)=>j!==i))}>Убрать</button>}</label>)}{multi&&times.length<8&&<button type="button" className="button secondary" aria-label="Добавить время" onClick={()=>setTimes(a=>[...a,'18:00'])}>＋ Время</button>}</div>
  <label className="reminder-check"><input type="checkbox" checked={multi} onChange={e=>setMulti(e.target.checked)}/>Несколько раз в день</label>
  <label className="reminder-check"><input type="checkbox" checked={repeat} onChange={e=>setRepeat(e.target.checked)}/>Повторять несколько недель</label>
  {repeat&&<label>Количество недель<input type="number" min={1} max={52} required value={weeks} onChange={e=>setWeeks(Number(e.target.value))}/></label>}
  <p className="muted">{repeat?`Повтор в течение ${weeks} недель с сегодняшнего дня.`:'Выбранные дни в течение ближайших 7 дней, без дальнейшего повтора.'}</p>
  {data&&!data.bound.includes(recipient)&&<p className="inline-note">Telegram получателя ещё не привязан. Сначала откройте «Рабочий бот» под его учётной записью и привяжите личный чат.</p>}
  <button className="button primary" disabled={busy||!selected.length}>Сохранить напоминание</button>
 </form>}
 <div className="reminder-schedules">{data?.schedules.filter(r=>r.enabled).map(r=><article key={r.id}><strong>{name(r.recipient_id)}</strong><p>{r.days.map(d=>days[d-1]).join(', ')} · {r.times.join(', ')} МСК · {r.weeks} нед. с {r.start_date}</p>{!readOnly&&<button className="text-button" disabled={busy} onClick={()=>void run(()=>api('/reminders/'+r.id,'DELETE'))}>Выключить расписание</button>}</article>)}</div>
 {!!data?.alerts.length&&<details><summary>Подтверждения и пропуски · {data.alerts.length}</summary>{data.alerts.map(a=><p key={a.id}>{new Date(a.due_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} · {name(a.recipient_id)} · {a.acknowledged_at?'Подтверждено '+new Date(a.acknowledged_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):a.canceled_at?'Отменено':a.delivery_state==='uncertain'?'Исход отправки неизвестен, автоповтор остановлен':a.delivery_state==='failed'?'Ошибка отправки':a.delivery_state==='sent'?'Отправлено, не подтверждено':'Пока не отправлено'}</p>)}</details>}
 </section>;
}
