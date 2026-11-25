import {ArrowUpRight,Clock3,Search,X} from 'lucide-react';
import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import {searchKindLabels,searchKinds,searchRank,searchTerms,type SearchFilters,type SearchHit,type SearchResponse} from '../shared/workspace-search.js';
import type {User} from '../shared/types.js';
import {api} from './api.js';
import {EmployeeFilter,SearchFilter} from './SearchFilter.js';
import './command-panel.css';

export type WorkspaceCommand={id:string;label:string;keywords?:string;run:()=>void};
type Usage=Record<string,{last:number;count:number}>;
type Props={userId:string;commands:WorkspaceCommand[];branches:string[];people:User[];close:()=>void;open:(hit:SearchHit)=>void};
type Choice={key:string;label:string;subtitle?:string;excerpt?:string;run:()=>void};
type Group={label:string;items:Choice[];recent?:boolean};

function recentCommands(storageKey:string):Usage{
 try{return JSON.parse(localStorage.getItem(storageKey)??'{}')??{};}catch{return {};}
}
function Highlight({text,terms}:{text:string;terms:string[]}){
 if(!terms.length)return text;
 const matches=new RegExp('('+terms.map(term=>term.replaceAll('е','[её]')).join('|')+')','giu');
 return text.split(matches).map((part,index)=>index%2?<mark key={index}>{part}</mark>:part);
}

