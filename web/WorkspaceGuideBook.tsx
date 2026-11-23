import {useState} from 'react';
import {ArrowDown,ArrowRight,BookOpen,Play} from 'lucide-react';
import handbook from '../shared/workspace-guide.json';
import type {WorkspacePage} from '../shared/workspace-access.js';
import type {User} from '../shared/types.js';
import {tracks,trainingSteps,type TrainingTrack,type TourStep} from './WorkspaceTraining.js';

const pages:Record<string,WorkspacePage>={
 home:'actions',tasks:'tasks',planning:'calendar',posting:'tasks',approvals:'approvals',bot:'bot',
 analytics:'analytics',reports:'reports',team:'people',directory:'org',okb:'okb',processes:'processes',admin:'settings',owner:'settings'
};
const modules=new Map(handbook.modules.map(section=>[section.id,section]));

export function WorkspaceGuide({user,enabled,launch,open,mobile=false,preview=false,salesOverview=false}:{user:User;enabled:(page:WorkspacePage)=>boolean;
 launch:(steps:TourStep[])=>void;open?:(page:WorkspacePage,moduleId:string)=>void;mobile?:boolean;preview?:boolean;salesOverview?:boolean}){
 const [track,setTrack]=useState<TrainingTrack>(()=>user.role==='admin'?'director':user.role==='employee'&&salesOverview?'sales_head':user.role);
 const role=handbook.roles.find(item=>item.id===track)??handbook.roles[0];
 const poster=handbook.roles.find(item=>item.id==='poster')!;
 const show=(id:string)=>!['admin','owner'].includes(id)&&enabled(pages[id])&&
   (id!=='planning'||!user.root_access);
 const [section,setSection]=useState<string>();
 const trackOptions=(user.role==='admin'?Object.keys(tracks):user.role==='employee'&&salesOverview?['sales_head','employee']:[track]) as TrainingTrack[];
 const steps=trainingSteps(track,mobile,enabled,preview).filter(step=>(user.role!=='employee'||step.scope!=='team')&&
  (!user.root_access||step.page!=='calendar'));
 function jump(id:string){setSection(id);requestAnimationFrame(()=>document.getElementById('guide-'+id)?.scrollIntoView({block:'start'}));}
 return <div className="guide-workspace">
  <section className="panel guide-intro"><BookOpen size={24} aria-hidden="true"/><div>
   <h1>Обучение РУСПЭТ</h1>
   {trackOptions.length>1&&<label className="guide-track-label">Рабочий сценарий<select value={track} onChange={event=>setTrack(event.target.value as TrainingTrack)}>
    {trackOptions.map(id=><option key={id} value={id}>{tracks[id].title}</option>)}
   </select></label>}
   {trackOptions.length===1&&<h2>{tracks[track].title}</h2>}
   <p>{tracks[track].summary} Ответы в примерах не меняют задачи.</p>
   <div className="guide-intro-actions"><button type="button" className="button primary" disabled={!steps.length} onClick={()=>launch(steps)}><Play size={16}/> Начать обучение</button>
    {mobile&&<a className="text-button" href="/?view=guide">Гайд по полной версии <ArrowRight size={15}/></a>}
   </div>
  </div></section>
  <section className="panel guide-card"><h2>Памятка · {role.title.toLowerCase()}</h2>
   <dl className="guide-steps">{steps.map(step=><div key={step.id}><dt>{step.title}</dt><dd>{step.action}</dd></div>)}</dl>
   <details className="guide-topic"><summary>{poster.title}</summary>
    <dl className="guide-steps">{poster.steps.map(item=><div key={item.name}><dt>{item.name}</dt><dd>{item.text}</dd></div>)}</dl>
   </details>
  </section>
  <nav className="panel guide-card guide-index" aria-label="Разделы гайда"><h2>Инструкции по разделам</h2>
   {handbook.chapters.map(chapter=>{const items=chapter.modules.filter(show);return items.length>0&&<div key={chapter.title}>
    <h3>{chapter.title}</h3>{items.map(id=><button key={id} type="button" className="text-button" onClick={()=>jump(id)}>{modules.get(id)?.title}<ArrowDown size={14}/></button>)}
   </div>;})}
  </nav>
  {handbook.modules.filter(item=>show(item.id)).map(item=><details key={item.id} id={'guide-'+item.id} className="panel guide-card guide-topic"
   open={section===item.id} onToggle={event=>{if(event.currentTarget.open)setSection(item.id);else setSection(current=>current===item.id?undefined:current);}}>
   <summary>{item.title}</summary><p>{item.lead}</p>
   <dl className="guide-steps">{item.steps.map(step=><div key={step.name}><dt>{step.name}</dt><dd>{step.text}</dd></div>)}</dl>
   {open&&<button type="button" className="button secondary" onClick={()=>open(pages[item.id],item.id)}>Открыть раздел <ArrowRight size={15}/></button>}
  </details>)}
 </div>;
}
