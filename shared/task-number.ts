export type TaskNumber={id:string;bitrix_id?:string|null};
export const taskNumber=(task:TaskNumber)=>task.bitrix_id??task.id;
