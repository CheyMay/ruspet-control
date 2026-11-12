/** Extractive display labels only: the stored title and search text stay untouched. */
export function compactTaskTitle(raw:string,limit=92):string {
 const original=raw.replace(/\s+/gu,' ').trim();
 let text=original;
 const code=text.match(/^([\p{L}\p{N}]{2,12}[*#])\s*/u)?.[0]??'';
 text=text.slice(code.length).replace(/^(?:задача|задание)\s*[:—-]\s*/iu,'');
 for(let i=0;i<3;i++)text=text.replace(/^(?:пожалуйста[,!]?|необходимо|нужно|требуется|просьба)\s+/iu,'');
 text=code+text;
 if(!text.trim())text=original||'Без названия';
 if(text.length<=limit)return text;
 const words=text.match(/\S+/gu)??[],selected=new Set<number>();
 const render=()=>{
  const indices=[...selected].sort((a,b)=>a-b);
  return (indices[0]>0?'… ':'')+indices.map((index,i)=>(i&&index>indices[i-1]+1?' … ':i?' ':'')+words[index]).join('')+(indices.at(-1)!<words.length-1?' …':'');
 };
 const add=(indices:number[])=>{
  const previous=new Set(selected);
  for(const index of indices)if(index<words.length)selected.add(index);
  if(render().length>limit){selected.clear();for(const index of previous)selected.add(index);return false;}
  return true;
 };
 add([0,1]);if(!selected.size)add([0]);
 // Retain negations as a phrase, and order/part numbers, before filling the head/tail.
 for(let i=0;i<words.length;i++)if(/^(?:не|без|кроме|запрещено)$/iu.test(words[i]))add([i,i+1,i+2]);
 for(let i=0;i<words.length;i++){
  if(/^№/u.test(words[i]))add(words[i]==='№'?[i,i+1]:[i]);
  else if(/^(?:заказ|сч[её]т|артикул)[а-яё]*$/iu.test(words[i])&&/\d/u.test(words[i+1]??'')&&!/^№/u.test(words[i+1]))add([i,i+1]);
 }
 add([0,1,2,3,4]);
 for(let i=words.length-1;i>=0;i--)if(/\d/u.test(words[i]))add([i]);
 add([Math.max(0,words.length-2),words.length-1]);
 for(let i=0;i<words.length&&render().length<limit*.65;i++)if(!add([i]))break;
 for(let i=words.length-1;i>=0;i--)if(!selected.has(i)&&!add([i]))break;
 const result=render();
 // A single unbroken identifier can exceed the entire label; avoid broken surrogates.
 let cut=Math.max(1,limit-1);if(/[\uD800-\uDBFF]/.test(text[cut-1]))cut--;
 return selected.size?result:text.slice(0,cut)+'…';
}
