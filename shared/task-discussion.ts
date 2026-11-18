import type {BitrixDiscussion,BitrixResult,Comment} from './types.js';

type Message={
 key:string; author:string; at:string|null; body:string; source:'Битрикс24'|'Согласование'|'РУСПЭТ'|'Результат · Битрикс24';
 approvalId?:string|null; files?:BitrixResult['files'];
};
export function discussionMessages(comments:Comment[],name:(id:string)=>string,bitrix:BitrixDiscussion|null):Message[]{
 const results=bitrix?.results?.items??[];
 const represented=new Set(results.flatMap(row=>row.comment_id?[row.comment_id]:[]));
 const messages:Message[]=[
  ...comments.map(comment=>({key:'local:'+comment.id,author:name(comment.author_id),at:comment.created_at,
   body:comment.body,source:comment.approval_id?'Согласование' as const:'РУСПЭТ' as const,approvalId:comment.approval_id})),
  ...(bitrix?.messages??[]).filter(message=>!represented.has(message.external_id)).map(message=>({
   key:'bitrix:'+message.external_id,author:message.author,at:message.occurred_at,body:message.body,source:'Битрикс24' as const})),
  ...results.map(result=>({key:'result:'+result.external_id,author:result.author,at:result.occurred_at,
   body:result.body,source:'Результат · Битрикс24' as const,files:result.files})),
 ];
 return messages.sort((a,b)=>(a.at??'').localeCompare(b.at??'')||a.key.localeCompare(b.key,'ru',{numeric:true}));
}
