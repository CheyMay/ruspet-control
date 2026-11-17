import type {Task,User} from '../shared/types.js';

export function TaskPeople({task,users}:{task:Pick<Task,'assignee_id'|'creator_id'>;users:User[]}){
 const name=(id:string)=>users.find(person=>person.id===id)?.name??id;
 return <div className="task-people">
  <span><span className="muted">Исполнитель</span> {name(task.assignee_id)}</span>
  <span><span className="muted">Постановщик</span> {name(task.creator_id)}</span>
 </div>;
}
