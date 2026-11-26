import {TaskId} from './TaskId.js';
import {useEffect,useState} from 'react';
import {api} from './api.js';
type Last={id:string;task_id:string;label:string;remainingMs:number};
export function UndoAction({refreshKey,taskId,busy,act}:{refreshKey:string;taskId?:string;busy:boolean;act:(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>}){
 const [last,setLast]=useState<(Last&{expires:number})|null>(null),[confirm,setConfirm]=useState<string|null>(null),[now,setNow]=useState(performance.now());
 useEffect(()=>{
  let active=true;
  api<Last|null>(taskId?'/undo/last?taskId='+encodeURIComponent(taskId):'/undo/last','GET',undefined,{timeout:7000})
   .then(v=>{
    if(!active)return;
    const time=performance.now();
    setLast(v?{...v,expires:time+v.remainingMs}:null);
    setNow(time);
    setConfirm(id=>id===v?.id?id:null);
   }).catch(()=>{ /* Keep the known deadline during temporary connection failures. */ });
  return()=>{active=false};
 },[refreshKey,taskId]);
 useEffect(()=>{if(!last)return;const timer=setInterval(()=>setNow(performance.now()),1000);return()=>clearInterval(timer)},[last]);
 const seconds=last?Math.max(0,Math.ceil((last.expires-now)/1000)):0;
 if(!last||!seconds||taskId&&last.task_id!==taskId)return null;
 return <section className="undo-bar"><div><strong>Последнее действие · <TaskId number={last.task_id}/></strong><p>{last.label} · отмена доступна ещё {Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</p></div><button className="button secondary" disabled={busy} onClick={()=>setConfirm(last.id)}>Отменить действие</button>{confirm===last.id&&<div className="modal-backdrop"><section className="modal" role="alertdialog" aria-modal="true" aria-label="Подтвердить отмену"><h2>Отменить «{last.label}»?</h2><p>Задача вернётся к состоянию до действия. В истории останутся исходное действие и его отмена. Если участники уже получили уведомление, им будет отправлено уточнение.</p><div className="drawer-actions"><button className="button secondary" disabled={busy} onClick={()=>setConfirm(null)}>Оставить действие</button><button className="button primary" disabled={busy} onClick={async()=>{const ok=await act('/undo',{id:last.id,confirmed:true},'POST','Действие отменено. История сохранена.');setConfirm(null);if(ok)setLast(null)}}>Да, отменить</button></div></section></div>}</section>;
}
