import {useState} from 'react';
const palettes={green:'Хвойный',blue:'Синий',plum:'Сливовый',graphite:'Графитовый'};
type Palette=keyof typeof palettes;
export function Appearance(){
 const [value,setValue]=useState(document.documentElement.dataset.accent||'green');
 function choose(palette:Palette){
  document.documentElement.dataset.accent=palette;
  setValue(palette);
  try{localStorage.setItem('ruspet-accent',palette);}catch{/* The selected palette still applies. */}
 }
 return <section className="panel automation-settings"><h2>Оформление</h2><p className="muted">Акцент сохраняется в этом браузере. Цвета сроков и предупреждений сохраняют свои значения.</p>
  <div className="palette-options" role="group" aria-label="Цвет интерфейса">{(Object.entries(palettes) as [Palette,string][]).map(([id,label])=><button type="button" className="button secondary" key={id} aria-pressed={value===id} onClick={()=>choose(id)}><i data-swatch={id}/>{label}</button>)}</div>
 </section>;
}
