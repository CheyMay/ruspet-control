import {useEffect,useRef,useState} from 'react';
import './interaction-controls.css';

async function copyNumber(number:string){
 try{await navigator.clipboard.writeText(number);return true;}catch{}
 const field=document.createElement('textarea');
 field.value=number;
 field.setAttribute('readonly','');
 field.style.cssText='position:fixed;left:0;top:0;opacity:0;pointer-events:none;';
 const focused=document.activeElement as HTMLElement|null;
 document.body.append(field);
 field.select();
 try{return document.execCommand('copy');}catch{return false;}
 finally{field.remove();focused?.focus({preventScroll:true});}
}

export function TaskId({number,className=''}:{number:string;className?:string}){
 const [status,setStatus]=useState('');
 const timer=useRef<ReturnType<typeof setTimeout>>(undefined);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 return <span className={'task-id-copy '+className}>
  <button type="button" aria-label={'Скопировать номер задачи '+number} title={'Скопировать #'+number}
   onClick={async event=>{
    event.stopPropagation();
    setStatus(await copyNumber(number)?'Скопировано':'Не удалось скопировать');
    clearTimeout(timer.current);
    timer.current=setTimeout(()=>setStatus(''),2200);
   }}>#{number}</button>
  <span className="task-id-copy-status" role="status">{status}</span>
 </span>;
}

export function TaskReferences({text}:{text:string}){
 const parts=text.split(/(#(?:\d+|L-[\p{L}\d_-]+)(?![\p{L}\d_-]))/giu);
 return <>{parts.map((part,index)=>index%2===1?<TaskId key={index} number={part.slice(1)}/>:part)}</>;
}
