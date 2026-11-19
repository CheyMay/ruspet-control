import {useEffect,useState} from 'react';
import {api} from './api.js';
import './staff-undo.css';

type Entry={
 id:string;label:string;author:string;createdAt:string;undoneAt:string|null;
 undoneBy:string|null;reason:string|null;problem:string|null;
};
const moscowTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'});

export function StaffUndo({taskId,refreshKey,busy,error,act}:{
 taskId:string;refreshKey:string;busy:boolean;error:string;
 act:(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>;
}){
 const [entries,setEntries]=useState<Entry[]|null>(null);
 const [failed,setFailed]=useState(false);
 const [selected,setSelected]=useState<Entry|null>(null);
 const [reason,setReason]=useState('');
 const [submitted,setSubmitted]=useState(false);
 useEffect(()=>{
  let active=true;
  api<Entry[]>('/tasks/'+encodeURIComponent(taskId)+'/staff-undo','GET',undefined,{timeout:7000}).then(rows=>{
   if(active){setEntries(rows);setFailed(false);}
  }).catch(()=>{if(active)setFailed(true);});
  return()=>{active=false};
 },[taskId,refreshKey]);

 return <section className="staff-undo" aria-label="Действия за сегодня">
  <h3>Действия за сегодня · МСК</h3>
  {failed?<p className="muted" role="status">Не удалось обновить список. Откройте вкладку ещё раз.</p>:
   entries===null?<p className="muted" role="status">Загружаем действия…</p>:entries.length===0?<p className="muted">За сегодня действий в РУСПЭТ пока нет.</p>:
   <ul>{entries.map(entry=><li key={entry.id}>
    <div className="staff-undo-entry">
     <div>
      <small className="muted"><time dateTime={entry.createdAt}>{moscowTime.format(new Date(entry.createdAt))}</time> · {entry.author}</small>
      <strong>{entry.label}</strong>
      {entry.problem&&<small className="muted">{entry.undoneAt&&entry.undoneBy?
       `Отменено в ${moscowTime.format(new Date(entry.undoneAt))} · ${entry.undoneBy}`:entry.problem}</small>}
      {entry.reason&&<small className="muted">{entry.reason}</small>}
     </div>
     {!entry.problem&&<button type="button" className="button secondary" disabled={busy}
      onClick={()=>{setSelected(entry);setReason('');setSubmitted(false)}}>Отменить</button>}
    </div>
   </li>)}</ul>}
  {selected&&<div className="modal-backdrop">
   <form className="modal staff-undo-dialog" role="dialog" aria-modal="true" aria-labelledby="staff-undo-title"
    onSubmit={async e=>{
     e.preventDefault();
     if(busy||reason.trim().length<5)return;
     setSubmitted(true);
     const ok=await act('/undo/staff',{id:selected.id,confirmed:true,reason},'POST','Действие отменено. Причина сохранена в истории.');
     if(ok){
      setEntries(rows=>rows?.map(row=>row.id===selected.id?{...row,problem:'Действие уже отменено.',reason}:row)??null);
      setSelected(null);
     }
    }}>
    <h2 id="staff-undo-title">Отменить «{selected.label}»?</h2>
    <p>Автор действия — {selected.author}. Задача вернётся к состоянию до действия, а причина останется в истории.</p>
    <label>Причина отмены
     <textarea autoFocus required minLength={5} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/>
    </label>
    {submitted&&error&&<p className="alert error" role="alert">{error}</p>}
    <div className="drawer-actions">
     <button type="button" className="button secondary" disabled={busy} onClick={()=>setSelected(null)}>Оставить действие</button>
     <button type="submit" className="button primary" disabled={busy||reason.trim().length<5}>Да, отменить</button>
    </div>
   </form>
  </div>}
 </section>;
}
