import {businessDay} from './queues.js';
export type ScheduleConfig={enabled:boolean;morning:string;evening:string};
export const jobLabel=(key:string)=>key.includes('morning:')?'Общий отчёт':key.includes('evening:')?'Итоги и работа на завтра':key.startsWith('initial:')?'Начальный снимок':'Напоминания';
export function nextRuns(config:ScheduleConfig,now:Date,finished:Set<string>){
 if(!config.enabled)return [];
 const day=businessDay(now),result:{key:string;label:string;at:string;late:boolean}[]=[];
 for(const kind of ['morning','evening'] as const){for(let offset=0;offset<8;offset++){
  const d=new Date(Date.parse(day+'T12:00:00+03:00')+offset*86400000);if([0,6].includes(d.getUTCDay()))continue;
  const key=kind+':'+businessDay(d);if(finished.has(key))continue;
  const at=new Date(businessDay(d)+'T'+config[kind]+':00+03:00');result.push({key,label:jobLabel(key),at:at.toISOString(),late:at<now});break;
 }}return result.sort((a,b)=>a.at.localeCompare(b.at));
}