export function CommandPanel({userId,commands,branches,people,close,open}:Props){
 const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null);
 const listId=useId(),titleId=useId(),storageKey='ruspet.commands.'+userId;
 const [usage,setUsage]=useState(()=>recentCommands(storageKey));
 const [query,setQuery]=useState(''),[filters,setFilters]=useState<SearchFilters>({});
 const [highlight,setHighlight]=useState(0);
 const [response,setResponse]=useState<{key:string;data?:SearchResponse;error?:string}|null>(null);
 const terms=searchTerms(query),searchable=terms.join('').length>=2&&query.trim().length<=160;
 const params=new URLSearchParams({q:query.trim()});
 for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);
 const requestKey=params.toString(),current=response?.key===requestKey?response:null;
 const invalidPeriod=!!filters.from&&!!filters.to&&filters.from>filters.to;
 const hasFilters=Object.values(filters).some(Boolean);
 useEffect(()=>{
  const modal=dialog.current,previous=document.activeElement;
  modal?.showModal();input.current?.focus({preventScroll:true});
  return()=>{
   modal?.close();
   if(previous instanceof HTMLElement)queueMicrotask(()=>{
    if(previous.isConnected&&document.activeElement===document.body)previous.focus({preventScroll:true});
   });
  };
 },[]);
 useEffect(()=>{
  if(!searchable||invalidPeriod)return;
  let active=true;
  const timer=setTimeout(()=>{
   void api<SearchResponse>('/workspace-search?'+requestKey,'GET',undefined,{timeout:8500})
    .then(data=>{if(active)setResponse({key:requestKey,data});})
    .catch((error:Error)=>{if(active)setResponse({key:requestKey,error:error.message});});
  },180);
  return()=>{active=false;clearTimeout(timer);};
 },[requestKey,searchable,invalidPeriod]);

 function updateFilters(next:SearchFilters){setFilters(next);setHighlight(0);}
 function runCommand(command:WorkspaceCommand){
  const previous=usage[command.id];
  const next={...usage,[command.id]:{last:Date.now(),count:(previous?.count??0)+1}};
  setUsage(next);
  try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{/* Navigation also works without storage. */}
  close();command.run();
 }
 const toChoice=(command:WorkspaceCommand):Choice=>({key:'command:'+command.id,label:command.label,run:()=>runCommand(command)});
 const defaultCommands=commands.filter(command=>usage[command.id]);
 const recent=defaultCommands.sort((a,b)=>usage[b.id].last-usage[a.id].last).slice(0,3);
 const frequent=defaultCommands.filter(command=>!recent.includes(command)&&usage[command.id].count>1)
  .sort((a,b)=>usage[b.id].count-usage[a.id].count).slice(0,3);
 const suggested=commands.filter(command=>!recent.includes(command)&&!frequent.includes(command)).slice(0,5);
 const results:Group[]=!query.trim()?[
  {label:'Недавние',items:recent.map(toChoice),recent:true},{label:'Частые',items:frequent.map(toChoice)},
  {label:'Быстрые действия',items:suggested.map(toChoice)}
 ]:[
  {label:'Команды',items:filters.kind?[]:commands.map(command=>({command,rank:searchRank(terms,command.label,command.keywords)}))
   .filter(item=>terms.length&&item.rank>0).sort((a,b)=>b.rank-a.rank).slice(0,6).map(item=>toChoice(item.command))},
  ...searchKinds.map(kind=>({label:searchKindLabels[kind],items:(current?.data?.hits??[]).filter(hit=>hit.kind===kind)
   .map(hit=>({key:[hit.kind,hit.taskId??'',hit.id].join(':'),label:hit.title,subtitle:hit.subtitle,excerpt:hit.excerpt,run:()=>{close();open(hit);}}))}))
 ];
 const choices=results.flatMap(group=>group.items),selected=Math.min(highlight,choices.length-1);
 const optionId=(index:number)=>listId+'-option-'+index;
 function onKeys(event:KeyboardEvent<HTMLInputElement>){
  if(event.nativeEvent.isComposing||!choices.length)return;
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();
   const next=(selected+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
   document.getElementById(optionId(next))?.scrollIntoView({block:'nearest'});
   setHighlight(next);
  }else if(event.key==='Enter'&&choices[selected]){
   event.preventDefault();choices[selected].run();
  }
 }
 return <dialog ref={dialog} className="command-panel" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();close();}}
  onClick={event=>{if(event.target===event.currentTarget)close();}}>
  <div className="command-panel-body">
   <div className="command-panel-top"><Search size={21}/><div>
    <label id={titleId} htmlFor={listId+'-query'}>Команды и поиск</label>
    <input id={listId+'-query'} ref={input} type="search" role="combobox" autoComplete="off" maxLength={160}
     aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={selected>=0?optionId(selected):undefined}
     value={query} placeholder="Действие, номер задачи или имя" onKeyDown={onKeys}
     onChange={event=>{setQuery(event.target.value);setHighlight(0);}}/>
   </div><button type="button" className="icon-button" aria-label="Закрыть поиск" onClick={close}><X size={18}/></button></div>
   {!!query.trim()&&<div className="command-panel-filters">
    <label>Искать в<select value={filters.kind??''} onChange={event=>updateFilters({kind:(event.target.value||undefined) as SearchFilters['kind']})}>
     <option value="">Везде</option>{searchKinds.map(kind=><option key={kind} value={kind}>{searchKindLabels[kind]}</option>)}
    </select></label>
    <details className="command-context-filters"><summary>Фильтры{Object.entries(filters).some(([key,value])=>key!=='kind'&&value)?' · активны':''}</summary>
     <div className="command-context-fields">
      <SearchFilter label="Подразделение" caption="Подразделение" value={filters.branch??''} onChange={branch=>updateFilters({...filters,branch})}
       empty={{value:'',label:'Все подразделения'}} options={branches.map(branch=>({value:branch,label:branch}))}/>
      <EmployeeFilter label="Исполнитель" caption="Исполнитель" value={filters.owner??''} onChange={owner=>updateFilters({...filters,owner})}
       empty={{value:'',label:'Все исполнители'}} people={people}/>
      <label>Дата с<input type="date" value={filters.from??''} max={filters.to||undefined} onChange={event=>updateFilters({...filters,from:event.target.value})}/></label>
      <label>По<input type="date" value={filters.to??''} min={filters.from||undefined} onChange={event=>updateFilters({...filters,to:event.target.value})}/></label>
     </div>
    </details>
    {hasFilters&&<button type="button" className="text-button" onClick={()=>updateFilters({})}>Сбросить</button>}
   </div>}
   <div className="command-panel-scroll">
    {invalidPeriod&&<p className="command-status" role="alert">Начало периода позже окончания.</p>}
    {!!query.trim()&&!invalidPeriod&&searchable&&!current&&<p className="command-status" role="status">Ищем по рабочему пространству…</p>}
    {current?.error&&<p className="command-status" role="alert">{current.error}</p>}
    {current?.data?.companiesUnavailable&&<p className="command-status" role="status">База клиентов сейчас недоступна.</p>}
    {!choices.length&&!invalidPeriod&&(!searchable||current?.data)&&<p className="command-status" role="status">{searchable?'Совпадений нет.':'Введите хотя бы два символа.'}</p>}
    <div id={listId} role="listbox" aria-label="Варианты поиска и команды">
     {results.filter(group=>group.items.length).map(group=><div key={group.label} role="group" aria-label={group.label} className="command-group">
      <div className="command-group-label">{group.recent&&<Clock3 size={13}/>} {group.label}</div>
      {group.items.map(item=>{
       const index=choices.indexOf(item);
       return <button key={item.key} id={optionId(index)} type="button" tabIndex={-1} role="option" aria-selected={index===selected}
        className="command-choice" onMouseDown={event=>event.preventDefault()} onMouseMove={()=>setHighlight(index)} onClick={item.run}>
        <span><strong><Highlight text={item.label} terms={terms}/></strong>
         {item.subtitle&&<small><Highlight text={item.subtitle} terms={terms}/></small>}
         {item.excerpt&&<small className="command-excerpt"><Highlight text={item.excerpt} terms={terms}/></small>}
        </span><ArrowUpRight size={16} aria-hidden="true"/>
       </button>;
      })}
     </div>)}
    </div>
   </div>
   <footer className="command-panel-footer"><span><kbd>↑</kbd> <kbd>↓</kbd> Выбрать</span><span><kbd>Enter</kbd> Открыть</span><span><kbd>Esc</kbd> Закрыть</span></footer>
  </div>
 </dialog>;
}
