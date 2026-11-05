export type ResponsibilityHint={
 managerId:string|null;managerName:string|null;source:'okb'|'bitrix'|null;
 companyId:string|null;companyName:string|null;token:string|null;reason:string|null;
};
export type DelegationTargets={version:number;people:import('./types.js').User[];responsibility:ResponsibilityHint};
