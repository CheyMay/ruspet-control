import type {PersonalTaskScope} from '../shared/types.js';

export function TaskRoleSwitch({value,change,all,disabled=false}:{value?:PersonalTaskScope;change:(scope:PersonalTaskScope)=>void;
 all?:{selected:boolean;onClick:()=>void};disabled?:boolean}){
 return <div className="task-role-switch" role="group" aria-label="Моя роль в задаче">
  {all&&<button type="button" aria-pressed={all.selected} disabled={disabled} onClick={all.onClick} title="Задачи, где я исполнитель или постановщик">Все мои</button>}
  <button type="button" aria-pressed={value==='mine'} disabled={disabled} onClick={()=>change('mine')}>Я исполнитель</button>
  <button type="button" aria-pressed={value==='created'} disabled={disabled} onClick={()=>change('created')}>Я постановщик</button>
 </div>;
}
