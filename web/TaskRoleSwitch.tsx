import type {PersonalTaskScope} from '../shared/types.js';

export function TaskRoleSwitch({value,change,disabled=false}:{value?:PersonalTaskScope;change:(scope:PersonalTaskScope)=>void;disabled?:boolean}){
 return <div className="task-role-switch" role="group" aria-label="Моя роль в задаче">
  <button type="button" aria-pressed={value==='mine'} disabled={disabled} onClick={()=>change('mine')}>Я исполнитель</button>
  <button type="button" aria-pressed={value==='created'} disabled={disabled} onClick={()=>change('created')}>Я постановщик</button>
 </div>;
}
