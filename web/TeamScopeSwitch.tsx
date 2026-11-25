import {teamScopeLabels,type TeamScope} from '../shared/team-scopes.js';

export function TeamScopeSwitch<T extends 'all'|'mine'|'created'>({value,base,additional=[],onChange}:{
 value:T|TeamScope;base:{id:T;label:string};additional?:{id:T;label:string}[];onChange:(scope:T|TeamScope)=>void;
}){
 return <div className="task-role-switch" role="group" aria-label="Область команды">
  {[base,...additional].map(option=><button type="button" key={option.id} aria-pressed={value===option.id}
   onClick={()=>onChange(option.id)}>{option.label}</button>)}
  {(['team','sales'] as const).map(scope=><button type="button" key={scope}
   aria-pressed={value===scope} onClick={()=>onChange(scope)}>{teamScopeLabels[scope]}</button>)}
 </div>;
}
