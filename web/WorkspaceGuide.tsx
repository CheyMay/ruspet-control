import {lazy,Suspense,useLayoutEffect,useRef,useState,type ComponentProps} from 'react';
import {ArrowRight,X} from 'lucide-react';
import type {TourStep} from './WorkspaceTraining.js';

const GuideBook=lazy(()=>import('./WorkspaceGuideBook.js').then(module=>({default:module.WorkspaceGuide})));
export function WorkspaceGuide(props:ComponentProps<typeof GuideBook>){
 return <Suspense fallback={<p className="panel section-loading" role="status">Открываем гайд…</p>}><GuideBook {...props}/></Suspense>;
}

type Spotlight={left:number;top:number;width:number;height:number};
export function WorkspaceTour({steps,index,change,end}:{steps:TourStep[];index:number;change:(index:number)=>void;end:()=>void}){
 const frame=useRef<HTMLDialogElement>(null),card=useRef<HTMLDivElement>(null),heading=useRef<HTMLHeadingElement>(null);
 const [placement,setPlacement]=useState<{anchor:string;highlight:Spotlight;above:boolean}|null>(null);
 const [answers,setAnswers]=useState<Record<number,number|string>>({});
 const [time,setTime]=useState('');
 const step=steps[index];
 const answer=answers[index];
 const correct=answer===('time' in step?step.time:step.correct);
 const next=()=>index+1<steps.length?change(index+1):end();
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
   const fallback=step.fallback?.split(', ').map(selector=>document.querySelector<HTMLElement>(selector)).find(Boolean);
   const primary=document.querySelector<HTMLElement>(step.anchor);
   const element=primary?.getClientRects().length?primary:fallback;
   if(!primary||element!==primary){if(attempts++<30)timer=window.setTimeout(measure,120);}
   if(!element||!element.getClientRects().length){
    setPlacement(null);
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
   <h2 tabIndex={-1} ref={heading} id="workspace-tour-title">{step.title}</h2>
   <p>{step.action}</p>
   <fieldset className="tour-exercise">
    <legend>Учебный пример</legend><p>{step.prompt}</p>
    {'time' in step?<form className="tour-time-form" onSubmit={event=>{event.preventDefault();setAnswers(previous=>({...previous,[index]:time}));}}>
     <label>Плановое время <input type="time" value={time} required onChange={event=>setTime(event.target.value)}/></label>
     <button type="submit" className="button secondary">Проверить</button>
    </form>:step.choices.map((choice,choiceIndex)=><button key={choice} type="button"
     aria-pressed={answer===choiceIndex} className="button secondary" onClick={()=>setAnswers(previous=>({...previous,[index]:choiceIndex}))}>{choice}</button>)}
    {answer!==undefined&&<p className="tour-feedback" role="status" data-result={correct?'correct':'retry'}>
     <strong>{correct?'Верно.':'Попробуйте ещё раз.'}</strong> {step.answer}
    </p>}
   </fieldset>
   <div className="tour-actions"><button className="button secondary" type="button" onClick={()=>change(index-1)} disabled={index===0}>Назад</button>
    {!correct&&<button className="text-button" type="button" onClick={next}>Пропустить</button>}
    <button className="button primary" type="button" disabled={!correct} onClick={next}>{index+1===steps.length?'Завершить':'Далее'} <ArrowRight size={16}/></button></div>
  </div>
 </dialog>;
}
