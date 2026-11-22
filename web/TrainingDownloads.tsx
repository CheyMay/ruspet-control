import {Download} from 'lucide-react';
import {trainingMaterials} from '../shared/training-materials.js';

export function TrainingDownloads(){
 return <section className="panel guide-card training-downloads" aria-labelledby="training-downloads-title">
  <h2 id="training-downloads-title">Материалы для обучения</h2>
  <ul>{trainingMaterials.map(material=><li key={material.id}>
   <div><strong>{material.title}</strong><p>{material.detail}</p></div>
   <a className={'button '+(material.id==='all'?'primary':'secondary')} href={'/api/owner/training/'+material.id}
    aria-label={'Скачать '+material.title.toLowerCase()}><Download size={16}/>{material.file.endsWith('.pdf')?'PDF':'ZIP'}</a>
  </li>)}</ul>
 </section>;
}
