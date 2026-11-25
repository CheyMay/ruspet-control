import type {Report} from '../shared/types.js';
import {reportKindLabels,reportViewLabels} from '../shared/report-parameters.js';
import {teamScopeLabels} from '../shared/team-scopes.js';
import {priceLabels} from '../shared/pricing.js';
import {taskLink,reportLink,type ReportLink} from '../shared/report-links.js';
export function publicOrigin(){const url=new URL(process.env.PUBLIC_ORIGIN||'https://cheymay.ru');if(!['https:','http:'].includes(url.protocol))throw Error('Invalid PUBLIC_ORIGIN');return url.origin;}
const date=(s:string)=>new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});
export function reportText(r:Report,includeTeam=true){
 const view=r.parameters?.view;
 const viewLabel=view==='team'&&r.scope.startsWith('sales-team:')?teamScopeLabels.team:view&&reportViewLabels[view];
 const title=reportKindLabels[r.kind||'snapshot']+(viewLabel?' · '+viewLabel:'');
 const s=r.summary;if(!s)return {text:`${title}\nСоздан: ${date(r.created_at)} МСК\nВсего: ${r.metrics.total}\nПросрочки: ${r.metrics.overdue}\nСегодня: ${r.metrics.today}\nПриёмка: ${r.metrics.review}`,links:[] as ReportLink[]};
 if(!s.stateAvailable)return {text:`${title}\n${date(s.from)} — ${date(s.to)} МСК\nСостояние задач на выбранное время недоступно. Числовые показатели не рассчитаны.\n${s.notes.join('\n')}`,links:[] as ReportLink[]};
 const lines=[title,`${date(s.from)} — ${date(s.to)} МСК`];
 const links:ReportLink[]=[],origin=publicOrigin(),base={owner:r.parameters?.assigneeId,report:r.id};
 const add=(label:string,count:number,subset?:string)=>{
  const text=label+' · '+count;
  lines.push(text);
  if(subset&&count)links.push({text,url:taskLink(origin,{...base,subset,...(subset==='tomorrow'?{day:s.tomorrow.day,sort:'work_priority'}:{})})});
 };
 lines.push(...Object.entries(s.filters||{}).filter(([,value])=>value).map(([label,value])=>label+' · '+String(value).slice(0,70)));
 if(r.kind==='nextday'){
  const day=new Date(s.tomorrow.day+'T12:00:00+03:00').toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',timeZone:'Europe/Moscow'});
  lines.push('',day);
  add('Просрочки к началу дня',s.tomorrow.overdue);
  add('Крайний срок в этот день',s.tomorrow.today);
  add('Открыть рабочий список',s.tomorrow.total,'tomorrow');
  lines.push(...s.notes.map(note=>'\n'+note));
  return {text:lines.join('\n'),links};
 }
 const creator=s.creatorProgress;
 if(creator){
  lines.push('','Мои поставленные задачи');
  add('Открыты',creator.openIds.length,'creator_open');
  add('Были действия за период',creator.movedIds.length,'creator_moved');
  add('Просрочены без действий за период',creator.idleOverdueIds.length,'creator_idle');
  if(s.approvalQueue)add('Ждут моего решения',creator.myDecisionIds.length,'creator_decision');
 }
 lines.push('','Что требует внимания');
 add('Просрочены с прошлых дней',r.metrics.overdue,'overdue');
 add('Срок истёк сегодня',s.elapsedToday,'elapsed_today');
 add('Ещё есть время сегодня',Math.max(0,r.metrics.today-s.elapsedToday),'due_later_today');
 add('Ждёт приёмки',r.metrics.review,'review');
 if(s.approvalQueue?.decisionIds.length)add('Ждут решения по заявке',s.approvalQueue.decisionIds.length,'approval_decision');
 if(s.approvalQueue?.clarificationIds.length)add('Ждут ответа на уточнение',s.approvalQueue.clarificationIds.length,'approval_clarification');
 lines.push('','Результаты за период');
 add('Завершены',s.activity.closed,'closed');
 add('Сданы на приёмку',s.activity.submitted,'submitted');
 add(s.outcomes?'Срок изменён':'Переносы и объяснения',s.activity.transfers,s.outcomes?'transferred':undefined);
 if(s.outcomes)add('Запрошен перенос',s.outcomes.requestedTransferIds.length,'requested_transfer');
 add('Дано объяснение',s.activity.answers,s.outcomes?'explained':undefined);
 if(creator){
  add('Закрыты в срок',creator.closedOnTimeIds.length,'creator_on_time');
  add('Закрыты после срока',creator.closedLateIds.length,'creator_late');
 }
 if(r.kind==='daily'&&!creator){
  lines.push('',`Следующий рабочий день · ${s.tomorrow.day}`);
  add('Предстоит',s.tomorrow.total,'tomorrow');
 }
 if(includeTeam&&s.team.length){
  lines.push('','По задачам сотрудников');
  const people=[...s.team].sort((a,b)=>b.overdue-a.overdue||b.closed-a.closed);
  for(const t of people.slice(0,8))lines.push(`${t.name.slice(0,70)} · просрочено ${t.overdue}, закрыто ${t.closed}, сдано ${t.submitted}`);
  if(people.length>8)lines.push('Полная сводка сотрудников доступна в PDF и на сайте.');
 }
 if(!includeTeam){
  if(s.front.capturedAt)lines.push('',`Утренний список · было ${s.front.total}, завершено ${s.front.closed}, открыто ${s.front.remaining}`);
  lines.push('', 'По цене',...Object.entries(s.prices).map(([price,count])=>priceLabels[price as keyof typeof priceLabels]+' · '+count));
 }
 lines.push(...s.notes.map(n=>'\n'+n));return {text:lines.join('\n'),links};
}
