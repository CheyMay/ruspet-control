import {businessDay} from '../shared/queues.js';

export type VoiceKind='create_task'|'comment'|'submit'|'deadline'|'accept'|'return'|'approve'|'reject'|'clarify'|'clarification'|'answer'
 |'edit_title'|'edit_description'|'edit_price'|'edit_assignee'|'delegate'|'reminder_once'|'reminder'|'reminder_cancel_voice'|'undo';
export type VoiceIntent={id?:string;lookup?:string;kind:VoiceKind;values:Record<string,string>};

const taskPrefix=String.raw`(?:(?:к|по|для|в|у)\s+)?(?:(?:эту|этой)\s+)?(?:задач[ауеиё]\s*)?(?:номер\s*)?[#№]?\s*`;
const idPattern=String.raw`(L[-– ]?[0-9a-f]{8}|\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d{1,18})`;
const taskId=new RegExp('^'+taskPrefix+idPattern+'(?=$|[\\s,.;:—–-])','iu');
const months='января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ');
const weekdays=['понедельник','вторник','сред','четверг','пятниц','суббот','воскресень'];
const words='ноль один два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать семнадцать восемнадцать девятнадцать двадцать'.split(' ');
const weekWord=String.raw`понедельник(?:ам)?|вторник(?:ам)?|сред(?:у|а|ам)|четверг(?:ам)?|пятниц(?:у|а|ам)|суббот(?:у|а|ам)|воскресень(?:е|ям)`;
const clean=(value:string)=>value.trim().replace(/^[\s,.;:—–-]+/u,'');
const stripPeriod=(value:string)=>value.trim().replace(/[.;]+$/u,'');
const nextDay=(now:Date,n:number)=>businessDay(new Date(now.getTime()+n*86400000));
const dateLabel=(day:string)=>day.split('-').reverse().join('.');

export function spokenTime(value:string){
 const match=value.match(new RegExp(String.raw`^(?:в\s+|к\s+|до\s+)?(\d{1,2}|${words.join('|')}|час)(?::(\d{2})|\s+час(?:а|ов)?(?:\s+(\d{1,2})\s+минут(?:а|ы)?)?)?(?:\s+(утра|дня|вечера|ночи))?(?=$|[\s.,;:])`,'iu'));
 if(!match)return null;
 const [,hourText,minutes,spokenMinutes,period]=match;
 let hours=/^\d+$/.test(hourText)?Number(hourText):hourText.toLowerCase()==='час'?1:words.indexOf(hourText.toLowerCase());
 const mins=Number(minutes??spokenMinutes??0);
 if(period&&hours<12&&['вечера','дня'].includes(period.toLowerCase()))hours+=12;
 if(period&&hours===12&&['ночи','утра'].includes(period.toLowerCase()))hours=0;
 if(hours<0||hours>23||mins>59)return null;
 return {time:String(hours).padStart(2,'0')+':'+String(mins).padStart(2,'0'),rest:clean(value.slice(match[0].length))};
}

