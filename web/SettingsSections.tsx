import {useId,useRef,useState,type ReactNode,type KeyboardEvent} from 'react';
import {useRememberedFilter} from './remembered-filter.js';
export type SettingsSection={id:string;label:string;content:ReactNode};
export function SettingsSections({userId,items,initial='rules'}:{userId:string;items:SettingsSection[];initial?:string}){
 const [stored,setStored]=useRememberedFilter(userId,'settings.section',initial);
 const active=items.some(item=>item.id===stored)?stored:items[0]?.id;
 const [visited,setVisited]=useState(()=>new Set([active]));
 const prefix=useId(),buttons=useRef<(HTMLButtonElement|null)[]>([]);
 function select(id:string){setStored(id);setVisited(old=>new Set([...old,id]));}
 function navigate(event:KeyboardEvent,index:number){
  let next=index;
  if(event.key==='ArrowRight')next=(index+1)%items.length;else if(event.key==='ArrowLeft')next=(index+items.length-1)%items.length;
  else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;else return;
  event.preventDefault();select(items[next].id);buttons.current[next]?.focus();
 }
 return <div className="settings-sections">
  <div className="tabs settings-tabs" role="tablist" aria-label="Разделы настроек">{items.map((item,index)=><button type="button" key={item.id} ref={element=>{buttons.current[index]=element;}} id={prefix+'-tab-'+item.id} role="tab" aria-selected={item.id===active} aria-controls={prefix+'-panel-'+item.id} tabIndex={item.id===active?0:-1} className={item.id===active?'selected':''} onClick={()=>select(item.id)} onKeyDown={e=>navigate(e,index)}>{item.label}</button>)}</div>
  {items.map(item=><section key={item.id} id={prefix+'-panel-'+item.id} role="tabpanel" aria-labelledby={prefix+'-tab-'+item.id} hidden={item.id!==active} className="settings-section">{visited.has(item.id)||item.id===active?item.content:null}</section>)}
 </div>;
}
