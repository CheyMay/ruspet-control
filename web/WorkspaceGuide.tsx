import {lazy,Suspense,useLayoutEffect,useRef,useState,type ComponentProps} from 'react';
import {ArrowRight,X} from 'lucide-react';
import type {WorkspacePage} from '../shared/workspace-access.js';
import type {User} from '../shared/types.js';

const GuideBook=lazy(()=>import('./WorkspaceGuideBook.js').then(module=>({default:module.WorkspaceGuide})));
export function WorkspaceGuide(props:ComponentProps<typeof GuideBook>){
 return <Suspense fallback={<p className="panel section-loading" role="status">Открываем гайд…</p>}><GuideBook {...props}/></Suspense>;
}

export type TourStep<Screen extends string=WorkspacePage>={page:Screen;anchor:string;name:string;text:string;fallback?:string;card?:boolean;settings?:string};
const desktopSteps:TourStep[]=[
 {page:'overview',anchor:'.personal-metrics',name:'Начните со своего дня',text:'«Просрочено» показывает истёкшие сроки, «На сегодня» — срок ещё впереди. Через «Ответы и решения» можно сразу перейти к запросам, где ход за вами.'},
 {page:'tasks',anchor:'.task-scope-switches',name:'Выберите, чьи задачи смотреть',text:'«Мои задачи» — вы исполнитель. «Я постановщик» — вы выдали задачу и ждёте результат. Если руководите командой, здесь же будет её выборка.'},
 {page:'tasks',anchor:'.task-panel .filters',fallback:'.task-scope-switches',name:'Найдите нужную задачу',text:'Вводите название, номер или имя. Выборку можно сузить по крайнему сроку, филиалу и цене, а в командной области — отметить нескольких исполнителей.'},
 {page:'tasks',anchor:'.task-card [role="tablist"]',name:'Разберитесь в карточке задачи',text:'На вкладках можно прочитать обсуждение, посмотреть результат или узнать, у кого согласование. В «Обзоре» лежат крайний срок и личный план, если он доступен.',card:true},
 {page:'calendar',anchor:'.calendar-title',name:'Запланируйте своё время',text:'В календаре видны задачи по личному плану. Меняйте план в карточке задачи. Чтобы изменить крайний срок, оформите перенос.'},
 {page:'approvals',anchor:'.approval-kind-tabs',name:'Проверьте, у кого решение',text:'В «Моих запросах» видно этап согласования. Через «От меня ждут решения» откройте свой список. Переносы и закрытие вынесены в разные вкладки.'},
 {page:'analytics',anchor:'[aria-label="Период аналитики"]',name:'Посмотрите, как идёт работа',text:'Переключайте «Сегодня» и «Неделя». Сравните оставшуюся работу, ближайшие сроки и выполненное в доступной вам области.'},
 {page:'reports',anchor:'.report-presets',name:'Соберите отчёт',text:'Выберите область и вид отчёта. Сохранённые отчёты доступны в архиве, откуда их можно скачать.'},
 {page:'bot',anchor:'[aria-label="Рабочий бот"] .bot-compose',name:'Работайте через бота',text:'Можно искать задачу по номеру, добавлять комментарий, предложить новый срок или сдать результат. Если доступен микрофон, продиктуйте действие и проверьте предложение бота.'},
 {page:'notifications',anchor:'.notification-button',name:'Возвращайтесь из уведомлений',text:'Здесь появляются новые задачи, ответы и решения. Откройте уведомление, чтобы перейти к связанной записи.'},
 {page:'settings',anchor:'.settings-tabs',name:'Проверьте доступ сотрудника',text:'В «Сотрудниках и правах» проверяйте роль и подключение. Новые запросы находятся в «Заявках и подключении».',settings:'staff'}
];
export function desktopTour(user:User,enabled:(page:WorkspacePage)=>boolean,hasTask:boolean,preview:boolean){
 return desktopSteps.filter(step=>enabled(step.page)&&(!step.card||hasTask)&&(!step.settings||user.role==='admin')&&
  (step.page!=='calendar'||!user.root_access)&&(!preview||step.page!=='reports'));
}

