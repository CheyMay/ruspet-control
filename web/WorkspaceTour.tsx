import {useLayoutEffect,useRef,useState} from 'react';
import type {User} from '../shared/types.js';
import './workspace-tour.css';

type TourPage='overview'|'actions'|'tasks'|'approvals'|'bot'|'reports'|'people'|'settings'|'journal';
type TourStep={page:TourPage;anchor:string;title:string;text:string};

const workday:TourStep={page:'overview',anchor:'workday',title:'Рабочий день',text:'На главной видно, где нужен ответ или решение и какие задачи пора завершить. Нажмите на показатель, чтобы открыть список.'};
const tasks:TourStep={page:'tasks',anchor:'task-filters',title:'Найдите задачу',text:'Ищите по номеру или названию. В карточке есть обсуждение и история. Оттуда можно предложить новый срок или сдать результат.'};
const approvals:TourStep={page:'approvals',anchor:'approval-tabs',title:'У кого сейчас запрос',text:'Откройте запрос, чтобы увидеть маршрут и текущего согласующего. Если у автора попросили уточнение, ответ появится в этом же запросе.'};
const journal:TourStep={page:'journal',anchor:'page-heading',title:'Проверьте историю',text:'В журнале видно, кто и когда действовал. Найдите задачу по номеру, чтобы проследить решения, переносы и возвраты.'};

export function tourSteps(role:User['role']):TourStep[]{
 if(role==='employee')return [
  workday,
  {page:'actions',anchor:'page-heading',title:'Что ждёт вашего ответа',text:'Здесь собраны уточнения, замечания и запросы, на которые нужно ответить. Откройте задачу прямо из списка.'},
  tasks,approvals,
  {page:'bot',anchor:'page-heading',title:'Рабочий бот',text:'Здесь можно попробовать рабочие действия бота. В привязанном личном чате Telegram доступны те же задачи и права.'},
 ];
 if(role==='admin')return [
  workday,
  {page:'settings',anchor:'access-heading',title:'Доступы сотрудников',text:'Найдите сотрудника и проверьте его роль и вход. «Открыть как сотрудник» покажет его панель в режиме просмотра.'},
  approvals,journal,
  {page:'settings',anchor:'system-status',title:'Состояние системы',text:'Здесь видно, работает ли Telegram, когда сформировались автоматические отчёты и когда создали резервную копию.'},
 ];
 return [
  workday,approvals,
  {page:'tasks',anchor:'task-filters',title:'Приёмка результатов',text:'В «Задачах» откройте вкладку «На приёмке». Можно принять результат или вернуть задачу исполнителю с замечанием.'},
  {page:'people',anchor:'page-heading',title:'Нагрузка сотрудников',text:'Посмотрите задачи, просрочки и возвраты по сотрудникам, которые входят в вашу область доступа.'},
  {page:'reports',anchor:'page-heading',title:'Отчёты',text:'Выберите период и исполнителя. Из показателей можно перейти к списку задач, а сохранённый отчёт открыть в PDF.'},
 ];
}

export const tourKey=(user:User)=>`ruspet.workspace-tour.v1.${user.id}.${user.role}`;
export function tourSeen(key:string){
 try{return localStorage.getItem(key)==='seen';}catch{return false;}
}
export function markTourSeen(key:string){
 try{localStorage.setItem(key,'seen');}catch{/* Storage can be disabled in the browser. */}
}

type Box={left:number;top:number;width:number;height:number};
type Layout={target:Box;panel:{left:number;top:number}};
const clamp=(n:number,minimum:number,maximum:number)=>Math.max(minimum,Math.min(n,maximum));

export function WorkspaceTour({steps,index,change,close}:{steps:TourStep[];index:number;change:(index:number)=>void;close:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),card=useRef<HTMLElement>(null),title=useRef<HTMLHeadingElement>(null);
 const [layout,setLayout]=useState<Layout|null>(null);
 const step=steps[index];
 const last=index===steps.length-1;

 useLayoutEffect(()=>{
  const element=dialog.current!;
  const focus=document.activeElement;
  element.showModal();
  return ()=>{
   element.close();
   if(focus instanceof HTMLElement&&focus.isConnected)focus.focus({preventScroll:true});
  };
 },[]);

 useLayoutEffect(()=>{
  const target=document.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`)??document.querySelector<HTMLElement>('[data-tour="page-heading"]');
  const panel=card.current!;
  target?.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  title.current?.focus({preventScroll:true});
  const measure=()=>{
   const rect=target?.getBoundingClientRect();
   const width=document.documentElement.clientWidth,height=document.documentElement.clientHeight;
   if(!rect||!rect.width||!rect.height||rect.bottom<=0||rect.top>=height){setLayout(null);return;}
   const left=Math.max(4,rect.left-6),top=Math.max(4,rect.top-6);
   const right=Math.min(width-4,rect.right+6),bottom=Math.min(height-4,rect.bottom+6);
   const targetBox={left,top,width:right-left,height:bottom-top};
   const size=panel.getBoundingClientRect(),gap=14;
   const below=bottom+gap,above=top-size.height-gap;
   const panelTop=below+size.height<=height-12?below:above>=12?above:height-size.height-12;
   setLayout({target:targetBox,panel:{left:clamp(left,12,width-size.width-12),top:Math.max(12,panelTop)}});
  };
  measure();
  const observer=new ResizeObserver(measure);
  observer.observe(panel);
  if(target)observer.observe(target);
  window.addEventListener('resize',measure);
  window.addEventListener('scroll',measure,true);
  return ()=>{
   observer.disconnect();
   window.removeEventListener('resize',measure);
   window.removeEventListener('scroll',measure,true);
  };
 },[step.anchor,step.page]);

 return <dialog ref={dialog} className="workspace-tour" aria-labelledby="tour-title" aria-describedby="tour-description" onCancel={e=>{e.preventDefault();close();}}>
  {layout?<div aria-hidden="true" className="workspace-tour-highlight" style={layout.target}/>:<div aria-hidden="true" className="workspace-tour-shade"/>}
  <section ref={card} className="workspace-tour-card" style={layout?.panel} data-positioned={layout?'true':undefined}>
   <p className="workspace-tour-step">Шаг {index+1} из {steps.length}</p>
   <h2 id="tour-title" tabIndex={-1} ref={title}>{step.title}</h2>
   <p id="tour-description">{step.text}</p>
   <div className="workspace-tour-actions">
    {!last&&<button className="text-button" onClick={close}>Пропустить</button>}
    <div>
     {index>0&&<button className="button secondary" onClick={()=>change(index-1)}>Назад</button>}
     <button className="button primary" onClick={last?close:()=>change(index+1)}>{last?'Готово':'Далее'}</button>
    </div>
   </div>
  </section>
 </dialog>;
}
