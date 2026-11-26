import type {User} from './types.js';

export const unassignedBranch='Не указан';
export type BranchApprovalLead={branchId:string;userId:string|null};

/** An explicit branch responsibility can coexist with the person's sales-head role. */
export function branchApprovalLead(branch:string,people:User[],configured:BranchApprovalLead[]=[]){
 const bindings=configured.filter(item=>branchCovers(item.branchId,branch)).sort((a,b)=>b.branchId.length-a.branchId.length);
 if(bindings.length){
  const person=people.find(user=>user.id===bindings[0].userId);
  return person&&!person.root_access&&['branch_manager','admin','director','sales_head'].includes(person.role)?person:null;
 }
 const candidates=people.filter(person=>canApproveBranch(person)&&branchCovers(person.branch_id,branch));
 const longest=Math.max(0,...candidates.map(person=>person.branch_id.length));
 const closest=candidates.filter(person=>person.branch_id.length===longest);
 return closest.length===1?closest[0]:null;
}

export function canApproveBranch(user:User){
 return !user.root_access&&(user.role==='branch_manager'||user.role==='admin'&&!!user.approval_branch_lead);
}

export function branchCovers(scope:string,branch:string){
 return !!scope&&scope!==unassignedBranch&&(branch===scope||branch.startsWith(scope+' / '));
}
