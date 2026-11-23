import {useEffect,useState} from 'react';
import {api} from './api.js';
import {moscowTimestamp} from './SystemHealth.js';
import {VoiceRecorder} from './VoiceRecorder.js';

type Note={id:string;body:string;created_at:string;author:string};
type NotePage={notes:Note[];more:boolean};
export async function transcribeVoice(audio:Blob,mode?:'task'){
 const res=await fetch('/api/voice/transcript'+(mode?'?mode='+mode:''),{
  method:'POST',credentials:'same-origin',headers:{'Content-Type':audio.type},body:audio,signal:AbortSignal.timeout(45000)
 });
 const result=await res.json().catch(()=>null);
 if(!res.ok||!result)throw new Error(result?.error||'Не удалось распознать запись.');
 return result as {transcript:string;values?:Record<string,string>;assigneeId?:string;deadline?:string};
}

export function ClientNotes({id,taskId,name}:{id:string;taskId?:string;name?:string}){
 const path='/okb/companies/'+id+'/notes', query=taskId?'?task='+encodeURIComponent(taskId):'';
 const [page,setPage]=useState<NotePage|null>(null),[body,setBody]=useState(''),[error,setError]=useState('');
 const [busy,setBusy]=useState(false),[voice,setVoice]=useState(false),[open,setOpen]=useState(false);
 useEffect(()=>{
  if(!open)return;
  let current=true;
  void api<NotePage>(path+query).then(next=>{if(current)setPage(next);}).catch(e=>{if(current)setError(e.message);});
  void api<{enabled:boolean}>('/bot/voice').then(result=>{if(current)setVoice(result.enabled);}).catch(()=>{});
  return()=>{current=false;};
 },[path,query,open]);
 return <details className="automation-log client-notes" onToggle={e=>setOpen(e.currentTarget.open)}>
  <summary>{name?'Заметки · '+name:'Заметки о клиенте'}</summary>
  {error&&<p className="alert error" role="alert">{error}</p>}
  <form className="work-design-form" onSubmit={async event=>{
   event.preventDefault();setError('');setBusy(true);
   try{
    const note=await api<Note>(path+query,'POST',{body});
    setBody('');setPage(current=>({notes:[note,...(current?.notes??[])],more:current?.more??false}));
   }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }}>
   <label>Что важно знать о клиенте<textarea rows={4} required maxLength={20000} value={body} onChange={e=>setBody(e.target.value)}/></label>
   <div className="drawer-actions">
    {voice&&<VoiceRecorder label="Надиктовать заметку" hint="Расскажите, что важно сохранить о клиенте. Расшифровку можно отредактировать перед сохранением." disabled={busy} onSend={async audio=>{
     const {transcript}=await transcribeVoice(audio);
     setBody(current=>[current.trim(),transcript.trim()].filter(Boolean).join('\n\n').slice(0,20000));
    }}/>}
    <button className="button secondary" disabled={busy||!page||!body.trim()}>Сохранить заметку</button>
   </div>
  </form>
  {page?.notes.length===0&&<p className="muted">Заметок пока нет.</p>}
  {page?.notes.map(note=><article className="client-note" key={note.id}>
   <small>{note.author} · {moscowTimestamp(note.created_at)}</small>
   <p>{note.body}</p>
  </article>)}
  {page?.more&&<button type="button" className="text-button" disabled={busy} onClick={async()=>{
   const cursor=page.notes.at(-1)?.id;if(!cursor)return;
   setBusy(true);setError('');
   try{
    const next=await api<NotePage>(path+query+(query?'&':'?')+'before='+cursor);
    setPage(current=>({notes:[...(current?.notes??[]),...next.notes],more:next.more}));
   }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }}>Показать более ранние</button>}
 </details>;
}
