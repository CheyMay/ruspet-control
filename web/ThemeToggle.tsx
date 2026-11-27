import {createElement,useLayoutEffect,useRef,type FocusEvent} from 'react';
import {CapArtwork} from './CapMark.js';
import {useAppearance} from './theme-preferences.js';

type SakugaToggle=HTMLElement&{checked:boolean};

function showFocus({currentTarget,nativeEvent}:FocusEvent<HTMLDivElement>){
 const button=nativeEvent.composedPath()[0];
 currentTarget.toggleAttribute('data-keyboard-focus',button instanceof HTMLElement&&button.matches(':focus-visible'));
}

export function ThemeToggle(){
 const {theme}=useAppearance(),dark=theme==='dark';
 const toggle=useRef<SakugaToggle>(null),face=useRef<HTMLSpanElement>(null);
 const motion=useRef<Animation[]>([]);
 const supported=!!customElements.get('sakuga-toggle');
 useLayoutEffect(()=>{
  const element=toggle.current,restingFace=face.current;
  if(!element||!restingFace)return;
  const switchTheme=()=>{
   motion.current.forEach(animation=>animation.cancel());
   if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
    // The published sprite plays 43 forward frames and 12 reverse frames at 30 fps.
    const duration=element.checked?1400:367;
    motion.current=[
     element.animate([{opacity:1},{opacity:1,offset:.92},{opacity:0}],duration),
     restingFace.animate([{opacity:0},{opacity:0,offset:.92},{opacity:1}],duration)
    ];
   }
   window.ruspetAppearance.setTheme(element.checked?'dark':'light');
  };
  element.addEventListener('change',switchTheme);
  return()=>{
   element.removeEventListener('change',switchTheme);
   motion.current.forEach(animation=>animation.cancel());
  };
 },[supported]);
 useLayoutEffect(()=>{
  const element=toggle.current;
  if(element&&element.checked!==dark){
   motion.current.forEach(animation=>animation.cancel());
   element.checked=dark;
  }
 },[dark,supported]);

 const cap=<CapArtwork variant={dark?'night':'day'}/>;
 if(!supported){
  const label=dark?'Включить светлую тему':'Включить тёмную тему';
  return <button type="button" className="theme-toggle theme-toggle-basic" onClick={()=>window.ruspetAppearance.setTheme(dark?'light':'dark')}
   aria-label={label} title={label} aria-pressed={dark}>{cap}</button>;
 }
 return <div className="theme-toggle" data-dark={dark} onFocus={showFocus}
  onBlur={event=>event.currentTarget.removeAttribute('data-keyboard-focus')}
  onPointerDown={event=>event.currentTarget.removeAttribute('data-keyboard-focus')}>
  {createElement('sakuga-toggle',{ref:toggle,label:'Тёмная тема'})}
  <span className="theme-toggle-face" ref={face} aria-hidden="true">
   <span className="theme-toggle-cap">{cap}</span>
  </span>
 </div>;
}
