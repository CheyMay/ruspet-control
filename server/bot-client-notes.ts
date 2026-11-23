import {addClientNote} from './client-notes.js';
import {button,screen,type Payload} from './bot-ui.js';
import {getCompany,listCompanies,okbConfigured} from './okb.js';
import type {Db} from './db.js';
import type {User} from '../shared/types.js';
import {assert} from './domain.js';

const clean=(value:string)=>value.trim().replace(/^[«"]|[»"]$/g,'').trim();
export function parseClientNote(text:string){
 const raw=text.trim();
 const match=/^(?:(?:добавь|запиши|сохрани|оставь)(?:те)?\s+(?:заметку\s+(?:(?:по|для|к)\s+)?клиент[уае]|комментарий\s+в\s+карточку\s+клиента)|клиент)\s+(.+)$/isu.exec(raw);
 if(!match)return null;
 const split=/^(.{2,150}?)(?:\s*[:—–]\s*|[.,;]\s+|\s+(?=(?:сейчас|пока|на\s+стопе|поставили\s+на\s+паузу)(?=\s|$)))(.+)$/isu.exec(match[1]);
 if(!split)return null;
 return {query:clean(split[1]),body:split[2].trim().slice(0,4000)};
}
function nameKey(value:string){
 return value.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').replace(/[«»"]/g,'').replace(/^(ооо|ип|ао|пао)\s+/u,'').trim();
}
export async function draftClientNote(actor:User,channel:string,input:{query:string;body:string},db:Db){
 if(!okbConfigured())return screen(actor,channel,'Клиентская база недоступна. Попробуйте позже.',[[button('Меню','home')]],db);
 await db.query('DELETE FROM bot_sessions WHERE actor_id=$1 AND channel=$2',[actor.id,channel]);
 await db.query("UPDATE bot_buttons SET revoked=true WHERE actor_id=$1 AND channel=$2 AND receipt IS NULL AND payload->>'op' IN ('confirm','cancel','client_note_pick')",[actor.id,channel]);
 const rows=(await listCompanies(actor,input.query)).slice(0,8);
 const exact=rows.filter(row=>row.tax_id===input.query||nameKey(row.name)===nameKey(input.query));
 const choices=exact.length?exact:rows;
 if(choices.length===1)return confirmClientNote(actor,channel,{target:choices[0].id,values:{body:input.body},op:'client_note_pick'},db);
 if(!choices.length)return screen(actor,channel,'Клиент «'+input.query+'» не найден среди доступных. Повторите команду с названием из ОКБ или ИНН.',[[button('Меню','home')]],db);
 return screen(actor,channel,'К какому клиенту добавить заметку?',[
  ...choices.map(row=>[button(row.name.slice(0,46)+(row.tax_id?' · '+row.tax_id:''),'client_note_pick',{target:row.id,values:{body:input.body}})]),
  [button('Отмена','cancel')]
 ],db);
}
export async function confirmClientNote(actor:User,channel:string,p:Payload,db:Db){
 const client=await getCompany(actor,p.target!);
 const body=p.values?.body??'';
 assert(body.trim().length>0&&body.length<=4000,400,'Скажите, что записать о клиенте.');
 return screen(actor,channel,'Заметка о клиенте · '+client.name+'\n\n'+body.slice(0,3000),[
  [button('Сохранить заметку','confirm',{kind:'client_note',target:client.id,values:{body}})],[button('Отмена','cancel')]
 ],db);
}
export async function saveBotClientNote(actor:User,p:Payload,db:Db){
 const body=p.values?.body??'';
 assert(body.trim().length>0&&body.length<=4000,400,'Скажите, что записать о клиенте.');
 return addClientNote(actor,{companyId:p.target!},body,db);
}
