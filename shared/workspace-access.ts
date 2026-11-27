import type {User} from './types.js';
import type {AnalyticsAccess} from './team-analytics.js';

export const protectedStaffRole=(role:User['role'])=>role==='admin'||role==='director'||role==='sales_head';
export const mayManageStaffAccounts=(actor:Pick<User,'root_access'|'account_manage_access'>)=>
 actor.root_access===true||actor.account_manage_access===true;
export const protectedStaffIdentity=(target:Pick<User,'role'|'account_manage_access'>)=>protectedStaffRole(target.role)||target.account_manage_access===true;
export const mayManageStaffIdentity=(actor:Pick<User,'id'|'role'|'root_access'>,target:Pick<User,'id'|'role'|'root_access'|'account_manage_access'>)=>
 actor.role==='admin'&&!target.root_access&&(actor.root_access===true||actor.id===target.id||!protectedStaffIdentity(target));

export type WorkspacePage='org'|'delegations'|'processes'|'catalog'|'okb'|'actions'|'bot'|'overview'|'tasks'|'approvals'|'checks'|'reports'|'people'|'journal'|'settings'|'notifications'|'calendar'|'analytics'|'guide';
const personal=new Set<WorkspacePage>(['overview','actions','tasks','approvals','reports','notifications','bot','settings','calendar','guide','okb','catalog']);

export function canOpenWorkspacePage(user:User,page:WorkspacePage,analytics?:AnalyticsAccess|null){
 if(page==='analytics')return !!analytics;
 if(user.role==='employee')return personal.has(page);
 if(page==='org')return user.role==='admin'||user.role==='director';
 return true;
}
