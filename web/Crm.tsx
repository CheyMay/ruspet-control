import {useEffect,useState} from 'react';
import {api} from './api.js';

type RegistryCompany={name:string;taxId:string;kpp:string|null;ogrn:string|null;legalAddress:string|null;registryStatus:string|null;branch:boolean;existingId:string|null};
export function RegistryLookup({apply,open,currentId}:{apply:(row:RegistryCompany)=>void;open:(id:string)=>void;currentId?:string}){
 const [enabled,setEnabled]=useState<boolean|null>(null),[query,setQuery]=useState(''),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[rows,setRows]=useState<RegistryCompany[]|null>(null);
 useEffect(()=>{let active=true;void api<{enabled:boolean}>('/okb/registry').then(value=>{if(active)setEnabled(value.enabled);}).catch(()=>{});return()=>{active=false;};},[]);
 async function find(){
  if(query.trim().length<3||busy)return;
  setBusy(true);setError('');setRows(null);
  try{setRows(await api<RegistryCompany[]>('/okb/registry/search','POST',{query}));}
  catch(error){setError((error as Error).message);}finally{setBusy(false);}
 }
 if(!enabled)return enabled===false?<p className="muted">DaData пока не настроена. Реквизиты можно ввести вручную.</p>:null;
 return <fieldset className="crm-fieldset"><legend>Найти реквизиты через DaData</legend>
  <div className="task-quick-actions"><input aria-label="Название или ИНН для DaData" placeholder="Название, ИНН или ОГРН" value={query} maxLength={250}
   onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void find();}}}/>
   <button type="button" className="button secondary" disabled={busy||query.trim().length<3} onClick={()=>void find()}>{busy?'Ищем…':'Найти'}</button></div>
  {error&&<p role="alert" className="alert error">{error}</p>}
  {rows?.length===0&&<p className="muted">Совпадений нет. Попробуйте поиск по ИНН.</p>}
  {rows?.map((row,i)=><button type="button" className="crm-registry-match" key={row.taxId+':'+row.kpp+':'+i}
   onClick={()=>{if(row.existingId&&row.existingId!==currentId)open(row.existingId);else apply(row);setRows(null);}}>
   <strong>{row.name}</strong><small>{row.taxId}{row.kpp?' / '+row.kpp:''} · {row.existingId&&row.existingId!==currentId?'Открыть карточку':row.branch?'Филиал':'Заполнить реквизиты'}</small>
   {row.legalAddress&&<small>{row.legalAddress}</small>}
  </button>)}
 </fieldset>;
}

type Contact={id:string;name:string;position:string;phone:string;email:string;notes:string};
const contactEmpty={id:'',name:'',position:'',phone:'',email:'',notes:''};
export function CompanyPeople({id}:{id:string}){
 const path='/okb/companies/'+id+'/people';
 const [rows,setRows]=useState<Contact[]|null>(null),[draft,setDraft]=useState<Contact|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let current=true;
  void api<Contact[]>(path).then(value=>{if(current)setRows(value);}).catch(e=>{if(current)setError(e.message);});
  return()=>{current=false;};
 },[path]);
 return <section className="crm-contacts">
  <div className="panel-heading"><h3>Контактные лица</h3>{!draft&&<button type="button" className="button secondary" onClick={()=>setDraft(contactEmpty)}>Добавить контакт</button>}</div>
  {error&&<p role="alert" className="alert error">{error}</p>}
  {rows?.length===0&&<p className="muted">Добавьте закупщика, технолога или другого представителя клиента.</p>}
  {rows?.map(person=><article className="client-note" key={person.id}>
   <strong>{person.name}{person.position?' · '+person.position:''}</strong>
   {(person.phone||person.email)&&<p>{[person.phone,person.email].filter(Boolean).join(' · ')}</p>}
   {person.notes&&<p>{person.notes}</p>}
   <button type="button" className="text-button" onClick={()=>setDraft(person)}>Изменить</button>
  </article>)}
  {draft&&<form className="work-design-form" onSubmit={async e=>{
   e.preventDefault();setBusy(true);setError('');
   try{
    const next=await api<Contact>(path+(draft.id?'/'+draft.id:''),draft.id?'PUT':'POST',draft);
    setRows(current=>[...(current??[]).filter(person=>person.id!==next.id),next].sort((a,b)=>a.name.localeCompare(b.name,'ru')));
    setDraft(null);
   }catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }}>
   {(['name','position','phone','email'] as const).map((key,index)=><label key={key}>{['Имя и фамилия','Роль у клиента','Телефон','Почта'][index]}
    <input required={key==='name'} minLength={key==='name'?2:undefined} maxLength={[180,100,80,254][index]} value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}
   <label>Примечание<textarea rows={2} maxLength={2000} value={draft.notes} onChange={e=>setDraft({...draft,notes:e.target.value})}/></label>
   <div className="drawer-actions"><button className="button primary" disabled={busy}>Сохранить контакт</button>
    <button type="button" className="button secondary" disabled={busy} onClick={()=>setDraft(null)}>Отмена</button>
    {draft.id&&<button type="button" className="text-button" disabled={busy} onClick={async()=>{
     if(!window.confirm('Убрать контакт из карточки клиента?'))return;
     setBusy(true);setError('');
     try{await api(path+'/'+draft.id,'DELETE');setRows(current=>current?.filter(person=>person.id!==draft.id)??[]);setDraft(null);}
     catch(error){setError((error as Error).message);}finally{setBusy(false);}
    }}>В архив</button>}
   </div>
  </form>}
 </section>;
}

