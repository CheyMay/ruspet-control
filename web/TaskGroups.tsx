import {useEffect,useState} from 'react';
import {api} from './api.js';

export type TaskGroupsData={groups:{id:string;name:string}[];items:Record<string,string>};
export function TaskGroupPicker({value,onChange,onAdded}:{value:string;onChange:(id:string)=>void|Promise<void>;onAdded?:()=>void}){
 const [groups,setGroups]=useState<TaskGroupsData['groups']>([]),[creating,setCreating]=useState(false);
 const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let current=true;
  void api<TaskGroupsData>('/task-groups').then(result=>{if(current)setGroups(result.groups);}).catch(e=>{if(current)setError(e.message);});
  return()=>{current=false;};
 },[]);
 async function change(id:string){
  setError('');setBusy(true);
  try{await onChange(id);}catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 async function add(){
  setError('');setBusy(true);
  try{
   const group=await api<TaskGroupsData['groups'][number]>('/task-groups','POST',{name});
   setGroups(current=>current.some(item=>item.id===group.id)?current:[...current,group]);
   onAdded?.();await onChange(group.id);setCreating(false);setName('');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className="task-group-picker">
  <label>Моя подборка<select value={value} disabled={busy} onChange={e=>void change(e.target.value)}>
   <option value="">Без подборки</option>{groups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}
  </select></label>
  {creating?<div className="task-quick-actions">
   <input aria-label="Название подборки" placeholder="Например, клиенты на запуске" value={name} maxLength={80}
    onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();if(name.trim()&&!busy)void add();}}}/>
   <button type="button" className="button secondary" disabled={busy||!name.trim()} onClick={()=>void add()}>Создать</button>
   <button type="button" className="text-button" onClick={()=>setCreating(false)}>Отмена</button>
  </div>:<button type="button" className="text-button" onClick={()=>setCreating(true)}>Новая подборка</button>}
  {error&&<p role="alert" className="muted">{error}</p>}
 </div>;
}
