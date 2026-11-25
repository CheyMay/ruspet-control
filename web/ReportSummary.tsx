import {workspaceUrl} from './api.js';
import type {Report} from '../shared/types.js';
import {priceLabels} from '../shared/pricing.js';
import {taskLink,reportLink} from '../shared/report-links.js';

const date=(value:string)=>new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});
type Metric={label:string;count:number;subset?:string;price?:string};

export function ReportSummaryView({report}:{report:Report}){
 const summary=report.summary;
 if(!summary)return <div className="work-report">
  <p>Всего {report.metrics.total} · просрочено {report.metrics.overdue} · срок сегодня {report.metrics.today} · на приёмке {report.metrics.review}</p>
 </div>;
 if(!summary.stateAvailable)return <div className="work-report">{summary.notes.map(note=><p className="source-banner" key={note}>{note}</p>)}</div>;

 const link=(subset:string,price?:string)=>taskLink(workspaceUrl(),{
  report:report.id,subset,price,owner:report.parameters?.assigneeId,
  ...(subset==='tomorrow'?{day:summary.tomorrow.day,sort:'work_priority'}:{})
 });
 const cards=(metrics:Metric[])=><div className="work-report-stats">{metrics.map(metric=>{
  const contents=<><strong>{metric.count}</strong><span>{metric.label}</span></>;
  return metric.subset?<a key={metric.label} href={link(metric.subset,metric.price)}>{contents}</a>:<div key={metric.label}>{contents}</div>;
 })}</div>;
 const filters=Object.entries(summary.filters||{}).filter(([,value])=>value).map(([label,value])=>label+' · '+value);
 const outcomes=summary.outcomes,queue=summary.approvalQueue;
 const creator=summary.creatorProgress;
 if(report.kind==='nextday')return <div className="work-report">
  <h3>{new Date(summary.tomorrow.day+'T12:00:00+03:00').toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',timeZone:'Europe/Moscow'})}</h3>
  {cards([
   {label:'Просрочки к началу дня',count:summary.tomorrow.overdue},
   {label:'Крайний срок в этот день',count:summary.tomorrow.today},
   {label:'Открыть рабочий список',count:summary.tomorrow.total,subset:'tomorrow'},
  ])}
  {summary.tomorrow.total>0&&<p>В рабочем списке просрочки идут первыми, внутри очереди задачи расположены по цене и сроку.</p>}
  {summary.notes.map(note=><p className="source-banner" key={note}>{note}</p>)}
 </div>;
 return <div className="work-report">
  <p className="report-period"><strong>{date(summary.from)} — {date(summary.to)} МСК</strong></p>
  {!!filters.length&&<p className="report-filters">{filters.join(' / ')}</p>}
  {creator&&<>
   <h3>Мои поставленные задачи</h3>
   {cards([
    {label:'Открыты',count:creator.openIds.length,subset:'creator_open'},
    {label:'Были действия за период',count:creator.movedIds.length,subset:'creator_moved'},
    {label:'Просрочены без действий за период',count:creator.idleOverdueIds.length,subset:'creator_idle'},
    ...(queue?[{label:'Ждут моего решения',count:creator.myDecisionIds.length,subset:'creator_decision'}]:[]),
   ])}
  </>}
  <h3>Что требует внимания</h3>
  {cards([
   {label:'Просрочены с прошлых дней',count:report.metrics.overdue,subset:'overdue'},
   {label:'Срок истёк сегодня',count:summary.elapsedToday,subset:'elapsed_today'},
   {label:'Ещё есть время сегодня',count:Math.max(0,report.metrics.today-summary.elapsedToday),subset:'due_later_today'},
   {label:'Ждёт приёмки',count:report.metrics.review,subset:'review'},
   ...(queue?.decisionIds.length?[{label:'Ждут решения по заявке',count:queue.decisionIds.length,subset:'approval_decision'}]:[]),
   ...(queue?.clarificationIds.length?[{label:'Ждут ответа на уточнение',count:queue.clarificationIds.length,subset:'approval_clarification'}]:[]),
  ])}
  <h3>Результаты за период</h3>
  {cards([
   {label:'Завершены',count:summary.activity.closed,subset:'closed'},
   {label:'Сданы на приёмку',count:summary.activity.submitted,subset:'submitted'},
   {label:outcomes?'Срок изменён':'Переносы и объяснения',count:summary.activity.transfers,subset:outcomes?'transferred':undefined},
   ...(outcomes?[{label:'Запрошен перенос',count:outcomes.requestedTransferIds.length,subset:'requested_transfer'}]:[]),
   {label:'Дано объяснение',count:summary.activity.answers,subset:outcomes?'explained':undefined},
   ...(creator?[{label:'Закрыты в срок',count:creator.closedOnTimeIds.length,subset:'creator_on_time'},
    {label:'Закрыты после срока',count:creator.closedLateIds.length,subset:'creator_late'}]:[]),
  ])}
  {!!summary.team.length&&<><h3>По задачам сотрудников</h3>
   <div className="table-scroll"><table><thead><tr><th>Исполнитель</th><th>Просрочено ранее</th><th>Закрыто</th><th>Сдано</th><th>Срок изменён</th></tr></thead>
    <tbody>{summary.team.map(person=><tr key={person.id}><th scope="row">{person.name}</th><td>{person.overdue}</td><td>{person.closed}</td><td>{person.submitted}</td><td>{person.transfers}</td></tr>)}</tbody>
   </table></div>
  </>}
  {report.kind==='daily'&&!creator&&<><h3>Следующий рабочий день · {summary.tomorrow.day}</h3>
   <p>Просрочены к началу дня · {summary.tomorrow.overdue}. Срок в этот день · {summary.tomorrow.today}.</p>
   <a className="button secondary" href={link('tomorrow')}>Открыть рабочий список · {summary.tomorrow.total}</a>
  </>}
  <details className="report-more"><summary>Утренний список, цены и динамика</summary>
   {summary.front.capturedAt&&<><h3>Утренний список · {date(summary.front.capturedAt)} МСК</h3>
    {cards([{label:'Было утром',count:summary.front.total,subset:'expected'},{label:'Завершено из списка',count:summary.front.closed,subset:'front_closed'},
     {label:'Осталось открыто',count:summary.front.remaining,subset:'remaining'},{label:'Из них ждут приёмки',count:summary.front.submitted}])}
   </>}
   <h3>Задачи по цене</h3>
   {cards(Object.entries(summary.prices).map(([price,count])=>({label:priceLabels[price as keyof typeof priceLabels],count,subset:'all',price})))}
   {summary.previous&&<p><a className="text-button" href={reportLink(workspaceUrl(),summary.previous.id)}>Предыдущий отчёт от {date(summary.previous.at)} МСК</a></p>}
   {summary.trend.some(point=>point.closed||point.submitted)&&<><h3>Динамика завершений</h3>
    <div className="closure-trend"><div className="trend-bars">{summary.trend.map(point=><div key={point.label}>
     <strong>{point.closed}</strong><span className="trend-bar-space"><i style={{height:Math.max(2,point.closed/Math.max(1,...summary.trend.map(p=>p.closed))*75)+'px'}}/></span><small>{point.label}</small>
    </div>)}</div></div>
   </>}
  </details>
  {summary.notes.map(note=><p className="source-banner" key={note}>{note}</p>)}
 </div>;
}
