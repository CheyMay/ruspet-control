export const searchKinds=['task','person','company','comment','report'] as const;
export type SearchKind=typeof searchKinds[number];
export type SearchHit={kind:SearchKind;id:string;title:string;subtitle?:string;excerpt?:string;taskId?:string};
export type SearchFilters={kind?:SearchKind;branch?:string;owner?:string;from?:string;to?:string};
export type SearchResponse={hits:SearchHit[];companiesUnavailable?:boolean};

export const searchKindLabels:Record<SearchKind,string>={
 task:'Задачи',person:'Сотрудники',company:'Клиенты',comment:'Обсуждения',report:'Отчёты',
};
export const normalizeSearch=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е');
export const searchTerms=(value:string)=>[...new Set(normalizeSearch(value).match(/[\p{L}\p{N}]+/gu)??[])].slice(0,12);

export function searchRank(terms:string[],title:string,details='',identifier=''){
 const name=normalizeSearch(title),rest=normalizeSearch(details),id=normalizeSearch(identifier);
 if(terms.length===1&&terms[0]===id)return 1000;
 let score=0;
 for(const term of terms){
  const match=name.indexOf(term);
  if(match===0)score+=12;
  else if(match>0)score+=8;
  else if(id.includes(term))score+=6;
  else if(rest.includes(term))score+=2;
  else return 0;
 }
 return score;
}
