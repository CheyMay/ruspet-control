import {useEffect,useMemo,useState} from 'react';
import {api} from './api.js';
import {moscowTimestamp} from './SystemHealth.js';
import type {Task,User} from '../shared/types.js';

export type CompanyOption={id:string;name:string;tax_id:string|null};
export type TemplateContent={title:string;description:string;price?:number;customFields:NonNullable<Task['custom_fields']>;important?:boolean|null;customerRisk?:boolean|null};
export const templateExamples=[
 {name:'Связаться с клиентом',title:'Связаться с клиентом',description:'Уточнить текущую потребность и договориться о следующем шаге. В результате указать, что обсудили, с кем и на какую дату договорились.',customFields:[]},
 {name:'Подготовить КП',title:'Подготовить коммерческое предложение',description:'Согласовать ассортимент, объём и условия поставки. Приложить ссылку на готовое предложение.',customFields:[{label:'Объём заказа',value:''},{label:'Спецификация',value:''}]},
 {name:'Проверить отгрузку',title:'Проверить готовность к отгрузке',description:'Сверить остаток, документы и дату отгрузки. В результате указать, что готово и какие вопросы открыты.',customFields:[{label:'Номер заказа',value:''}]}
];

export function CompanyPicker({value,onChange}:{value:string|null;onChange:(value:string|null)=>void}){
 const [query,setQuery]=useState(''),[results,setResults]=useState<CompanyOption[]>([]),[selected,setSelected]=useState<CompanyOption|null>(null);
 const [error,setError]=useState(''),[loading,setLoading]=useState(false);
 useEffect(()=>{
  let active=true;
  setLoading(true);setError('');setResults([]);
  const timer=setTimeout(()=>void api<CompanyOption[]>('/okb/companies?q='+encodeURIComponent(query.trim())).then(rows=>{
   if(active)setResults(rows);
  }).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);}),220);
  return()=>{active=false;clearTimeout(timer);};
 },[query]);
 useEffect(()=>{
  if(!value){setSelected(null);return;}
  let active=true;
  void api<CompanyOption>('/okb/companies/'+value).then(row=>{if(active)setSelected(row);}).catch(()=>{});
  return()=>{active=false;};
 },[value]);
 const options=selected?.id===value&&!results.some(row=>row.id===value)?[selected,...results]:results;
 return <div className="task-company-picker">
  <label>Компания из ОКБ<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Найти по названию или ИНН"/></label>
  <select aria-label="Компания из ОКБ" value={value??''} onChange={e=>onChange(e.target.value||null)}>
   <option value="">{loading?'Загружаем компании…':'Без привязки'}</option>
   {value&&!options.some(row=>row.id===value)&&<option value={value}>Связанная компания</option>}
   {options.map(row=><option key={row.id} value={row.id}>{row.name}{row.tax_id?' · '+row.tax_id:''}</option>)}
  </select>
  {error&&<small className="red-text" role="alert">{error}</small>}
 </div>;
}
export function CompanyReference({id,open}:{id:string;open:(id:string)=>void}){
 const [name,setName]=useState('');
 useEffect(()=>{
  let current=true;
  void api<CompanyOption>('/okb/companies/'+id).then(row=>{if(current)setName(row.name);}).catch(()=>{});
  return()=>{current=false;};
 },[id]);
 return <p className="task-company-link">Компания · <button className="text-button" onClick={()=>open(id)}>{name||'Открыть в ОКБ'}</button></p>;
}
type Template={id:string;owner_id:string;name:string;content:TemplateContent;shared:boolean};
export function TaskTemplates({user,canShare,read,apply}:{user:User;canShare:boolean;read:()=>TemplateContent;apply:(value:TemplateContent)=>void}){
 const [items,setItems]=useState<Template[]>([]),[name,setName]=useState(''),[shared,setShared]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function load(){setItems(await api<Template[]>('/task-templates'));}
 useEffect(()=>{let live=true;void api<Template[]>('/task-templates').then(v=>{if(live)setItems(v);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
 async function change(id?:string){
  setBusy(true);setError('');setNotice('');
  try{
   if(id){await api('/task-templates/'+id,'DELETE');setNotice('Шаблон удалён.');}
   else{
    const content=read();
    if(name.trim().length<2||content.title.trim().length<3)throw new Error('Введите название шаблона и название задачи.');
    await api('/task-templates','POST',{name,shared,content});setName('');setNotice('Шаблон сохранён.');
   }
   await load();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <details className="task-template-library"><summary>Шаблоны и быстрый старт</summary>
  <div className="task-quick-actions">{templateExamples.map(item=><button key={item.name} className="button secondary" type="button" onClick={()=>apply(item)}>{item.name}</button>)}</div>
  {items.map(item=><div className="automation-run" key={item.id}><button className="text-button" type="button" onClick={()=>apply(item.content)}>{item.name}{item.shared?' · общий':''}</button>
   {item.owner_id===user.id&&<button className="text-button" type="button" disabled={busy} onClick={()=>void change(item.id)}>Удалить</button>}</div>)}
  <div className="task-quick-actions"><input aria-label="Название шаблона" maxLength={100} value={name} onChange={e=>setName(e.target.value)} placeholder="Название своего шаблона"/>
   <button className="button secondary" type="button" disabled={busy} onClick={()=>void change()}>Сохранить как шаблон</button>
  </div>
  {canShare&&<label className="task-share-template"><input type="checkbox" checked={shared} onChange={e=>setShared(e.target.checked)}/> Общий шаблон для руководителей</label>}
  <p className="muted">Шаблон заполняет пустые поля. Компания, исполнитель и сроки в шаблон не входят.</p>
  {notice&&<p role="status">{notice}</p>}{error&&<p className="red-text" role="alert">{error}</p>}
 </details>;
}
const tokens=(value:string)=>value.toLocaleLowerCase('ru-RU').replaceAll('ё','е').match(/[\p{L}\p{N}]{3,}/gu)??[];
export function TaskHints({title,description,companyId,tasks,users,owner}:{title:string;description:string;companyId:string|null;tasks:Task[];users:User[];owner:string}){
 const [debounced,setDebounced]=useState(title);
 useEffect(()=>{const timer=setTimeout(()=>setDebounced(title),180);return()=>clearTimeout(timer);},[title]);
 const matches=useMemo(()=>{
  const words=[...new Set(tokens(debounced))];
  if(!words.length)return [];
  return tasks.filter(t=>t.status!=='completed'&&(!companyId||t.company_id===companyId)).map(task=>{
   const candidate=new Set(tokens(task.title));
   return {task,score:words.filter(word=>candidate.has(word)).length};
  }).filter(item=>item.score>=Math.min(2,words.length)).sort((a,b)=>b.score-a.score).slice(0,3);
 },[debounced,tasks,companyId]);
 const pending=tasks.filter(t=>t.assignee_id===owner&&t.status!=='completed').length;
 if(!title.trim()&&!matches.length)return null;
 return <aside className="task-hints"><strong>Проверка перед постановкой</strong>
  {title.trim()&&!description.trim()&&<p>Добавьте ожидаемый результат. Например, какой документ приложить или с кем согласовать решение.</p>}
  {owner&&<p>{users.find(u=>u.id===owner)?.name||'Исполнитель'} · {pending} открытых задач в вашей выборке.</p>}
  {!!matches.length&&<><p>Похожие открытые задачи{companyId?' этой компании':''}</p><ul>{matches.map(({task})=><li key={task.id}>
   <a target="_blank" rel="noopener" className="text-button" href={'/?view=tasks&task='+encodeURIComponent(task.id)}>#{task.id} · {task.title}</a><small>{task.deadline?' · '+moscowTimestamp(task.deadline):''}</small>
  </li>)}</ul></>}
 </aside>;
}
export function deadlineShortcut(days:number){
 const date=new Date(Date.now()+10800000);
 date.setUTCDate(date.getUTCDate()+days);date.setUTCHours(18,0,0,0);
 return date.toISOString().slice(0,16);
}
