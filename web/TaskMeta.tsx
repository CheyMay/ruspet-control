import type {Task} from '../shared/types.js';

const createdDate=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',year:'numeric'});

export function TaskMeta({task}:{task:Pick<Task,'created_at'|'client_names'>}){
 const created=new Date(task.created_at);
 const clients=task.client_names??[];
 return <span className="task-meta-facts">
  {Number.isFinite(created.getTime())&&<span>Создана <time dateTime={task.created_at}>{createdDate.format(created)}</time></span>}
  {clients.map(client=><span key={client} className="task-meta-client">Клиент <b>{client}</b></span>)}
 </span>;
}
