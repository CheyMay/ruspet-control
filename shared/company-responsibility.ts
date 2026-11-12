export type ResponsibilityHint={
 managerId:string|null;managerName:string|null;source:'okb'|'bitrix'|'excel'|'tasks'|null;
 companyId:string|null;companyName:string|null;token:string|null;reason:string|null;
};
export type DelegationTargets={version:number;people:import('./types.js').User[];responsibility:ResponsibilityHint};
export type DelegationClient={id:string;name:string};
export const responsibilityLabels={okb:'ОКБ',bitrix:'Битрикс24',excel:'Выгрузка ОКБ',tasks:'Текущие задачи клиента'} as const;
