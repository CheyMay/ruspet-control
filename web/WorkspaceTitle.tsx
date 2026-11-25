import {Check,Pencil,X} from 'lucide-react';
import {useState} from 'react';

export function WorkspaceTitle({value,save}:{value:string;save?:(value:string)=>Promise<void>}){
 const [draft,setDraft]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 if(!save)return <>{value}</>;
 if(draft===null)return <span className="workspace-title-editable">{value}
  <button type="button" className="icon-button" aria-label={'Переименовать «'+value+'»'} onClick={()=>{setDraft(value);setError('')}}><Pencil size={15}/></button>
 </span>;
 return <span className="workspace-title-editable">
  <input aria-label="Название" value={draft} maxLength={100} autoFocus disabled={busy} onChange={e=>setDraft(e.target.value)}
   onKeyDown={e=>{if(e.key==='Escape')setDraft(null);if(e.key==='Enter'){e.preventDefault();void commit();}}}/>
  <button type="button" className="icon-button" aria-label="Сохранить название" disabled={busy||!draft.trim()} onClick={()=>void commit()}><Check size={16}/></button>
  <button type="button" className="icon-button" aria-label="Отмена" disabled={busy} onClick={()=>setDraft(null)}><X size={16}/></button>
  {error&&<small role="alert">{error}</small>}
 </span>;
 async function commit(){
  if(!save||!draft?.trim()||busy)return;
  setBusy(true);setError('');
  try{await save(draft.trim());setDraft(null);}
  catch(e){setError((e as Error).message);}
  finally{setBusy(false);}
 }
}
