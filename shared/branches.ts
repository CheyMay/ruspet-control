import type {User} from './types.js';

export const unassignedBranch='Не указан';

export function canApproveBranch(user:User){
 return !user.root_access&&(user.role==='branch_manager'||user.role==='admin'&&!!user.approval_branch_lead);
}

export function branchCovers(scope:string,branch:string){
 return !!scope&&scope!==unassignedBranch&&(branch===scope||branch.startsWith(scope+' / '));
}
