import {useLayoutEffect,useRef} from 'react';
import {CapArtwork} from './CapMark.js';
import {useAppearance} from './theme-preferences.js';

export function ThemeToggle(){
 const {theme}=useAppearance(),dark=theme==='dark';
 const previousTheme=useRef(theme);
 const hop=useRef<HTMLSpanElement>(null);
 useLayoutEffect(()=>{
  const changed=previousTheme.current!==theme;
  previousTheme.current=theme;
  const element=hop.current;
  if(!changed||!element||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const angle=dark?'-5deg':'5deg';
  const animation=element.animate([
   {transform:'translateY(0) rotate(0)',easing:'ease-out'},
   {transform:`translateY(-3px) rotate(${angle})`,offset:.43,easing:'ease-in-out'},
   {transform:'translateY(0) rotate(0)'}
  ],{duration:340});
  return()=>animation.cancel();
 },[dark,theme]);
 const label=dark?'Включить светлую тему':'Включить тёмную тему';
 return <button type="button" className="theme-toggle" onClick={()=>window.ruspetAppearance.setTheme(dark?'light':'dark')}
  aria-label={label} title={label} aria-pressed={dark}>
  <span className="theme-hop" ref={hop} aria-hidden="true"><CapArtwork variant={dark?'night':'day'}/></span>
 </button>;
}
