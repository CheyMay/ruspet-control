// Draw Run graph conventions: stable node IDs and one edge per named output port.
import {chooseBranch} from './draw-run-rules.js';

export const fields=['company.name','company.status','company.previousStatus','task.title','task.assigneeId'] as const;
export const operators=['=','!=','contains','exists'] as const;
type Point={id:string;x:number;y:number};
export type GraphAction={title:string;assigneeId:string;price:number;deadlineHours:number|null};
export type ProcessNode=Point&(
 {type:'start'}|{type:'end'}|
 {type:'condition';config:{field:typeof fields[number];operator:typeof operators[number];value:string}}|
 {type:'task';config:GraphAction}
);
export type ProcessGraph={nodes:ProcessNode[];edges:{from:string;to:string;sourcePort:'next'|'yes'|'no'}[]};
export type Trace={nodeId:string;label:string;branch?:'yes'|'no'};

export function ports(node:ProcessNode):ProcessGraph['edges'][number]['sourcePort'][]{
 return node.type==='end'?[]:node.type==='condition'?['yes','no']:['next'];
}
export function graphErrors(graph:ProcessGraph,trigger:string){
 const errors:string[]=[],map=new Map(graph.nodes.map(node=>[node.id,node]));
 const starts=graph.nodes.filter(node=>node.type==='start');
 if(starts.length!==1)errors.push('Добавьте ровно один старт.');
 if(map.size!==graph.nodes.length)errors.push('Идентификаторы блоков должны различаться.');
 const outgoing=new Set<string>();
 for(const edge of graph.edges){
  const from=map.get(edge.from),to=map.get(edge.to);
  if(!from||!to||to.type==='start'||!ports(from).includes(edge.sourcePort)){errors.push('Есть недопустимая связь между блоками.');continue;}
  const key=edge.from+':'+edge.sourcePort;
  if(outgoing.has(key))errors.push('У каждого выхода может быть только одна связь.');
  outgoing.add(key);
 }
 const seen=new Set<string>(),visiting=new Set<string>();
 function walk(id:string){
  if(visiting.has(id)){errors.push('Схема содержит цикл.');return;}
  if(seen.has(id))return;
  seen.add(id);visiting.add(id);
  for(const edge of graph.edges.filter(edge=>edge.from===id))walk(edge.to);
  visiting.delete(id);
 }
 if(starts[0])walk(starts[0].id);
 for(const node of graph.nodes){
  if(!seen.has(node.id))errors.push('Есть блоки, недоступные из старта.');
  if(ports(node).some(port=>!outgoing.has(node.id+':'+port)))errors.push('Соедините каждый выход с другим блоком или финишем.');
  if(node.type==='condition'){
   if(node.config.operator!=='exists'&&!node.config.value)errors.push('Заполните значение условия.');
   if(trigger!=='task_accepted'&&node.config.field.startsWith('task.'))errors.push('Поля задачи доступны для события приёмки.');
  }
 }
 return [...new Set(errors)];
}
export function runGraph(graph:ProcessGraph,context:Record<string,unknown>){
 const actions:GraphAction[]=[],trace:Trace[]=[],seen=new Set<string>();
 let current:ProcessNode|undefined=graph.nodes.find(node=>node.type==='start');
 let branch:'yes'|'no'='yes';
 while(current&&!seen.has(current.id)){
  seen.add(current.id);
  let port:'next'|'yes'|'no'='next';
  if(current.type==='condition'){
   port=chooseBranch(current.config,context);
   if(!trace.some(step=>step.branch))branch=port;
   trace.push({nodeId:current.id,label:current.config.field+' '+current.config.operator+' '+current.config.value,branch:port});
  }else{
   if(current.type==='task')actions.push(current.config);
   trace.push({nodeId:current.id,label:current.type==='task'?current.config.title:current.type==='start'?'Старт':'Финиш'});
  }
  const edge=graph.edges.find(edge=>edge.from===current?.id&&edge.sourcePort===port);
  current=graph.nodes.find(node=>node.id===edge?.to);
 }
 return {branch,actions,trace};
}
