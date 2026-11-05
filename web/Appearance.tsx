import {Check} from 'lucide-react';
import type {CSSProperties} from 'react';
import {useAppearance} from './theme-preferences.js';
export function Appearance(){
 const {theme,base,accent}=useAppearance(),controller=window.ruspetAppearance;
 const mode=theme==='dark'?'тёмной':'светлой';
 return <section className="panel automation-settings appearance-settings">
  <div className="appearance-heading"><div><h2>Оформление</h2><p className="muted">Сейчас настраивается палитра {mode} темы. Выбор для светлой и тёмной темы сохраняется отдельно в этом браузере.</p></div><span className="appearance-mode">{theme==='dark'?'Тёмная тема':'Светлая тема'}</span></div>
  <fieldset className="appearance-group"><legend>Основной цвет · для {mode} темы</legend><p className="muted">Фон рабочего пространства, панели, окна, таблицы и поля.</p>
   <div className="base-palette-options" role="group" aria-label={`Основной цвет ${mode} темы`}>{controller.bases.map(p=><button type="button" key={p.id} className="base-palette" aria-pressed={base===p.id} onClick={()=>controller.setBase(p.id)}>
    <span className="base-palette-swatch" aria-hidden="true" style={{'--palette-bg':p[theme][0],'--palette-surface':p[theme][1],'--palette-soft':p[theme][2],'--palette-raised':p[theme][3]} as CSSProperties}><i/><i/><i/></span>
    <span className="palette-label">{p.label}<Check size={15} aria-hidden="true" style={{visibility:base===p.id?'visible':'hidden'}}/></span>
   </button>)}</div>
  </fieldset>
  <fieldset className="appearance-group"><legend>Дополнительный цвет · для {mode} темы</legend><p className="muted">Кнопки, ссылки, выделение и активные элементы.</p>
   <div className="accent-palette-options" role="group" aria-label={`Дополнительный цвет ${mode} темы`}>{controller.accents.map(p=><button type="button" className="button secondary" key={p.id} aria-pressed={accent===p.id} onClick={()=>controller.setAccent(p.id)}><i aria-hidden="true" style={{background:p[theme]}}/>{p.label}<Check size={14} aria-hidden="true" style={{visibility:accent===p.id?'visible':'hidden'}}/></button>)}</div>
  </fieldset>
  <div className="appearance-preview" aria-label="Пример оформления"><span className="appearance-preview-sidebar" aria-hidden="true"><i/><i/><i/></span><div><strong>Пример оформления</strong><p>Панели и поля — основной цвет, выделение — дополнительный.</p><span className="appearance-preview-action">{controller.accents.find(p=>p.id===accent)?.label}</span></div></div>
 </section>;
}
