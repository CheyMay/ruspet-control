import type {User} from './types.js';

export const teamScopeLabels={team:'Моя команда',sales:'Команда продаж'} as const;
export type TeamScope=keyof typeof teamScopeLabels;
export type TeamTaskIds=Record<TeamScope,string[]>;

export function hasSplitTeams(user:User){
 return user.sales_analytics_access===true&&!user.root_access&&user.role!=='director';
}

export function isTeamScope(value:unknown):value is TeamScope{
 return value==='team'||value==='sales';
}
