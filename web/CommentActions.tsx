import {useState} from 'react';
import type {Comment,User} from '../shared/types.js';
export function CommentActions({comment,user,busy,act}:{comment:Comment;user:User;busy:boolean;act:(path:string,body:unknown,method?:string)=>Promise<boolean>}){
 const [editing,setEditing]=useState(false),[deleting,setDeleting]=useState(false),[body,setBody]=useState(comment.body);
 if(comment.author_id!==user.id&&!['admin','director','sales_head'].includes(user.role))return null;
 const save=async(value:string|null)=>{if(await act(`/tasks/${comment.task_id}/comments/${comment.id}`,{body:value,expectedRevision:comment.revision??1},'PATCH')){setEditing(false);setDeleting(false);}};
 return <div>{editing?<form onSubmit={e=>{e.preventDefault();void save(body);}}><textarea value={body} maxLength={4000} required onChange={e=>setBody(e.target.value)}/><button disabled={busy} className="button secondary">Сохранить</button><button type="button" onClick={()=>setEditing(false)}>Отмена</button></form>:<button className="text-button" onClick={()=>setEditing(true)}>Изменить</button>}{deleting?<><button className="text-button" disabled={busy} onClick={()=>void save(null)}>Подтвердить удаление</button><button className="text-button" onClick={()=>setDeleting(false)}>Отмена</button></>:<button className="text-button" onClick={()=>setDeleting(true)}>Удалить</button>}</div>;
}
