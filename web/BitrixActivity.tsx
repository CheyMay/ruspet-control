import {useEffect,useState} from 'react';
import {api} from './api.js';
type Activity={kind:'comment'|'history';external_id:string;occurred_at:string;author:string;body:string};

export function BitrixActivity({id,kind}:{id:string;kind:Activity['kind']}){
 const [rows,setRows]=useState<Activity[]|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  let current=true;setRows(null);setError('');
  void api<Activity[]>('/tasks/'+encodeURIComponent(id)+'/bitrix-activity?kind='+kind).then(result=>{if(current)setRows(result);}).catch(e=>{if(current)setError(e.message);});
  return()=>{current=false;};
 },[id,kind]);
 const entries=rows?.filter(row=>row.kind===kind);
 if(error)return <p className="muted" role="alert">{error}</p>;
 if(!entries?.length)return null;
 return <details className="bitrix-activity"><summary>Из Битрикс24 · {entries.length}</summary>
  {entries.map(row=><article key={row.external_id}><strong>{row.author}</strong> <small>{new Date(row.occurred_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</small><p>{row.body}</p></article>)}
 </details>;
}