const categories={preform:'Преформы',cap:'Крышки',other:'Другое'} as const;
type Product={id:string;sku:string;name:string;specs:string;category:keyof typeof categories;active:boolean;version?:number};
const blankProduct:Product={id:'',sku:'',name:'',specs:'',category:'preform',active:true};
export function ProductCatalog({manage}:{manage:boolean}){
 const [rows,setRows]=useState<Product[]|null>(null),[draft,setDraft]=useState<Product|null>(null);
 const [query,setQuery]=useState(''),[withArchived,setWithArchived]=useState(false),[reload,setReload]=useState(0);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{
  let current=true;
  const timer=setTimeout(()=>void api<Product[]>('/catalog?q='+encodeURIComponent(query)+(withArchived?'&archived=1':''))
   .then(rows=>{if(current){setRows(rows);setError('');}}).catch(error=>{if(current)setError(error.message);}),200);
  return()=>{current=false;clearTimeout(timer);};
 },[query,withArchived,reload]);
 return <section className="panel automation-settings">
  <div className="panel-heading"><div><h2>Каталог продукции</h2><p>Преформы, крышки и другие позиции РУСПЭТ</p></div>
   {manage&&<button type="button" className="button primary" onClick={()=>setDraft(blankProduct)}>Добавить позицию</button>}</div>
  <div className="filters"><input aria-label="Поиск по каталогу" placeholder="Артикул, название или характеристики" value={query} onChange={e=>setQuery(e.target.value)}/>
   {manage&&<label><input type="checkbox" checked={withArchived} onChange={e=>setWithArchived(e.target.checked)}/> Включая архивные</label>}</div>
  {error&&<p role="alert" className="alert error">{error}</p>}
  {rows?.length===0&&<p className="muted">{query?'По вашему запросу позиции не найдены.':'Каталог пока пуст.'}</p>}
  {!!rows?.length&&<div className="table-scroll"><table><thead><tr><th>Артикул</th><th>Позиция</th><th>Категория</th><th>Характеристики</th>{manage&&<th aria-label="Действия"/>}</tr></thead>
   <tbody>{rows.map(item=><tr key={item.id}><td>{item.sku}</td><td>{item.name}{!item.active&&<small>В архиве</small>}</td>
    <td>{categories[item.category]}</td><td>{item.specs||'—'}</td>{manage&&<td><button type="button" className="text-button" onClick={()=>setDraft(item)}>Изменить</button></td>}</tr>)}</tbody>
  </table></div>}
  {draft&&<div className="modal-backdrop"><form className="modal task-editor work-design-form" role="dialog" aria-modal="true" aria-label="Позиция каталога"
   onSubmit={async e=>{
    e.preventDefault();setBusy(true);setError('');
    try{await api('/catalog'+(draft.id?'/'+draft.id:''),draft.id?'PUT':'POST',draft);setDraft(null);setReload(n=>n+1);}
    catch(error){setError((error as Error).message);}finally{setBusy(false);}
   }}>
   <h2>{draft.id?'Позиция каталога':'Новая позиция'}</h2>
   <label>Артикул<input required maxLength={100} value={draft.sku} onChange={e=>setDraft({...draft,sku:e.target.value})}/></label>
   <label>Название<input required minLength={2} maxLength={250} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
   <label>Категория<select value={draft.category} onChange={e=>setDraft({...draft,category:e.target.value as Product['category']})}>
    {Object.entries(categories).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></label>
   <label>Характеристики<textarea rows={3} maxLength={3000} value={draft.specs} onChange={e=>setDraft({...draft,specs:e.target.value})}/></label>
   {draft.id&&<label className="toggle-row">Позиция доступна<input type="checkbox" checked={draft.active} onChange={e=>setDraft({...draft,active:e.target.checked})}/></label>}
   {error&&<p role="alert" className="alert error">{error}</p>}
   <div className="drawer-actions"><button className="button primary" disabled={busy}>Сохранить</button>
    <button type="button" className="button secondary" disabled={busy} onClick={()=>{setDraft(null);setError('');}}>Закрыть</button></div>
  </form></div>}
 </section>;
}

export function ClientPortfolio(){
 type Portfolio={total:number;active:number;prospects:number;contacted:number;quiet:number};
 const [data,setData]=useState<Portfolio|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  let current=true;
  const load=()=>void api<Portfolio>('/analytics/clients').then(value=>{if(current){setData(value);setError('');}}).catch(e=>{if(current)setError(e.message);});
  load();const timer=setInterval(()=>{if(document.visibilityState==='visible')load();},60000);
  return()=>{current=false;clearInterval(timer);};
 },[]);
 return <section className="panel crm-portfolio">
  <h2>Клиентская база</h2><p className="muted">Контакты с действующими клиентами за последние 30 дней.</p>
  {error&&<p role="alert">{error}</p>}
  {data&&<dl>{Object.entries({total:'Всего компаний',active:'В работе',prospects:'Потенциальные',contacted:'Был контакт',quiet:'Контакт не отмечен'}).map(([key,label])=><div key={key}>
   <dt>{label}</dt><dd>{data[key as keyof Portfolio]}</dd>
  </div>)}</dl>}
 </section>;
}