export function spokenDeadline(value:string,now=new Date(),baseDay?:string){
 const raw=value.trim();
 const relative=raw.match(new RegExp(String.raw`^через\s+(\d{1,4}|${words.join('|')}|час)\s*(минут(?:а|ы)?|час(?:а|ов)?)?(?=$|[\s.,;:])`,'iu'));
 if(relative&&(relative[2]||relative[1].toLowerCase()==='час')){
  const amount=Number(relative[1])||words.indexOf(relative[1].toLowerCase());
  const minutes=relative[1].toLowerCase()==='час'?60:amount*(relative[2]?.toLowerCase().startsWith('час')?60:1);
  if(minutes>0&&minutes<=10080){
   const due=new Date(Math.ceil((+now+minutes*60000)/60000)*60000);
   const day=dateLabel(businessDay(due)),time=new Date(+due+10800000).toISOString().slice(11,16);
   return {day,stamp:day+' '+time,rest:clean(raw.slice(relative[0].length))};
  }
 }
 const dayMatch=raw.match(new RegExp(String.raw`^(?:на\s+|до\s+|в\s+)?(сегодня|завтра|послезавтра|\d{1,2}\.\d{1,2}(?:\.\d{4})?|\d{1,2}\s+(?:${months.join('|')})(?:\s+\d{4})?|${weekWord})(?=$|[\s,.;:])`,'iu'));
 if(!dayMatch&&!baseDay)return null;
 let day=baseDay!;
 if(dayMatch){
  const name=dayMatch[1].toLocaleLowerCase('ru-RU'),relative=['сегодня','завтра','послезавтра'].indexOf(name);
  const weekday=weekdays.findIndex(part=>name.startsWith(part));
  if(relative>=0)day=dateLabel(nextDay(now,relative));
  else if(weekday>=0){
   const current=(new Date(now.getTime()+10800000).getUTCDay()+6)%7;
   day=dateLabel(nextDay(now,(weekday-current+7)%7||7));
  }else{
   const [date,month,year=businessDay(now).slice(0,4)]=name.split(/[.\s]+/u);
   day=date.padStart(2,'0')+'.'+(months.includes(month)?String(months.indexOf(month)+1):month).padStart(2,'0')+'.'+year;
  }
 }
 const tail=clean(dayMatch?raw.slice(dayMatch[0].length):raw),time=spokenTime(tail);
 return {day,stamp:time?day+' '+time.time:undefined,rest:time?.rest??tail};
}

export function spokenPrice(value:string){
 const amount=stripPeriod(value).replace(/\s+руб(?:лей|ля|ль)?$/iu,'').trim();
 const scaled=amount.match(/^(\d+(?:[.,]\d+)?)\s*(тыс(?:яч[аиу]?)?\.?|миллион(?:а|ов)?|млн\.?)$/iu);
 if(scaled)return String(Number(scaled[1].replace(',','.'))*(scaled[2].toLowerCase().startsWith('тыс')?1000:1000000));
 const numbers:Record<string,number>={
  одна:1,две:2,полтора:1.5,полторы:1.5,тридцать:30,сорок:40,пятьдесят:50,шестьдесят:60,семьдесят:70,восемьдесят:80,девяносто:90,
  сто:100,двести:200,триста:300,четыреста:400,пятьсот:500,шестьсот:600,семьсот:700,восемьсот:800,девятьсот:900,
 };
 let total=0,group=0,last=Infinity,scaleLimit=Infinity;
 for(const word of amount.toLocaleLowerCase('ru-RU').split(/\s+/u)){
  const scale=/^тысяч(?:а|и|у)?$/u.test(word)?1000:/^миллион(?:а|ов)?$/u.test(word)?1000000:0;
  if(scale){
   if(scale>=scaleLimit)return amount;
   total+=(last===Infinity?1:group)*scale;group=0;last=Infinity;scaleLimit=scale;continue;
  }
  const number=numbers[word]??words.indexOf(word),place=number>=100?100:number>=20?10:1;
  if(number<0||place>=last)return amount;
  group+=number;last=place;
 }
 return String(total+group);
}

function fields(text:string,names:Record<string,string>,loose?:(key:string,tail:string)=>boolean){
 const pattern=new RegExp(String.raw`(?:^|[.;\n,]\s*|\s+)(${Object.keys(names).join('|')})(?:\s*[:—–-]\s*|\s+)`,'giu');
 const starts=[...text.matchAll(pattern)].filter(match=>{
  const key=names[match[1].toLocaleLowerCase('ru-RU')];
  return match.index===0||/[.;\n,:—–-]/.test(match[0])||loose?.(key,text.slice(match.index+match[0].length));
 }),values:Record<string,string>={};
 for(let i=0;i<starts.length;i++){
  const match=starts[i],value=clean(text.slice(match.index+match[0].length,starts[i+1]?.index));
  if(value)values[names[match[1].toLocaleLowerCase('ru-RU')]]=stripPeriod(value);
 }
 return {initial:stripPeriod(text.slice(0,starts[0]?.index??text.length)),values};
}

