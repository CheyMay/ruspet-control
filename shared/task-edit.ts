import type {Task,User} from './types.js';

export type TaskEditPermission={
 id:string;
 requesterId:string;
 state:'pending'|'approved'|'rejected'|'used';
 reason:string;
 decisionComment:string;
};

export type TaskEditAccess={
 canEdit:boolean;
 canRequest:boolean;
 canDecide:boolean;
 request:TaskEditPermission|null;
};

export const editsTaskDirectly=(user:User,task:Task)=>
 user.id===task.creator_id||user.role==='admin'||user.root_access===true;
