import {useId} from 'react';
import {useAppearance} from './theme-preferences.js';

export function ThemeToggle() {
 const {theme}=useAppearance(),dark=theme==='dark';
 const id=useId().replace(/:/g,'');
 function toggle(){
  window.ruspetAppearance.setTheme(dark?'light':'dark');
 }
 const label=dark?'Включить светлую тему':'Включить тёмную тему';
 return <button type="button" className="theme-toggle" onClick={toggle} aria-label={label} title={label} aria-pressed={dark}>
  <svg className={dark?'theme-cap light-cap':'theme-cap dark-cap'} viewBox="0 0 48 48" fill="none" aria-hidden="true">
   <defs>
    <linearGradient id={id+'body'} x1="10" y1="19" x2="38" y2="38" gradientUnits="userSpaceOnUse"><stop stopColor="var(--cap-body-start)"/><stop offset=".5" stopColor="var(--cap-body-mid)"/><stop offset="1" stopColor="var(--cap-body-end)"/></linearGradient>
    <linearGradient id={id+'top'} x1="17" y1="10" x2="31" y2="22" gradientUnits="userSpaceOnUse"><stop stopColor="var(--cap-top-start)"/><stop offset="1" stopColor="var(--cap-top-end)"/></linearGradient>
   </defs>
   <ellipse cx="24" cy="38" rx="14" ry="3" fill="var(--cap-shadow)"/>
   <path d="M9 17v16c0 8 30 8 30 0V17" fill={'url(#'+id+'body)'} stroke="var(--cap-edge)" strokeWidth="1.2"/>
   <path d="M10 32c4 6 24 6 28 0" stroke="var(--cap-edge)" strokeWidth="1.3"/>
   <path d="M13 21v10m4-9v11m5-10v11m5-11v11m5-12v11m4-12v10" stroke="var(--cap-ridge)" strokeWidth="1.4" strokeLinecap="round"/>
   <ellipse cx="24" cy="17" rx="15" ry="6.5" fill={'url(#'+id+'top)'} stroke="var(--cap-edge)" strokeWidth="1.2"/>
   <ellipse cx="24" cy="17" rx="11" ry="4" stroke="var(--cap-highlight)" strokeWidth=".8"/>
   <path d="M14 15c4-3 13-4 19-1" stroke="var(--cap-highlight)" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
 </button>;
}
