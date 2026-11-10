import {businessDay} from '../shared/queues.js';

export type VoiceIntent={id:string;kind:'comment'|'submit'|'deadline'|'accept';values:Record<string,string>};
const taskNumber=String.raw`\s+(?:к\s+|по\s+|для\s+|в\s+)?(?:задач[ауеи]\s*)?(?:номер\s*)?[#№]?\s*(\d(?:[ \u00a0-]\d){2,17}|\d{1,3}(?:[ \u00a0]\d{3})+|\d{1,18})(?!\d)`;
const actions=[
 {kind:'comment',pattern:'(?:добавь(?:те)?|добавить|оставь(?:те)?|оставить|запиши(?:те)?|напиши(?:те)?) (?:комментарий|коммент|заметку)|комментарий'},
 {kind:'submit',pattern:'(?:закрой(?:те)?|закрыть|сдай(?:те)?|сдать|заверши(?:те)?|передай(?:те)? на при[её]мку)'},
 {kind:'deadline',pattern:'(?:(?:перенеси(?:те)?|перенести|сдвинь(?:те)?)(?: срок)?|предложи(?:те)? (?:новый )?срок)'},
 {kind:'accept',pattern:'(?:прими(?:те)? (?:результат|работу))'},
] as const;
const clean=(value:string)=>value.trim().replace(/^[\s,.;:—–-]+/u,'');
const months='января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');

function spokenDeadline(value:string,now:Date){
 const pattern=String.raw`^(?:на\s+|до\s+)?(сегодня|завтра|послезавтра|\d{1,2}\.\d{1,2}(?:\.\d{4})?|\d{1,2}\s+(?:${months.join('|')})(?:\s+\d{4})?)\s*,?\s*(?:(?:в|к|до)\s+)?(\d{1,2})(?::(\d{2})|\s+час(?:а|ов)?(?:\s+(\d{1,2})\s+минут(?:а|ы)?)?)(?=$|[\s.,;:])`;
 const match=value.match(new RegExp(pattern,'iu'));
 if(!match)return;
 const [,spokenDay,hour,minutes,spokenMinutes]=match;
 const offsets:Record<string,number>={сегодня:0,завтра:1,послезавтра:2};
 const day=spokenDay.toLowerCase();
 const [first,second,year=businessDay(now).slice(0,4)]=day.split(/[.\s]+/u);
 const [y,m,d]=Object.hasOwn(offsets,day)?businessDay(new Date(now.getTime()+offsets[day]*86400000)).split('-'):
  [year,months.includes(second)?String(months.indexOf(second)+1):second,first];
 const stamp=`${d.padStart(2,'0')}.${m.padStart(2,'0')}.${y} ${hour.padStart(2,'0')}:${(minutes??spokenMinutes??'00').padStart(2,'0')}`;
 return {stamp,rest:clean(value.slice(match[0].length))};
}

export function parseVoiceIntent(transcript:string,now=new Date()):VoiceIntent|null{
 const text=transcript.trim().replace(/^(?:пожалуйста[,\s]+|можешь[,\s]+)+/iu,'');
 if(text.length>4000)return null;
 for(const {kind,pattern} of actions){
  const match=text.match(new RegExp(String.raw`^(?:${pattern})${taskNumber}(?=$|[\s,.;:—–-])`,'iu'));
  if(!match)continue;
  const id=match[1].replace(/\D/g,''),tail=clean(text.slice(match[0].length));
  // A second explicit task reference makes the intended target ambiguous.
  if(/(?:[#№]\s*|задач[ауеи]\s+(?:номер\s*)?)\d/iu.test(tail))return null;
  if(kind==='deadline'){
   const due=spokenDeadline(tail,now),rest=due?.rest??tail;
   const reason=rest.match(/(?:^|[.;]\s*)причина\s*[:—–-]?\s*(.+?)(?=[.;]\s*план(?:\s|:)|$)/iu)?.[1];
   const plan=rest.match(/(?:^|[.;]\s*)план\s*[:—–-]?\s*(.+)$/iu)?.[1];
   return {id,kind,values:{...(due?{deadline:due.stamp}:{}),...(reason?{reason:reason.trim()}:{}),...(plan?{plan:plan.trim()}:{})}};
  }
  const comment=tail.replace(/^(?:результат|комментарий)\s*[:—–-]\s*/iu,'');
  return {id,kind,values:comment?{comment}:{}};
 }
 return null;
}
