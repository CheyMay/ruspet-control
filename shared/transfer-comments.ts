import type {DeadlineTransfer,DeadlineTransferComment} from './types.js';

const transferWords=/перен[еёо][\p{L}]*|продл[\p{L}]*|сдвиг[\p{L}]*|(?:новый|крайний) срок|срок согласован|измен[\p{L}]*\s+(?:крайний\s+)?срок/iu;
const deadlineRequest=/(?:измен|перен[еёо]|продл)[\p{L}]*\s+(?:крайний\s+)?срок/iu;
const reasonHeader=/^(?:причина|основание)(?:\s+переноса)?\s*[:—-]/iu;
const contextWords=/жд[её]м|ожида[\p{L}]*|в связи с|потому что|так как|задерж[\p{L}]*|не успе[\p{L}]*/iu;
const delayedWork=/нет\s+(?:оплат|заказ|ответ|сырь|свет|возможност)|не\s+(?:удалось|поступил[аио]?|было|смог[лои]*)|обещал[аи]?\s+(?:оплатить|перезвонить|прислать)/iu;
const moscowDay=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
const moscowName=(value:string)=>value.toLowerCase().replaceAll('ё','е').split(/\s+/).filter(Boolean).sort().join(' ');
const dayMs=86400000,minuteMs=60000;

function cleanMessage(body:string){
 return body.replace(/\[ruspet:[a-f\d-]+\]/gi,'')
  .replace(/\[TIMESTAMP=(\d{10})(?:\s+[^\]]+)?\]/gi,(_,stamp)=>moscowDay.format(new Date(Number(stamp)*1000)))
  .replace(/\[\/?(?:B|I|U|S|USER|URL|QUOTE|SIZE|COLOR|P)(?:=[^\]]*)?\]/gi,'')
  .trim();
}

function statedDates(text:string,preferRequested:boolean){
 const all=[...text.matchAll(/(?<![\d.])(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])(?:\.0?(20\d\d|\d\d))?(?!\d|\.\d)/g)];
 const requested=preferRequested?all.filter(date=>{
  const prefix=text.slice(Math.max(0,date.index-50),date.index);
  return transferWords.test(prefix)&&/(?:срок(?:\s+(?:на|до|к))?|(?:перенест|перенос|измен)[\p{L}]*(?:\s+на)?)\s*[:—-]?\s*$/iu.test(prefix);
 }):[];
 return (requested.length?requested:all).map(([,day,month,year])=>
  day.padStart(2,'0')+'.'+month.padStart(2,'0')+(year?'.'+(year.length===2?'20'+year:year):''));
}

function resultCandidates(transfers:DeadlineTransfer[],text:string,at:number,explicit:boolean,dates:string[]){
 const next=transfers.filter(item=>{
  const delta=Date.parse(item.occurredAt)-at;
  return delta>=-30*minuteMs&&delta<=14*dayMs;
 });
 if(dates.length){
  const exact=next.filter(item=>{
   if(!item.to||Date.parse(item.to)<at)return false;
   const finalDate=moscowDay.format(new Date(item.to));
   return dates.includes(finalDate)||dates.includes(finalDate.slice(0,5));
  });
  if(exact.length||!deadlineRequest.test(text))return exact;
  // An explicit request can precede a decision for the adjacent calendar day.
  return next.filter(item=>{
   const delta=Date.parse(item.occurredAt)-at;
   if(!item.to||Date.parse(item.to)<at||delta<0||delta>120*minuteMs)return false;
   return [-dayMs,dayMs].some(offset=>{
    const day=moscowDay.format(new Date(Date.parse(item.to!)+offset));
    return dates.includes(day)||dates.includes(day.slice(0,5));
   });
  });
 }
 if(!explicit&&!contextWords.test(text)&&!delayedWork.test(text))return [];
 return next.filter(item=>{
  const delta=Date.parse(item.occurredAt)-at;
  return delta>=0&&delta<=36*60*minuteMs;
 });
}

export function matchTransferComments(transfers:DeadlineTransfer[],comments:DeadlineTransferComment[]){
 const sorted=[...comments].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id));
 const matched=new Map<string,DeadlineTransferComment[]>();
 for(const comment of sorted){
  const text=cleanMessage(comment.text);
  if(!text||/^РУСПЭТ\s*·/iu.test(text))continue;
  const explicit=transferWords.test(text),reason=reasonHeader.test(text),result=comment.source==='result';
  if(!result&&(comment.author==='Битрикс24'||comment.author==='Система')&&!(explicit&&reason))continue;
  const dates=explicit||reason||result?statedDates(text,result):[];
  const at=Date.parse(comment.occurredAt);
  if(!Number.isFinite(at))continue;
  const candidates=result?resultCandidates(transfers,text,at,explicit,dates):transfers.filter(item=>{
   const delta=Math.abs(at-Date.parse(item.occurredAt));
   if(dates.length){
    if(!item.to||delta>14*dayMs)return false;
    const finalDate=moscowDay.format(new Date(item.to));
    return dates.includes(finalDate)||dates.includes(finalDate.slice(0,5));
   }
   const sameAuthor=moscowName(item.author)===moscowName(comment.author);
   return explicit&&(sameAuthor||reason)&&delta<=30*minuteMs||sameAuthor&&(reason&&delta<=15*minuteMs||contextWords.test(text)&&delta<=5*minuteMs);
  });
  if(candidates.length!==1)continue;
  const target=candidates[0],notes=matched.get(target.id)??[];
  if(notes.some(note=>note.text===text)||target.reason===text||target.reason&&text.replace(reasonHeader,'').trim()===target.reason)continue;
  notes.push({...comment,text});
  matched.set(target.id,notes);
 }
 return transfers.map(item=>{
  const notes=matched.get(item.id);
  return notes?{...item,comments:notes}:item;
 });
}
