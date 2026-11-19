import type {User} from './types.js';
import type {AnalyticsAccess} from './team-analytics.js';

export const protectedStaffRole=(role:User['role'])=>role==='admin'||role==='director'||role==='sales_head';
export const mayManageStaffIdentity=(actor:Pick<User,'id'|'role'|'root_access'>,target:Pick<User,'id'|'role'|'root_access'>)=>
 actor.role==='admin'&&!target.root_access&&(actor.root_access===true||actor.id===target.id||!protectedStaffRole(target.role));

export type WorkspacePage='org'|'delegations'|'processes'|'okb'|'actions'|'bot'|'overview'|'tasks'|'approvals'|'checks'|'reports'|'people'|'journal'|'settings'|'notifications'|'calendar'|'analytics';
const personal=new Set<WorkspacePage>(['overview','actions','tasks','approvals','reports','notifications','bot','settings','calendar']);

export function canOpenWorkspacePage(user:User,page:WorkspacePage,analytics?:AnalyticsAccess|null){
 if(page==='analytics')return !!analytics;
 if(user.role==='employee')return personal.has(page);
 if(page==='org')return user.role==='admin'||user.role==='director';
 if(page==='okb')return ['admin','director','sales_head'].includes(user.role);
 return true;
}
