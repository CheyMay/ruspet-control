import type {User} from './types.js';

export type WorkspacePage='org'|'delegations'|'processes'|'okb'|'actions'|'bot'|'overview'|'tasks'|'approvals'|'checks'|'reports'|'people'|'journal'|'settings'|'notifications'|'calendar';
const personal=new Set<WorkspacePage>(['overview','actions','tasks','approvals','reports','notifications','bot','settings','calendar']);

export function canOpenWorkspacePage(user:User,page:WorkspacePage){
 if(user.role==='employee')return personal.has(page);
 if(page==='org')return user.role==='admin'||user.role==='director';
 if(page==='okb')return ['admin','director','sales_head'].includes(user.role);
 return true;
}
