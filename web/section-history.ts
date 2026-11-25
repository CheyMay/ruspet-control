import {useEffect,useState} from 'react';

export function pushSectionStep(values:Record<string,string|null>){
 const url=new URL(location.href);
 for(const [key,value] of Object.entries(values)){
  if(value)url.searchParams.set(key,value);
  else url.searchParams.delete(key);
 }
 if(url.href===location.href)return;
 history.pushState({...history.state,ruspet:true,depth:(history.state?.depth??0)+1},'',url);
 window.dispatchEvent(new Event('ruspet:section-step'));
}

export function useSectionParam(key:string){
 const read=()=>new URLSearchParams(location.search).get(key)??'';
 const [value,setValue]=useState(read);
 useEffect(()=>{
  const follow=()=>setValue(read());
  window.addEventListener('popstate',follow);
  return()=>window.removeEventListener('popstate',follow);
 },[key]);
 return [value,(next:string)=>{pushSectionStep({[key]:next});setValue(next);}] as const;
}
