import {useRef,useState} from 'react';
import {graphErrors,ports,type GraphAction,type ProcessGraph,type ProcessNode} from '../shared/process-graph.js';
import type {User} from '../shared/types.js';

const labels={start:'Старт',condition:'Условие',task:'Создать задачу',end:'Финиш'};
const output={next:'Далее',yes:'Да',no:'Нет'};
const status={active:'В работе',prospect:'Потенциальный клиент',former:'Бывший клиент'};
const fieldLabels={'company.name':'Название компании','company.status':'Новый статус','company.previousStatus':'Прежний статус','task.title':'Название принятой задачи','task.assigneeId':'Исполнитель принятой задачи'};
type Condition=Extract<ProcessNode,{type:'condition'}>['config'];
export function seedGraph(action:GraphAction,condition:Condition={field:'company.status',operator:'=',value:'active'},branch:'yes'|'no'='yes'):ProcessGraph{
 return {nodes:[
  {id:'start',type:'start',x:16,y:55},{id:'condition',type:'condition',x:218,y:55,config:condition},
  {id:'task',type:'task',x:420,y:20,config:action},{id:'end',type:'end',x:622,y:96}
 ],edges:[{from:'start',to:'condition',sourcePort:'next'},{from:'condition',to:'task',sourcePort:branch},
  {from:'condition',to:'end',sourcePort:branch==='yes'?'no':'yes'},{from:'task',to:'end',sourcePort:'next'}]};
}
export function ProcessGraphEditor({graph,onChange,users,userId,trigger}:{graph:ProcessGraph;onChange:(g:ProcessGraph)=>void;users:User[];userId:string;trigger:string}){
 const [selected,setSelected]=useState<string>('start');
 const [connecting,setConnecting]=useState<{from:string;port:ProcessGraph['edges'][number]['sourcePort']}|null>(null);
 const draggedPort=useRef(false);
 const drag=useRef<{id:string;x:number;y:number;clientX:number;clientY:number}|null>(null);
 const node=graph.nodes.find(n=>n.id===selected)??graph.nodes[0];
 const width=Math.max(820,...graph.nodes.map(n=>n.x+180)),height=Math.max(250,...graph.nodes.map(n=>n.y+125));
 const issues=graphErrors(graph,trigger);
 function patch(next:ProcessNode){onChange({...graph,nodes:graph.nodes.map(item=>item.id===next.id?next:item)});}
 function add(type:'condition'|'task'|'end'){
  const id=crypto.randomUUID(),x=Math.min(2200,(node?.x??20)+180),y=Math.min(1850,Math.max(100,...graph.nodes.filter(n=>n.x===x).map(n=>n.y+90)));
  const next:ProcessNode=type==='condition'?{type,id,x,y,config:{field:'company.status',operator:'=',value:'active'}}:
   type==='task'?{type,id,x,y,config:{title:'Новая задача',assigneeId:userId,price:0,deadlineHours:null}}:{type,id,x,y};
  onChange({...graph,nodes:[...graph.nodes,next]});setSelected(id);
 }
 function connect(from:string,sourcePort:ProcessGraph['edges'][number]['sourcePort'],to:string){
  onChange({...graph,edges:[...graph.edges.filter(e=>e.from!==from||e.sourcePort!==sourcePort),...(to?[{from,to,sourcePort}]:[])]});
 }
 function remove(id:string){
  onChange({nodes:graph.nodes.filter(n=>n.id!==id),edges:graph.edges.filter(e=>e.from!==id&&e.to!==id)});setSelected('start');if(connecting?.from===id)setConnecting(null);
 }
 return <section className="bpm-graph" aria-label="Схема процесса">
  <div className="task-quick-actions">{(['condition','task','end'] as const).map(type=><button type="button" className="button secondary" key={type} disabled={graph.nodes.length>=24} onClick={()=>add(type)}>+ {labels[type]}</button>)}</div>
  {connecting&&<p role="status">Выберите блок для выхода «{output[connecting.port]}». <button type="button" className="text-button" onClick={()=>setConnecting(null)}>Отмена</button></p>}
  <div className="bpm-layout"><div className="bpm-board"><div className="bpm-canvas" style={{width,height}}>
   <svg aria-hidden="true" width={width} height={height}>
    <defs><marker id="ruspet-bpm-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="currentColor"/></marker></defs>
    {graph.edges.map(edge=>{
     const from=graph.nodes.find(n=>n.id===edge.from),to=graph.nodes.find(n=>n.id===edge.to);
     if(!from||!to)return null;
     const sx=from.x+152,sy=from.y+(edge.sourcePort==='no'?52:28),tx=to.x-5,ty=to.y+28,offset=Math.max(32,Math.abs(tx-sx)/2);
     return <g key={edge.from+edge.sourcePort}><path d={`M${sx} ${sy} C${sx+offset} ${sy} ${tx-offset} ${ty} ${tx} ${ty}`} fill="none" stroke="currentColor" markerEnd="url(#ruspet-bpm-arrow)"/>
      <text x={sx+7} y={sy-5} fill="currentColor">{output[edge.sourcePort]}</text></g>;
    })}
   </svg>
   {graph.nodes.map((n,index)=><div className="bpm-node" data-node-id={n.id} key={n.id} data-selected={node?.id===n.id} style={{left:n.x,top:n.y}}>
    <button type="button" className="bpm-node-main" aria-pressed={node?.id===n.id}
     onClick={()=>{if(connecting&&connecting.from!==n.id&&n.type!=='start'){connect(connecting.from,connecting.port,n.id);setConnecting(null);}setSelected(n.id);}} onPointerDown={e=>{
      setSelected(n.id);if(connecting||e.pointerType==='touch')return;
      drag.current={id:n.id,x:n.x,y:n.y,clientX:e.clientX,clientY:e.clientY};e.currentTarget.setPointerCapture(e.pointerId);
     }} onPointerMove={e=>{const d=drag.current;if(d?.id===n.id)patch({...n,x:Math.max(0,Math.min(2400,Math.round(d.x+e.clientX-d.clientX))),y:Math.max(0,Math.min(2000,Math.round(d.y+e.clientY-d.clientY)))});}}
     onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
     <strong>{index+1} · {labels[n.type]}</strong><small>{n.type==='condition'?fieldLabels[n.config.field]:n.type==='task'?n.config.title:''}</small>
    </button>
    <div className="bpm-ports">{ports(n).map(port=><button type="button" key={port} aria-label={labels[n.type]+' · выход '+output[port]} title={output[port]}
     data-active={connecting?.from===n.id&&connecting.port===port} onClick={()=>{if(draggedPort.current){draggedPort.current=false;return;}setSelected(n.id);setConnecting({from:n.id,port});}}
     onPointerDown={e=>{draggedPort.current=false;if(e.pointerType!=='touch')e.currentTarget.setPointerCapture(e.pointerId);}}
     onPointerUp={e=>{
      const id=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
      if(id&&id!==n.id&&graph.nodes.some(item=>item.id===id&&item.type!=='start')){connect(n.id,port,id);draggedPort.current=true;setConnecting(null);e.preventDefault();}
     }} />)}</div>
   </div>)}
  </div></div>
  {node&&<div className="bpm-inspector"><h3>{labels[node.type]}</h3>
   {node.type==='condition'&&<>
    <label>Поле<select value={node.config.field} onChange={e=>patch({...node,config:{...node.config,field:e.target.value as Condition['field'],value:''}})}>
     {Object.entries(fieldLabels).filter(([key])=>trigger==='task_accepted'||!key.startsWith('task.')).map(([key,label])=><option key={key} value={key}>{label}</option>)}
    </select></label>
    <label>Оператор<select value={node.config.operator} onChange={e=>patch({...node,config:{...node.config,operator:e.target.value as Condition['operator']}})}>
     <option value="=">Равно</option><option value="!=">Не равно</option><option value="contains">Содержит</option><option value="exists">Заполнено</option></select></label>
    {node.config.operator!=='exists'&&<label>Значение{node.config.field==='company.status'||node.config.field==='company.previousStatus'?
     <select value={node.config.value} onChange={e=>patch({...node,config:{...node.config,value:e.target.value}})}><option value="">Выберите</option>{Object.entries(status).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>:
     node.config.field==='task.assigneeId'?<select value={node.config.value} onChange={e=>patch({...node,config:{...node.config,value:e.target.value}})}><option value="">Выберите</option>{users.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select>:
     <input value={node.config.value} maxLength={250} onChange={e=>patch({...node,config:{...node.config,value:e.target.value}})}/>}</label>}
   </>}
   {node.type==='task'&&<>
    <label>Название задачи<input value={node.config.title} maxLength={500} onChange={e=>patch({...node,config:{...node.config,title:e.target.value}})}/></label>
    <label>Исполнитель<select value={node.config.assigneeId} onChange={e=>patch({...node,config:{...node.config,assigneeId:e.target.value}})}>{users.map(person=><option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
    <label>Цена · ₽<input type="number" min="0" step=".01" value={node.config.price} onChange={e=>patch({...node,config:{...node.config,price:Number(e.target.value)}})}/></label>
    <label>Срок · часов после запуска<input type="number" min="1" max="8760" value={node.config.deadlineHours??''} onChange={e=>patch({...node,config:{...node.config,deadlineHours:e.target.value?Number(e.target.value):null}})}/></label>
   </>}
   {ports(node).map(port=><label key={port}>Выход «{output[port]}»<select value={graph.edges.find(e=>e.from===node.id&&e.sourcePort===port)?.to??''} onChange={e=>connect(node.id,port,e.target.value)}>
    <option value="">Выберите блок</option>{graph.nodes.filter(n=>n.id!==node.id&&n.type!=='start').map(n=><option key={n.id} value={n.id}>{graph.nodes.indexOf(n)+1} · {n.type==='task'?n.config.title:labels[n.type]}</option>)}
   </select></label>)}
   {node.type!=='start'&&<button type="button" className="text-button red-text" onClick={()=>remove(node.id)}>Удалить блок</button>}
  </div>}</div>
  {!!issues.length&&<p className="muted">Перед публикацией · {issues.join(' ')}</p>}
 </section>;
}
