import {useId} from 'react';

const paint={
 brand:{sideDark:'#2b4b3d',sideLight:'#7c9a84',side:'#557763',faceLight:'#d6e3d4',face:'#9cb4a1',ink:'#25483a'},
 day:{sideDark:'#665334',sideLight:'#bba57d',side:'#96815e',faceLight:'#f2e7cd',face:'#cbb791',ink:'#644e2b'},
 night:{sideDark:'#233446',sideLight:'#708698',side:'#526779',faceLight:'#ced9e3',face:'#90a7b8',ink:'#21394e'},
};

const ribs=Array.from({length:17},(_,index)=>{
 const angle=Math.PI*(index+1)/18;
 const x=32-25.6*Math.cos(angle);
 const y=24+12.8*Math.sin(angle);
 return {x,y,width:.55+Math.sin(angle)*.65};
});

export function CapArtwork({variant='brand'}:{variant?:keyof typeof paint}){
 const id=useId();
 const color=paint[variant];
 return <svg className="cap-art" viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
  <defs>
   <linearGradient id={id+'side'} x1="0" x2="1" y1="0" y2="0">
    <stop stopColor={color.sideDark}/>
    <stop offset=".28" stopColor={color.sideLight}/>
    <stop offset=".68" stopColor={color.side}/>
    <stop offset="1" stopColor={color.sideDark}/>
   </linearGradient>
   <radialGradient id={id+'face'} cx=".34" cy=".24" r=".83">
    <stop stopColor={color.faceLight}/>
    <stop offset="1" stopColor={color.face}/>
   </radialGradient>
  </defs>
  <path d="M6 24v14a26 13 0 0 0 52 0V24Z" fill={'url(#'+id+'side)'}/>
  {ribs.map(({x,y,width})=><g key={x}>
   <path d={`M${x-.65} ${y}v12`} stroke="#fff" strokeOpacity=".2" strokeWidth=".72"/>
   <path d={`M${x} ${y}v12`} stroke={color.ink} strokeOpacity=".38" strokeWidth={width}/>
  </g>)}
  <path d="M6.4 37a25.6 12.8 0 0 0 51.2 0" stroke={color.sideDark} strokeOpacity=".45" strokeWidth=".9"/>
  <path d="M6.4 38.4a25.6 12.8 0 0 0 51.2 0" stroke="#fff" strokeOpacity=".15" strokeWidth=".7"/>
  <ellipse cx="32" cy="24" rx="26" ry="13" fill={'url(#'+id+'face)'}/>
  <ellipse cx="32" cy="24" rx="25.5" ry="12.5" stroke="#fff" strokeOpacity=".36" strokeWidth=".8"/>
  <ellipse cx="32" cy="24" rx="22.7" ry="10.2" stroke={color.ink} strokeOpacity=".17" strokeWidth=".7"/>
  {variant==='brand'?<g transform="translate(0 24) scale(1 .63)" fontFamily="Arial, sans-serif" fontSize="25" fontWeight="800" textAnchor="middle">
   <text x="32" y="9" fill="#fff" opacity=".45">Р</text>
   <text x="32" y="8" fill={color.ink}>Р</text>
  </g>:<g transform="translate(32 24) scale(1 .62)" fill={color.ink}>
   {variant==='day'?<>
    <circle r="4.3"/>
    <path d="M0 -9v2 M0 7v2 M-9 0h2 M7 0h2 M-6.4 -6.4l1.4 1.4 M5 5l1.4 1.4 M-6.4 6.4l1.4 -1.4 M5 -5l1.4 -1.4"
     stroke={color.ink} strokeWidth="1.65" strokeLinecap="round"/>
   </>:<path d="M2.7-8.5A8.7 8.7 0 1 0 8.2 3.7 7.4 7.4 0 0 1 2.7-8.5Z"/>}
  </g>}
 </svg>;
}

export function CapMark(){
 return <span className="cap-mark" aria-hidden="true"><CapArtwork/></span>;
}

export function WorkspaceLoading(){
 return <div className="boot workspace-loading" role="status" aria-live="polite">
  <div className="boot-stage" aria-hidden="true">
   <span className="boot-orbit"/>
   <div className="boot-cap"><CapArtwork/></div>
  </div>
  <div className="boot-copy">
   <h2>РУСПЭТ</h2>
   <p>Загружаем рабочее пространство…</p>
  </div>
 </div>;
}
