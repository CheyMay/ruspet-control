import type {DeadlineTransfer,DeadlineTransferComment} from './types.js';

const transferWords=/перен[еёо][\p{L}]*|продл[\p{L}]*|сдвиг[\p{L}]*|(?:новый|крайний) срок|срок согласован/iu;
const reasonHeader=/^(?:причина|основание)(?:\s+переноса)?\s*[:—-]/iu;
const contextWords=/жд[её]м|ожида[\p{L}]*|в связи с|потому что|так как|задерж[\p{L}]*|не успе[\p{L}]*/iu;
const moscowDay=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});
const moscowName=(value:string)=>value.toLowerCase().replaceAll('ё','е').split(/\s+/).filter(Boolean).sort().join(' ');
const dayMs=86400000;

function cleanMessage(body:string){
 return body.replace(/\[ruspet:[a-f\d-]+\]/gi,'')
  .replace(/\[TIMESTAMP=(\d{10})(?:\s+[^\]]+)?\]/gi,(_,stamp)=>moscowDay.format(new Date(Number(stamp)*1000)))
  .replace(/\[\/?(?:B|I|U|S|USER|URL|QUOTE|SIZE|COLOR|P)(?:=[^\]]*)?\]/gi,'')
  .trim();
}

function statedDates(text:string){
 return [...text.matchAll(/(?<![\d.])(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])(?:\.(20\d\d|\d\d))?(?!\d|\.\d)/g)]
  .map(([,day,month,year])=>day.padStart(2,'0')+'.'+month.padStart(2,'0')+(year?'.'+(year.length===2?'20'+year:year):''));
}

export function matchTransferComments(transfers:DeadlineTransfer[],comments:DeadlineTransferComment[]){
 const sorted=[...comments].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id));
 const matched=new Map<string,DeadlineTransferComment[]>();
 for(const comment of sorted){
  const text=cleanMessage(comment.text);
  if(!text||/^РУСПЭТ\s*·/iu.test(text))continue;
  const explicit=transferWords.test(text),reason=reasonHeader.test(text);
  if((comment.author==='Битрикс24'||comment.author==='Система')&&!(explicit&&reason))continue;
  const dates=explicit||reason?statedDates(text):[];
  const at=Date.parse(comment.occurredAt);
  if(!Number.isFinite(at))continue;
  const candidates=transfers.filter(item=>{
   const delta=Math.abs(at-Date.parse(item.occurredAt));
   if(dates.length){
    if(!item.to||delta>14*dayMs)return false;
    const finalDate=moscowDay.format(new Date(item.to));
    return dates.includes(finalDate)||dates.includes(finalDate.slice(0,5));
   }
   const sameAuthor=moscowName(item.author)===moscowName(comment.author);
   return explicit&&(sameAuthor||reason)&&delta<=30*60000||sameAuthor&&(reason&&delta<=15*60000||contextWords.test(text)&&delta<=5*60000);
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
