import type {Report} from '../shared/types.js';
import {reportKindLabels,reportViewLabels} from '../shared/report-parameters.js';
import {priceLabels} from '../shared/pricing.js';
import {taskLink,reportLink,type ReportLink} from '../shared/report-links.js';
export function publicOrigin(){const url=new URL(process.env.PUBLIC_ORIGIN||'https://cheymay.ru');if(!['https:','http:'].includes(url.protocol))throw Error('Invalid PUBLIC_ORIGIN');return url.origin;}
const date=(s:string)=>new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'});
export function reportText(r:Report,includeTeam=true){
 const title=reportKindLabels[r.kind||'snapshot']+(r.parameters?.view?' · '+reportViewLabels[r.parameters.view]:'');
 const s=r.summary;if(!s)return {text:`${title}\nСоздан: ${date(r.created_at)} МСК\nВсего: ${r.metrics.total}\nПросрочки: ${r.metrics.overdue}\nСегодня: ${r.metrics.today}\nПриёмка: ${r.metrics.review}`,links:[] as ReportLink[]};
 if(!s.stateAvailable)return {text:`${title}\n${date(s.from)} — ${date(s.to)} МСК\nСостояние задач на выбранное время недоступно. Числовые показатели не рассчитаны.\n${s.notes.join('\n')}`,links:[] as ReportLink[]};
 const lines=[title,`${date(s.from)} — ${date(s.to)} МСК`,s.previous?'Предыдущий отчёт: '+date(s.previous.at)+' МСК':'Предыдущего отчёта с такими параметрами за этот день нет.',`Просрочки: ${r.metrics.overdue}`,`Сегодня: ${r.metrics.today}`,`Истекло сегодня: ${s.elapsedToday}`,`Приёмка: ${r.metrics.review}`,`Без срока: ${r.analysis?.counts.no_deadline||0}`,`Обработано: ${s.activity.processed}`,`Закрыто за период: ${s.activity.closed}`,`Сдано на приёмку: ${s.activity.submitted}`,`Переносов срока: ${s.activity.transfers}`];
 const named=Object.entries(s.filters||{}).filter(([,value])=>value).map(([label,value])=>label+': '+String(value).slice(0,70));if(named.length)lines.splice(2,0,...named);
 const links:ReportLink[]=[];const base={owner:r.parameters?.assigneeId,report:r.id};
 for(const [text,subset] of [[`Просрочки: ${r.metrics.overdue}`,'overdue'],[`Сегодня: ${r.metrics.today}`,'today'],[`Приёмка: ${r.metrics.review}`,'review'],[`Без срока: ${r.analysis?.counts.no_deadline||0}`,'no_deadline'],[`Обработано: ${s.activity.processed}`,'processed'],[`Закрыто за период: ${s.activity.closed}`,'closed']] as const)links.push({text,url:taskLink(publicOrigin(),{...base,subset})});
 lines.push(`Всего истёкших сроков: ${s.lateIds.length}`,`Из них по цене: ${Object.entries(s.overduePrices).map(([key,n])=>priceLabels[key as keyof typeof priceLabels]+': '+n).join(' · ')}`);
 lines.push('','По цене:');for(const [key,label] of Object.entries(priceLabels)){const labelText=`${label}: ${s.prices[key as keyof typeof s.prices]}`;lines.push(labelText);links.push({text:labelText,url:taskLink(publicOrigin(),{...base,subset:'all',price:key})});}
 if(s.front.capturedAt)lines.push('',`Фронт сохранён: ${date(s.front.capturedAt)} МСК`,`Во фронте: ${s.front.total}`,`Из фронта закрыто: ${s.front.closed}`,`Осталось: ${s.front.remaining}`,`Дополнительно поступило: ${s.front.addedLater}`);
 if(r.kind==='daily'){lines.push('',`Следующий рабочий день: ${s.tomorrow.day}`,`Предстоит: ${s.tomorrow.total}`,`В том числе просрочек: ${s.tomorrow.overdue}`,`Со сроком на этот день: ${s.tomorrow.today}`,'Порядок работы: сначала просрочки, внутри очереди — по цене и ближайшему сроку; затем сроки на день.',Object.entries(s.tomorrow.prices).map(([key,n])=>priceLabels[key as keyof typeof priceLabels]+': '+n).join(' · '));links.push({text:`Предстоит: ${s.tomorrow.total}`,url:taskLink(publicOrigin(),{...base,subset:'tomorrow',day:s.tomorrow.day,sort:'work_priority'})});}
 if(s.previous)lines.push('',`С прошлого отчёта: закрытий ${s.previous.closedChange>=0?'+':''}${s.previous.closedChange}, обработанных ${s.previous.processedChange>=0?'+':''}${s.previous.processedChange}`);
 if(includeTeam&&s.team.length){lines.push('','По сотрудникам:');for(const t of s.team.slice(0,12))lines.push(`${t.name.slice(0,70)}: обработано ${t.processed}, закрыто ${t.closed}, просрочек ${t.overdue}`);if(s.team.length>12)lines.push('Полная сводка сотрудников — в PDF и на сайте.');}
 lines.push(...s.notes.map(n=>'\n'+n));return {text:lines.join('\n'),links};
}
