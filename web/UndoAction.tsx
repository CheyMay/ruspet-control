import {useEffect,useState} from 'react';
import {api} from './api.js';
type Last={id:string;task_id:string;label:string;expiresAt:string};
export function UndoAction({refreshKey,taskId,busy,act}:{refreshKey:string;taskId?:string;busy:boolean;act:(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>}){
 const [last,setLast]=useState<Last|null>(null),[confirm,setConfirm]=useState(false),[now,setNow]=useState(Date.now());
 useEffect(()=>{let live=true;api<Last|null>('/undo/last').then(v=>{if(live){setLast(v);setConfirm(false);setNow(Date.now())}}).catch(()=>{if(live)setLast(null)});return()=>{live=false}},[refreshKey,taskId]);
 useEffect(()=>{if(!last)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[last]);
 const seconds=last?Math.max(0,Math.ceil((Date.parse(last.expiresAt)-now)/1000)):0;
 if(!last||!seconds||taskId&&last.task_id!==taskId)return null;
 return <section className="undo-bar"><div><strong>Последнее действие · #{last.task_id}</strong><p>{last.label} · отмена доступна ещё {Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</p></div><button className="button secondary" disabled={busy} onClick={()=>setConfirm(true)}>Отменить действие</button>{confirm&&<div className="modal-backdrop"><section className="modal" role="alertdialog" aria-modal="true" aria-label="Подтвердить отмену"><h2>Отменить «{last.label}»?</h2><p>Задача вернётся к состоянию до действия. В истории останутся исходное действие и его отмена. Если участники уже получили уведомление, им будет отправлено уточнение.</p><div className="drawer-actions"><button className="button secondary" disabled={busy} onClick={()=>setConfirm(false)}>Оставить действие</button><button className="button primary" disabled={busy} onClick={async()=>{const ok=await act('/undo',{id:last.id,confirmed:true},'POST','Действие отменено. История сохранена.');setConfirm(false);if(ok)setLast(null)}}>Да, отменить</button></div></section></div>}</section>;
}
