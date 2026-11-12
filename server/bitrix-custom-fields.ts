import type {Task} from '../shared/types.js';
import {pool,type Db} from './db.js';
import {BitrixError} from './bitrix-rest.js';
export async function customFieldMappings(custom:Task['custom_fields'],db:Db=pool){
 if(!custom?.length)return [];
 const metadata=(await db.query('SELECT fields FROM bitrix_metadata WHERE id=1')).rows[0]?.fields??{};
 return custom.map(field=>{
  const matches=Object.entries(metadata).filter(([key,m])=>/^UF_[A-Z0-9_]+$/.test(key)&&((m as {title?:string}).title===field.label||key===field.label));
  if(matches.length!==1)throw new BitrixError('Нет однозначного поля Битрикс24 для локального дополнительного поля. Проверьте метаданные и названия.');
  return {local:field,code:matches[0][0],metadata:matches[0][1] as Record<string,any>};
 });
}
export function encodeCustomField(value:string,metadata:Record<string,any>):unknown{
 if(metadata.multiple===true){let list:unknown;try{list=JSON.parse(value);}catch{list=value.split(',').map(v=>v.trim()).filter(Boolean);}if(!Array.isArray(list))throw new BitrixError('Множественное поле требует списка значений.');return list;}
 if(value==='')return '';
 if(metadata.values&&typeof metadata.values==='object'){
  const matches=Object.entries(metadata.values).filter(([key,label])=>key===value||label===value);
  if(matches.length!==1)throw new BitrixError('Неизвестное значение перечисления дополнительного поля.');
  return matches[0][0];
 }
 if(['integer','double'].includes(metadata.type)){
  const number=Number(value.replace(',','.'));if(!Number.isFinite(number)||metadata.type==='integer'&&!Number.isInteger(number))throw new BitrixError('Неверное число дополнительного поля.');return number;
 }
 if(['boolean','bool'].includes(metadata.type)){
  if(['1','Y','Да','true'].includes(value))return '1';if(['0','N','Нет','false'].includes(value))return '0';throw new BitrixError('Неверное логическое значение дополнительного поля.');
 }
 return value;
}
export function decodeCustomField(value:unknown,metadata:Record<string,any>){
 if(value===null||value===undefined)return '';
 if(Array.isArray(value)||typeof value==='object')return JSON.stringify(value);
 const text=String(value);return String(metadata.values?.[text]??text);
}
export async function customCreationFields(task:Task){
 return Object.fromEntries((await customFieldMappings(task.custom_fields)).map(field=>[field.code,encodeCustomField(field.local.value,field.metadata)]));
}
