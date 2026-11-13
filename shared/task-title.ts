const prefix=/^([\p{L}\p{N}]{2,12}[*#])\s*/u;
const polite=/^(?:пожалуйста(?:,|!)?\s+|(?:необходимо|нужно|требуется|просьба)\s+)/iu;

/** A readable excerpt of the original instruction, followed by one intact reference if needed. */
export function compactTaskTitle(raw:string,limit=110):string{
 const original=raw.replace(/\s+/gu,' ').trim();
 const code=original.match(prefix)?.[0].trim();
 const instruction=original.replace(prefix,'').replace(/^(?:задача|задание)\s*[:—-]\s*/iu,'');
 const clean=instruction.replace(polite,'').replace(polite,'');
 const title=[code,clean||instruction].filter(Boolean).join(' ')||'Без названия';
 if(title.length<=limit)return title;
 const references=[...title.matchAll(/(?:№\s*[\p{L}\d][\p{L}\d./-]*|(?:заказ|сч[её]т|артикул)[а-яё]*\s+\d[\d./-]*|\d+(?:[.,]\d+)?\s*(?:мм|кг|шт|мл|л)(?=\s|$|[.,;]))/giu)];
 const quote=title.match(/[«“"]([^»”"]{2,45})[»”"]/u);
 const restriction=title.match(/(?:^|[,;.!?]\s+)(не\s+[^,;.!?]{5,60})(?=[,;.!?]|$)/iu);
 const detail=references.find(ref=>ref.index>limit*.65)??(quote&&quote.index!>limit*.65?quote:null);
 const extraText=restriction&&restriction.index!>limit*.65&&restriction[1].length<limit/3?restriction[1]:detail?.[0];
 const extra=extraText&&extraText.length<limit/3?' · '+extraText:'';
 const room=limit-extra.length-1;
 const excerpt=title.slice(0,room).replace(/[\uD800-\uDBFF]$/u,'');
 const boundary=excerpt.lastIndexOf(' ');
 const head=(boundary>=room*.65?excerpt.slice(0,boundary):excerpt).replace(/[\s,;:—-]+$/u,'');
 return head+'…'+extra;
}
