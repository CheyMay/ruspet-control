import {filterOps,metrics,numericOps,operatorsFor,taskFilters,type MetricConfig,type TaskFilter} from '../shared/process-metrics.js';
import type {User} from '../shared/types.js';

export function MetricInspector({config,users,change}:{config:MetricConfig;users:User[];change:(value:MetricConfig)=>void}){
 function patch(index:number,filter:TaskFilter){
  change({...config,filters:config.filters.map((current,i)=>i===index?filter:current)});
 }
 return <>
  <label>Что считать<select value={config.metric} onChange={e=>change({...config,metric:e.target.value as MetricConfig['metric']})}>
   {Object.entries(metrics).map(([id,label])=><option value={id} key={id}>{label}</option>)}
  </select></label>
  <div className="editor-grid"><label>Сравнение<select value={config.operator} onChange={e=>change({...config,operator:e.target.value as MetricConfig['operator']})}>
   {Object.entries(numericOps).map(([id,label])=><option value={id} key={id}>{label}</option>)}
  </select></label><label>Порог<input type="number" step="any" value={config.threshold} onChange={e=>change({...config,threshold:Number(e.target.value)})}/></label></div>
  <p className="muted">В выборку входят задачи, которые одновременно подходят под все фильтры.</p>
  {config.filters.map((filter,i)=>{
   const descriptor=taskFilters[filter.field];
   return <fieldset key={i} className="metric-filter"><legend>Фильтр {i+1}</legend>
    <label>Поле<select value={filter.field} onChange={e=>{
     const field=e.target.value as TaskFilter['field'],entry=taskFilters[field];
     patch(i,{field,operator:'=',value:entry.kind==='choice'?Object.keys(entry.options)[0]:entry.kind==='person'?users[0]?.id??'':''});
    }}>{Object.entries(taskFilters).map(([id,item])=><option value={id} key={id}>{item.label}</option>)}</select></label>
    {filter.field==='custom'&&<label>Название доп. поля<input maxLength={80} value={filter.label??''} onChange={e=>patch(i,{...filter,label:e.target.value})}/></label>}
    <label>Оператор<select value={filter.operator} onChange={e=>patch(i,{...filter,operator:e.target.value as TaskFilter['operator']})}>
     {operatorsFor(filter.field).map(op=><option key={op} value={op}>{filterOps[op]}</option>)}
    </select></label>
    {filter.operator!=='exists'&&<label>Значение{descriptor.kind==='choice'||descriptor.kind==='person'?
     <select value={filter.value} onChange={e=>patch(i,{...filter,value:e.target.value})}>
      <option value="">Выберите</option>{(descriptor.kind==='choice'?Object.entries(descriptor.options):users.map(user=>[user.id,user.name])).map(([id,label])=><option key={id} value={id}>{label}</option>)}
     </select>:<input type={descriptor.kind==='number'?'number':'text'} step="any" maxLength={250} value={filter.value} onChange={e=>patch(i,{...filter,value:e.target.value})}/>}</label>}
    <button className="text-button" type="button" onClick={()=>change({...config,filters:config.filters.filter((_,index)=>index!==i)})}>Удалить фильтр</button>
   </fieldset>;
  })}
  <button className="button secondary" type="button" disabled={config.filters.length>=12} onClick={()=>change({...config,filters:[...config.filters,{field:'status',operator:'=',value:'active'}]})}>Добавить фильтр</button>
 </>;
}