function createIntent(text:string,now:Date):VoiceIntent|null{
 const command=text.match(/^(?:поставь(?:те)?|создай(?:те)?|назначь(?:те)?|поставить|создать)\s+(?:(себе|мне)\s+)?(?:новую\s+)?задачу(?=$|[\s,:.])/iu);
 if(!command)return null;
 let rest=clean(text.slice(command[0].length)),assignee=command[1];
 const self=rest.match(/^(себе|мне)(?=$|[\s,:.])/iu);
 if(self){assignee=self[1];rest=clean(rest.slice(self[0].length));}
 const labels={'название':'title','описание':'description','исполнитель':'assignee','кому':'assignee','крайний срок':'deadline','срок':'deadline','цена задачи':'price','цена':'price','стоимость':'price'};
 const {initial,values}=fields(rest,labels,(key,tail)=>{
  if(key==='deadline')return /^без срока(?:\s|$)/iu.test(tail)||!!spokenDeadline(tail,now)?.day;
  if(key==='price')return /^(?:\d|(?:тысяча|миллион|одна|две|полторы)(?=\s|$))/iu.test(tail)||words.includes(tail.split(/\s/u,1)[0].toLocaleLowerCase('ru-RU'));
  return key==='assignee';
 });
 const separated=initial.match(/^([^:]{2,70}):\s*(.+)$/su);
 if(!assignee&&!values.assignee&&separated&&!/\d/.test(separated[1]))assignee=separated[1].trim();
 if(!values.title&&initial)values.title=assignee&&separated?separated[2]:initial;
 if(assignee&&!values.assignee)values.assignee=assignee;
 if(values.price)values.price=spokenPrice(values.price);
 if(values.deadline&&!/^без срока$/iu.test(values.deadline)){
  const parsed=spokenDeadline(values.deadline,now);
  if(parsed?.day)values.dueDay=parsed.day;
  values.deadline=parsed?.stamp||values.deadline;
 }
 return {kind:'create_task',values};
}

function recurringReminder(tail:string):Record<string,string>|null{
 if(!/^(?:кажд\p{L}*(?=\s|$)|по\s+будням|по\s+(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень))/iu.test(tail))return null;
 const days=/будням/iu.test(tail)?[1,2,3,4,5]:weekdays.flatMap((day,index)=>tail.toLocaleLowerCase('ru-RU').includes(day)?[index+1]:[]);
 const timePart=(tail.match(/\s(?:в|к)\s+(.+)$/iu)?.[1]||'').split(/\s+(?:на|в течение)\s+/iu)[0];
 const times=timePart.split(/\s*(?:,|\s+и\s+)\s*/u).map(value=>spokenTime(value.trim()));
 const week=tail.match(/(?:на|в течение)\s+(\d{1,2}|одну|две|три|четыре)\s+недел[юиь]/iu)?.[1];
 const lengths:Record<string,string>={одну:'1',две:'2',три:'3',четыре:'4'};
 return {...(days.length?{days:days.join(',')}:{}),...(times.length&&times.every(time=>time&&!time.rest)?{times:times.map(time=>time!.time).join(',')}:{}),...(week?{weeks:lengths[week.toLowerCase()]||week}:{})};
}

