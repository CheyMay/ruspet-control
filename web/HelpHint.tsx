import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Info} from 'lucide-react';
import './interaction-controls.css';

export function HelpHint({text}:{text:string}){
 const id=useId();
 const anchor=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const timer=useRef<ReturnType<typeof setTimeout>>(undefined);
 const [open,setOpen]=useState(false);
 const [pinned,setPinned]=useState(false);
 function show(){clearTimeout(timer.current);setOpen(true);}
 function leave(){clearTimeout(timer.current);if(!pinned)timer.current=setTimeout(()=>setOpen(false),140);}
 function close(){clearTimeout(timer.current);setPinned(false);setOpen(false);}
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 useLayoutEffect(()=>{
  if(!open)return;
  const popup=panel.current;
  popup?.showPopover?.();
  const place=()=>{
   if(!anchor.current||!panel.current)return;
   const rect=anchor.current.getBoundingClientRect();
   const viewport=window.visualViewport;
   const x=viewport?.offsetLeft??0,y=viewport?.offsetTop??0;
   const width=viewport?.width??window.innerWidth,height=viewport?.height??window.innerHeight;
   if(rect.bottom<=y||rect.top>=y+height){close();return;}
   const el=panel.current;
   el.style.width=Math.min(320,width-16)+'px';
   el.style.maxHeight=height-16+'px';
   const above=rect.top-y-8,below=y+height-rect.bottom-8;
   const top=below>=el.offsetHeight||below>=above?rect.bottom+8:rect.top-el.offsetHeight-8;
   el.style.left=Math.max(x+8,Math.min(rect.left,x+width-el.offsetWidth-8))+'px';
   el.style.top=Math.max(y+8,Math.min(top,y+height-el.offsetHeight-8))+'px';
  };
  const click=(event:PointerEvent)=>{
   const target=event.target as Node;
   if(!anchor.current?.contains(target)&&!panel.current?.contains(target))close();
  };
  const key=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.stopPropagation();close();}
  };
  place();
  window.addEventListener('scroll',place,true);
  window.addEventListener('resize',place);
  window.visualViewport?.addEventListener('resize',place);
  window.visualViewport?.addEventListener('scroll',place);
  document.addEventListener('pointerdown',click,true);
  document.addEventListener('keydown',key,true);
  return()=>{
   if(popup?.isConnected)popup.hidePopover?.();
   window.removeEventListener('scroll',place,true);
   window.removeEventListener('resize',place);
   window.visualViewport?.removeEventListener('resize',place);
   window.visualViewport?.removeEventListener('scroll',place);
   document.removeEventListener('pointerdown',click,true);
   document.removeEventListener('keydown',key,true);
  };
 },[open,text]);
 return <>
  <button type="button" ref={anchor} className="help-hint" aria-label="Пояснение" aria-describedby={open?id:undefined}
   aria-expanded={open} onPointerEnter={event=>{if(event.pointerType==='mouse')show();}} onPointerLeave={event=>{if(event.pointerType==='mouse')leave();}}
   onFocus={show} onBlur={()=>{if(!pinned)leave();}} onClick={()=>{if(pinned)close();else{show();setPinned(true);}}}>
   <Info size={17} aria-hidden="true"/>
  </button>
  {open&&createPortal(<div ref={panel} id={id} role="tooltip" popover="manual" className="help-hint-popup" onPointerEnter={show} onPointerLeave={leave}>{text}</div>,document.body)}
 </>;
}
