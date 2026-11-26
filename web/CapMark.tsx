import {useId} from 'react';

const paint={
 brand:{edge:'#17554c',rimLight:'#509883',rimDark:'#23675d',topLight:'#c1f4dc',topDark:'#74d9ba',seal:'#23675d'},
 day:{edge:'#75523c',rimLight:'#e9b972',rimDark:'#a96c46',topLight:'#fff0c5',topDark:'#ffc47c',seal:'#8e4f35'},
 night:{edge:'#233453',rimLight:'#7390bc',rimDark:'#384c75',topLight:'#c8daf7',topDark:'#8ca7db',seal:'#374669'},
};

export function CapArtwork({variant='brand'}:{variant?:keyof typeof paint}){
 const id=useId();
 const color=paint[variant];
 return <svg className="cap-art" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
  <defs>
   <linearGradient id={id+'rim'} x1="9" y1="31" x2="52" y2="51" gradientUnits="userSpaceOnUse">
    <stop stopColor={color.rimLight}/>
    <stop offset="1" stopColor={color.rimDark}/>
   </linearGradient>
   <linearGradient id={id+'top'} x1="15" y1="12" x2="48" y2="35" gradientUnits="userSpaceOnUse">
    <stop stopColor={color.topLight}/>
    <stop offset="1" stopColor={color.topDark}/>
   </linearGradient>
  </defs>
  <path d="M8.5 25v12.5l3.4 6 4.1 1.1 2.9 3.8 5 .1 3.5 2.7 4.6-1 4.6 1 3.5-2.7 5-.1 2.9-3.8 4.1-1.1 3.4-6V25z"
   fill={'url(#'+id+'rim)'} stroke={color.edge} strokeWidth="1.9" strokeLinejoin="round"/>
  <path d="m16 36 2.9 12.4 5 .1L22 39.4Zm12.7 4.9-1.3 10.3 4.6-1 4.6 1-1.1-10.3Zm14.1-1.4-2.7 9 5-.1L48 36.7Z"
   fill={color.edge} opacity=".29"/>
  <path d="M9 27c0 9 10.5 15 23 15s23-6 23-15" stroke={color.edge} strokeWidth="1.5" opacity=".6"/>
  <ellipse cx="32" cy="24" rx="23.5" ry="13" fill={'url(#'+id+'top)'} stroke={color.edge} strokeWidth="1.9"/>
  <path d="M13.7 23.6c0-4.7 8.3-9.1 18.3-9.1 5 0 9.6.9 12.8 2.4" stroke="white" strokeOpacity=".65" strokeWidth="1.8" strokeLinecap="round"/>
  {variant==='day'?<g fill={color.seal}>
   <ellipse cx="32" cy="24.5" rx="4.7" ry="3.8"/>
   <path d="M31 17h2v3h-2zm0 12h2v3h-2zm-9-5.5h4v2h-4zm16 0h4v2h-4zm-12.6-4.9 3 1.5-1 1.5-3-1.5zm10 9.3 1-1.5 3 1.5-1 1.5z" opacity=".83"/>
  </g>:variant==='night'?<path d="M33.5 18.1c-1.9 1.7-2.1 4.6-.5 6.5 1.5 1.8 4.2 2.4 6.1 1.4-1.2 2.5-4.4 4-7.4 3.5-3.8-.6-6.2-3.4-5.4-6.4.6-2.6 3.7-4.8 7.2-5Z" fill={color.seal}/>:
   <path d="M24.7 25.1 32 18.4l7.3 6.7-7.3 5.4zM32 21.2l-4.3 3.9 4.3 3.1 4.3-3.1z" fill={color.seal} fillRule="evenodd"/>}
 </svg>;
}

export function CapMark(){
 return <span className="cap-mark" aria-hidden="true"><CapArtwork/></span>;
}

export function WorkspaceLoading(){
 return <div className="boot workspace-loading" role="status" aria-live="polite">
  <div className="boot-stage" aria-hidden="true">
   <span className="boot-orbit"/>
   <div className="boot-spinner">
    <span className="cap-face cap-face-front"><CapArtwork/></span>
    <span className="cap-face cap-face-back"><CapArtwork/></span>
   </div>
  </div>
  <div className="boot-copy">
   <h2>РУСПЭТ</h2>
   <p>Загружаем рабочее пространство…</p>
  </div>
 </div>;
}
