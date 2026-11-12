import type {Task,User} from './types.js';
/** Visibility is checked separately on the server. Deadline approval is unchanged. */
export function canEditTaskData(user:User,task:Task){
 return !task.bitrix_deleted_at&&(user.role==='admin'||task.creator_id===user.id||task.status==='active'&&['director','sales_head','branch_manager'].includes(user.role));
}