type MobileScreen='bot'|'calendar'|'notifications';
const phoneSteps:TourStep<MobileScreen>[]=[
 {page:'bot',anchor:'.mobile-bot-nav',name:'Задачи и сроки под рукой',text:'«Задачи» открывают ваши рабочие списки. Через «Поиск» найдите задачу, а через «Сроки» — просрочки и то, что нужно сделать сегодня.'},
 {page:'bot',anchor:'.bot-compose',name:'Ответьте боту',text:'Введите номер задачи или ответ на запрос. Если на нижней панели есть микрофон, можно продиктовать действие. Перед отправкой проверьте задачу и текст.'},
 {page:'calendar',anchor:'.calendar-title',name:'Сверьте личный план',text:'Выберите дату, чтобы увидеть запланированные задачи. День и время меняются в карточке. Крайний срок указан отдельно.'},
 {page:'notifications',anchor:'.mobile-device-notifications summary',name:'Включите уведомления на телефоне',text:'Разверните этот блок после тура, чтобы настроить push-уведомления или установить приложение, если телефон поддерживает эти возможности.'}
];
export const mobileTour=(user:User)=>phoneSteps.filter(step=>step.page!=='calendar'||!user.root_access);

type Spotlight={left:number;top:number;width:number;height:number};
export function WorkspaceTour<Screen extends string>({steps,index,change,end}:{steps:TourStep<Screen>[];index:number;change:(index:number)=>void;end:()=>void}){
 const frame=useRef<HTMLDialogElement>(null),card=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null);
 const [placement,setPlacement]=useState<{anchor:string;highlight:Spotlight;above:boolean}|null>(null);
 const step=steps[index];
 const active=placement?.anchor===step.anchor?placement:null;
 useLayoutEffect(()=>{
  const dialog=frame.current;
  dialog?.showModal();
  return()=>{dialog?.close();};
 },[]);
 useLayoutEffect(()=>{
  let timer:number|undefined, animation:number|undefined, observed:HTMLElement|null=null;
  let attempts=0;
  const observer=new ResizeObserver(()=> schedule());
  function measure(){
   const element=document.querySelector<HTMLElement>(step.anchor)??(step.fallback?document.querySelector<HTMLElement>(step.fallback):null);
   if(!element||!element.getClientRects().length){
    setPlacement(null);
    if(attempts++<30)timer=window.setTimeout(measure,120);
    return;
   }
   if(element!==observed){
    if(observed)observer.unobserve(observed);
    observed=element;observer.observe(element);
    const rect=element.getBoundingClientRect();
    if(rect.top<76||rect.bottom>window.innerHeight-100)element.scrollIntoView({block:rect.height>window.innerHeight*.48?'start':'center',behavior:'instant'});
   }
   const rect=element.getBoundingClientRect(),width=window.innerWidth,height=window.innerHeight;
   const left=Math.max(4,rect.left-5),top=Math.max(4,rect.top-5);
   const right=Math.min(width-4,rect.right+5),bottom=Math.min(height-4,rect.bottom+5,top+height*.54);
   if(right<=left||bottom<=top){setPlacement(null);return;}
   const panelHeight=card.current?.offsetHeight??180;
   const above=height-bottom<panelHeight+24&&top>height-bottom;
   setPlacement({anchor:step.anchor,highlight:{left,top,width:right-left,height:bottom-top},above});
  }
  function schedule(){clearTimeout(timer);if(animation!==undefined)cancelAnimationFrame(animation);animation=requestAnimationFrame(measure);}
  heading.current?.focus({preventScroll:true});
  if(card.current)observer.observe(card.current);
  window.addEventListener('resize',schedule);
  window.addEventListener('scroll',schedule,true);
  schedule();
  return()=>{clearTimeout(timer);if(animation!==undefined)cancelAnimationFrame(animation);observer.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);};
 },[step]);
 return <dialog className={'workspace-tour'+(active?.above?' tour-above':'')} ref={frame} aria-labelledby="workspace-tour-title" onCancel={event=>{event.preventDefault();end();}}>
  {active?<div className="tour-spotlight" aria-hidden="true" style={active.highlight}/>:<div className="tour-backdrop" aria-hidden="true"/>}
  <div className="tour-caption" ref={card}>
   <div className="tour-top"><div>Тур · {index+1} из {steps.length}</div><button type="button" className="icon-button" aria-label="Закрыть тур" onClick={end}><X size={18}/></button></div>
   <h2 tabIndex={-1} ref={heading} id="workspace-tour-title">{step.name}</h2><p>{step.text}</p>
   <div className="tour-actions"><button className="button secondary" type="button" onClick={()=>change(index-1)} disabled={index===0}>Назад</button>
    <button className="button primary" type="button" onClick={()=>index+1<steps.length?change(index+1):end()}>{index+1===steps.length?'Завершить':'Далее'} <ArrowRight size={16}/></button></div>
  </div>
 </dialog>;
}