const actions:{kind:VoiceKind;pattern:string}[]=[
 {kind:'reminder_cancel_voice',pattern:'(?:отмени(?:те)?|отключи(?:те)?|убери(?:те)?) (?:напоминание|напоминания)'},
 {kind:'undo',pattern:'(?:отмени(?:те)?|верни(?:те)?) последнее действие'},
 {kind:'delegate',pattern:'делегируй(?:те)?|делегировать'},
 {kind:'edit_assignee',pattern:'(?:смени(?:те)?|поменяй(?:те)?|измени(?:те)?) исполнителя|переназначь(?:те)?'},
 {kind:'edit_title',pattern:'(?:измени(?:те)?|поменяй(?:те)?|смени(?:те)?) название|переименуй(?:те)?'},
 {kind:'edit_description',pattern:'(?:измени(?:те)?|поменяй(?:те)?|обнови(?:те)?) описание'},
 {kind:'edit_price',pattern:'(?:измени(?:те)?|поменяй(?:те)?|обнови(?:те)?) цену'},
 {kind:'comment',pattern:'(?:(?:добавь(?:те)?|добавить|оставь(?:те)?|оставить|запиши(?:те)?|напиши(?:те)?) )?(?:комментарий|коммент|заметку)'},
 {kind:'submit',pattern:'закрой(?:те)?|закрыть|сдай(?:те)?(?: результат)?|сдать|заверши(?:те)?|передай(?:те)? на при[её]мку'},
 {kind:'deadline',pattern:'(?:перенеси(?:те)?|перенести|сдвинь(?:те)?)(?: срок)?|предложи(?:те)? (?:новый )?срок'},
 {kind:'accept',pattern:'прими(?:те)?(?: (?:результат|работу))?'},
 {kind:'return',pattern:'верни(?:те)?(?: в работу| на доработку)?|возврати(?:те)?'},
 {kind:'approve',pattern:'согласуй(?:те)?(?: перенос| срок| закрытие)?|одобри(?:те)?(?: перенос| закрытие)?'},
 {kind:'reject',pattern:'отклони(?:те)?(?: перенос| срок| закрытие| согласование)?'},
 {kind:'clarify',pattern:'уточни(?:те)?(?: согласование| перенос)?|запроси(?:те)? уточнение'},
 {kind:'clarification',pattern:'ответь(?:те)? на уточнение'},
 {kind:'answer',pattern:'ответь(?:те)? на запрос|дай(?:те)? объяснение'},
 {kind:'reminder_once',pattern:'напомни(?:те)?(?: мне)?|(?:создай(?:те)?|поставь(?:те)?) напоминание'},
];

function spokenTarget(rest:string,kind:VoiceKind){
 const marker=/^(?:(?:к|по|для|в)\s+)?задач[ауеиё]\s+(?:(?:по|для|про)\s+)?|^(?:по|для)\s+/iu.exec(rest);
 const client=/^(?:клиент[ауе]?|компани[яию])\s+/iu.exec(rest.slice(marker?.[0].length??0));
 const text=rest.slice((marker?.[0].length??0)+(client?.[0].length??0));
 const quoted=/^[«"“]([^»"”]+)[»"”]/u.exec(text);
 const deadline=/\s+(?=(?:на|до|к|в)\s+(?:сегодня|завтра|послезавтра|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|\d)|(?:сегодня|завтра|послезавтра|через|кажд\p{L}*|по\s+будням)(?:\s|$))/iu;
 const detail=/\s+(?=(?:причина|план|сделано|комментарий|результат|вопрос|поручение)\s*[:—–-])/iu;
 const separator=/[:;!?]|\.(?=\s|$)|,\s| \s*[—–]\s*/u;
 const breaks=[text.search(separator),text.search(detail)];
 if(kind==='deadline'||kind==='reminder_once')breaks.push(text.search(deadline));
 if(kind==='edit_assignee'||kind==='edit_title'||kind==='edit_description'||kind==='edit_price')breaks.push(text.search(/\s+на\s+/iu));
 const end=quoted?.[0].length??Math.min(...breaks.filter(index=>index>=0),text.length);
 if(!marker&&!client&&!quoted&&!(end<text.length&&/^[:—–]/u.test(text.slice(end).trim())))return null;
 const lookup=stripPeriod(quoted?.[1]??text.slice(0,end)).trim();
 if(!lookup||/^(?:номер|этой|эту|текущей)(?:\s|$)/iu.test(lookup)||
  /^(?:на|до|в)\s+(?:сегодня|завтра|послезавтра|\d)/iu.test(lookup))return null;
 return {lookup:lookup.slice(0,150),tail:clean(text.slice(end))};
}

