import type {Comment} from '../shared/types.js';
export function CommentFiles({comment}:{comment:Comment}){
 const attachments=comment.bitrix_attachments as {FILE_ID?:unknown[];files?:{id:unknown;name:string}[]}|unknown[]|undefined;
 const ids=Array.isArray(attachments)?attachments:attachments?.FILE_ID??[];
 const files=!Array.isArray(attachments)?attachments?.files??[]:[];
 return <>{ids.map(id=><p key={String(id)}><a href={`/api/tasks/${encodeURIComponent(comment.task_id)}/bitrix-comment-files/${comment.id}/${encodeURIComponent(String(id))}`}>{files.find(file=>String(file.id)===String(id))?.name||'Вложение #'+String(id)}</a></p>)}</>;
}
