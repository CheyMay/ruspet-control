import {Check,ChevronDown,X} from 'lucide-react';
import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import type {User} from '../shared/types.js';

type Option={value:string;label:string;hint?:string};
type FilterOptions={
 label:string; caption?:string;
 options:Option[]; empty?:Option; placeholder?:string; disabled?:boolean;
};
type FilterSelection={value:string;values?:never;onChange:(value:string)=>void}|
 {values:string[];value?:never;onChange:(values:string[])=>void};
type SearchFilterProps=FilterOptions&FilterSelection;

const normalize=(text:string)=>text.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е');

export function matchesFilter(text:string,query:string){
 const words=normalize(query).trim().split(/\s+/).filter(Boolean);
 const candidate=normalize(text);
 return words.every(word=>candidate.includes(word));
}

export function SearchFilter(props:SearchFilterProps){
 const {label,caption,options,empty,placeholder='Начните вводить',disabled=false}=props;
 const id=useId();
 const input=useRef<HTMLInputElement>(null),list=useRef<HTMLUListElement>(null),activeOption=useRef<HTMLLIElement>(null);
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[highlight,setHighlight]=useState(-1);
 const expanded=open&&!disabled;
 const choices=empty?[empty,...options]:options;
 const selected=new Set(props.values??(props.value===empty?.value?[]:[props.value]));
 const picked=options.filter(option=>selected.has(option.value));
 const summary=selected.size>1?'Выбрано: '+selected.size:picked[0]?.label??'';
 const isSelected=(option:Option)=>option.value===empty?.value?!selected.size:selected.has(option.value);
 const matches=choices.filter(option=>matchesFilter(option.label+' '+(option.hint??''),query));
 const active=matches.length?Math.min(highlight,matches.length-1):-1;

 useEffect(()=>{
  const area=list.current,row=activeOption.current;
  if(!expanded||!area||!row)return;
  if(row.offsetTop<area.scrollTop)area.scrollTop=row.offsetTop;
  else if(row.offsetTop+row.offsetHeight>area.scrollTop+area.clientHeight)area.scrollTop=row.offsetTop+row.offsetHeight-area.clientHeight;
 },[active,expanded,query]);

 function reveal(){
  if(disabled||expanded)return;
  setQuery('');setHighlight(choices.findIndex(isSelected));setOpen(true);
 }
 function close(){setOpen(false);setQuery('');setHighlight(-1);}
 function pick(option:Option){
  if(props.values!==undefined){
   if(option.value===empty?.value){props.onChange([]);return;}
   props.onChange(selected.has(option.value)?props.values.filter(value=>value!==option.value):[...props.values,option.value]);
   return;
  }
  close();
  if(option.value!==props.value)props.onChange(option.value);
 }
 function onKey(event:KeyboardEvent<HTMLInputElement>){
  if(event.nativeEvent.isComposing)return;
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
   event.preventDefault();
   if(!expanded){reveal();return;}
   const offset=event.key==='ArrowDown'?1:-1;
   const next=active<0&&offset<0?matches.length-1:active+offset;
   setHighlight(Math.max(0,Math.min(matches.length-1,next)));
  }else if(event.key==='Enter'){
   event.preventDefault();
   if(!expanded){reveal();return;}
   const option=matches[active>=0?active:0];
   if(option)pick(option);
  }else if(event.key==='Escape'&&expanded){
   event.preventDefault();event.stopPropagation();close();
  }else if(!expanded&&event.key.length===1&&!event.ctrlKey&&!event.altKey&&!event.metaKey){
   event.preventDefault();setOpen(true);setQuery(event.key);setHighlight(0);
  }else if(!expanded&&empty&&(event.key==='Backspace'||event.key==='Delete')){
   event.preventDefault();pick(empty);
  }
 }

 return <div className="search-filter" data-open={expanded||undefined} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))close();}}>
  {caption&&<label className="search-filter-caption" htmlFor={id}>{caption}</label>}
  <div className="search-filter-control">
   <input ref={input} id={id} type="text" role="combobox" aria-label={label} aria-expanded={expanded}
    aria-controls={expanded?id+'-list':undefined} aria-activedescendant={expanded&&active>=0?id+'-option-'+active:undefined}
    aria-autocomplete="list" autoComplete="off" spellCheck={false} disabled={disabled}
    value={expanded?query:summary} placeholder={expanded?placeholder:empty?.label??placeholder}
    title={!expanded&&picked.length?picked.map(option=>option.label).join(', '):undefined} onFocus={reveal} onClick={reveal} onKeyDown={onKey}
    onChange={event=>{
     event.stopPropagation();
     setOpen(true);setQuery(event.target.value);setHighlight(0);
    }}/>
   {empty&&selected.size>0&&<button type="button" tabIndex={-1} className="search-filter-button" disabled={disabled}
    aria-label={'Сбросить фильтр «'+label+'»'} onMouseDown={event=>event.preventDefault()} onClick={()=>pick(empty)}><X size={14}/></button>}
   <button type="button" tabIndex={-1} className="search-filter-button" disabled={disabled}
    aria-label={'Открыть варианты «'+label+'»'} onMouseDown={event=>event.preventDefault()}
    onClick={()=>{if(expanded){close();return;}input.current?.focus({preventScroll:true});reveal();}}><ChevronDown size={16}/></button>
  </div>
  {expanded&&<div className="search-filter-menu">
   <ul id={id+'-list'} ref={list} role="listbox" aria-label={label} aria-multiselectable={props.values!==undefined||undefined}>
    {matches.map((option,index)=><li ref={active===index?activeOption:undefined} key={option.value} id={id+'-option-'+index}
     role="option" aria-selected={isSelected(option)} className={`${active===index?'highlighted':''}${props.values!==undefined&&option.value!==empty?.value?' search-filter-multi-option':''}`}
     onMouseDown={event=>event.preventDefault()} onClick={()=>pick(option)}>
     {props.values!==undefined&&option.value!==empty?.value&&<span aria-hidden="true" className="search-filter-check">{isSelected(option)&&<Check size={12}/>}</span>}
     <span>{option.label}{option.hint&&<small>{option.hint}</small>}</span>
    </li>)}
   </ul>
   {!matches.length&&<p className="search-filter-empty" role="status">Ничего не найдено</p>}
  </div>}
 </div>;
}

type EmployeeFilterProps=Omit<FilterOptions,'options'>&FilterSelection&{people:Pick<User,'id'|'name'|'branch_id'|'position'>[]};

export function EmployeeFilter({people,...props}:EmployeeFilterProps){
 return <SearchFilter placeholder="Имя или подразделение" {...props} options={people.map(person=>({
  value:person.id,label:person.name,hint:[person.position,person.branch_id].filter(Boolean).join(' · ')
 }))}/>;
}
