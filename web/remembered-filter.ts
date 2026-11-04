import {useMemo,useState} from 'react';

export function useRememberedFilter(userId:string|undefined,field:string,initial:string) {
 const key=userId?'ruspet.filters.'+userId+'.'+field:null;
 const stored=useMemo(()=>{
  try{return key?sessionStorage.getItem(key)??initial:initial;}catch{return initial;}
 },[key,initial]);
 const [change,setChange]=useState<{key:string|null;value:string}|null>(null);
 function setValue(value:string){
  setChange({key,value});
  try{if(key)sessionStorage.setItem(key,value);}catch{/* The filter still works in this view. */}
 }
 return [change?.key===key?change.value:stored,setValue] as const;
}
