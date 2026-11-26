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
  const animation=element.animate([
   {transform:'translateY(0) rotate(0) scale(1)',easing:'cubic-bezier(.24,.72,.36,1)'},
   {transform:'translateY(-7px) rotate(-7deg) scale(1.08)',offset:.38,easing:'cubic-bezier(.49,0,.8,.54)'},
   {transform:'translateY(1px) rotate(2deg) scale(1.06,.94)',offset:.78,easing:'ease-out'},
   {transform:'translateY(0) rotate(0) scale(1)'}
  ],{duration:540});
  return()=>animation.cancel();
 },[theme]);
 const label=dark?'Включить светлую тему':'Включить тёмную тему';
 return <button type="button" className="theme-toggle" onClick={()=>window.ruspetAppearance.setTheme(dark?'light':'dark')}
  aria-label={label} title={label} aria-pressed={dark}>
  <span className="theme-hop" ref={hop} aria-hidden="true">
   <span className="theme-rotator">
    <span className="cap-face cap-face-front"><CapArtwork variant="day"/></span>
    <span className="cap-face cap-face-back"><CapArtwork variant="night"/></span>
   </span>
  </span>
 </button>;
}
