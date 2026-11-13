import {summarize} from '../shared/analytics.js';
import type {Task,User} from '../shared/types.js';

export function TeamTasks({tasks,users,now,onSelect}:{tasks:Task[];users:User[];now:Date;onSelect:(id:string,filter:string)=>void}){
 const people=users.map(user=>({user,...summarize(tasks.filter(task=>task.assignee_id===user.id),now)}))
  .filter(row=>row.total).sort((a,b)=>b.overdue-a.overdue||b.today-a.today||b.unfinished-a.unfinished||a.user.name.localeCompare(b.user.name,'ru'));
 return <section className="panel team-summary">
  <div className="panel-heading"><div><h2>Задачи команды</h2><p>Выберите сотрудника или нажмите на показатель.</p></div></div>
  {people.length?<div className="table-scroll"><table>
   <thead><tr><th>Сотрудник</th><th>Открыто</th><th>Просрочено</th><th>Сегодня</th><th>На приёмке</th></tr></thead>
   <tbody>{people.map(row=><tr key={row.user.id}>
    <th scope="row"><button className="text-button" onClick={()=>onSelect(row.user.id,'all')}>{row.user.name}</button></th>
    {(['unfinished','overdue','today','review'] as const).map(key=><td key={key}>
     <button className={'number-link '+(key==='overdue'&&row[key]?'red-text':'')} onClick={()=>onSelect(row.user.id,key==='unfinished'?'active':key)}>{row[key]}</button>
    </td>)}
   </tr>)}</tbody>
  </table></div>:<p className="personal-empty">В доступной команде пока нет задач.</p>}
 </section>;
}
