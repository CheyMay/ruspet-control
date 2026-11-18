const reference=/(?:^|\r?\n\r?\n)РУСПЭТ · (L-[0-9a-f]{8})\s*$/u;

export function ruspetTaskReference(description:string){
 return description.match(reference)?.[1]??null;
}

export function stripRuspetTaskReference(description:string){
 return description.replace(reference,'');
}

export function withRuspetTaskReference(description:string,id:string){
 return stripRuspetTaskReference(description)+'\n\nРУСПЭТ · '+id;
}
