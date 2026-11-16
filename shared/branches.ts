export const unassignedBranch='Не указан';

export function branchCovers(scope:string,branch:string){
 return !!scope&&scope!==unassignedBranch&&(branch===scope||branch.startsWith(scope+' / '));
}