export function parseVoiceIntent(transcript:string,now=new Date(),currentTaskId?:string):VoiceIntent|null{
 const text=transcript.trim().replace(/^(?:пожалуйста[,\s]+|можешь[,\s]+)+/iu,'').replace(/^(поставь|создай|добавь|оставь|сдай|перенеси|закрой|напомни),\s+пожалуйста[,\s]+/iu,'$1 ');
 if(!text||text.length>4000)return null;
 const creation=createIntent(text,now);if(creation)return creation;
 for(const action of actions){
  const command=text.match(new RegExp('^(?:'+action.pattern+')(?=$|[\\s,.;:—–-])','iu'));
  if(!command)continue;
  const rest=clean(text.slice(command[0].length));
  const target=rest.match(taskId);
  const named=target||/^(?:(?:по|к|для|в)\s+)?(?:эту|этой|текущей)\s+задач[ауеи]/iu.test(rest)?null:spokenTarget(rest,action.kind);
  if(!target&&!named&&/^(?:(?:к|по|для|в)\s+)?(?:задач[ауеиё]\s+номер\s+|номер\s+|[#№]\s*)\S/iu.test(rest))continue;
  const id=target?.[1]?.replace(/[ \u00a0\u202f]/g,'');
  const explicit=id?.toLowerCase().startsWith('l')?'L-'+id.slice(1).replace(/^[-–]/,'').toLowerCase():id;
  const chosen=explicit||(named?undefined:currentTaskId);
  let tail=named?.tail??clean(target?rest.slice(target[0].length):rest.replace(/^(?:(?:по|к|для)\s+)?(?:эту|этой|текущей)\s+задач[ауеи](?=$|[\s,.;:])/iu,''));
  if(/^и\s+(?:задачу\s+)?[#№]?\d/iu.test(tail)&&action.kind!=='comment')return null;
  let kind=action.kind;
  const values:Record<string,string>={};
  if(kind==='reminder_once'){
   const recurrence=recurringReminder(tail);
   if(recurrence){kind='reminder';Object.assign(values,recurrence);}
  }
  if(kind==='deadline'||kind==='reminder_once'){
   const due=spokenDeadline(tail,now,kind==='reminder_once'?dateLabel(businessDay(now)):undefined);
   if(due?.day)values.dueDay=due.day;
   if(due?.stamp)values.deadline=due.stamp;
   tail=due?.rest??tail;
  }
  const structured=kind==='deadline'||kind==='answer';
  const labeled=fields(tail,{причина:'reason',план:'plan',сделано:'progress',комментарий:'comment',результат:'comment',вопрос:'comment',поручение:'instruction'},
   key=>structured&&['reason','plan','progress'].includes(key));
  Object.assign(values,labeled.values);
  if(kind==='comment'||['submit','accept','return','approve','reject','clarify'].includes(kind)){
   if(labeled.initial&&!values.comment)values.comment=Object.keys(labeled.values).length?labeled.initial:tail;
  }
  if(kind==='deadline'&&!values.reason&&labeled.initial)values.reason=labeled.initial;
  if(kind==='clarification'&&labeled.initial)values.answer=labeled.initial;
  if(kind==='edit_title'||kind==='edit_description')values.value=stripPeriod(labeled.initial.replace(/^на\s+/iu,''));
  if(kind==='edit_price')values.price=spokenPrice(labeled.initial.replace(/^на\s+/iu,''));
  if(kind==='edit_assignee'||kind==='delegate')values.assignee=stripPeriod(labeled.initial.replace(/^(?:на|для)\s+/iu,''));
  return {id:chosen,...(named?{lookup:named.lookup}:{}),kind,values};
 }
 return null;
}
