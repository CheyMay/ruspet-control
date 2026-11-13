import {randomBytes} from 'node:crypto';
import {pool,type Db} from './db.js';
import type {User} from '../shared/types.js';
export type BotScreen={replyKeyboard?:'contact'|'remove';timingKind?:'menu'|'task';format?:'HTML';document?:{reportId:string};links?:{text:string;url:string}[];text:string;buttons:{text:string;token:string}[][]};
export type ListOrigin={op:string;page?:number;filter?:string;owner?:string;query?:string;target?:string};
export type Payload={op:string;id?:string;page?:number;filter?:string;owner?:string;query?:string;kind?:string;version?:number;target?:string;step?:number;revision?:number;values?:Record<string,string>;minutes?:number;list?:ListOrigin;noticeIds?:string[]};
export const date=(s:string|null)=>s?new Date(s).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}):'Не назначен';
export const button=(text:string,op:string,extra:Partial<Payload>={})=>({text,payload:{op,...extra}});
export async function screen(u:User,ch:string,text:string,rows:ReturnType<typeof button>[][],db:Db=pool):Promise<BotScreen>{
 const records:{token:string;payload:unknown}[]=[];
 const buttons=rows.filter(row=>row.length).map(row=>row.map(b=>{const token=randomBytes(18).toString('base64url');records.push({token,payload:b.payload});return {text:b.text,token}}));
 if(records.length)await db.query("INSERT INTO bot_buttons(token,actor_id,channel,payload,expires_at) SELECT token,$2,$3,payload,now()+interval '24 hours' FROM jsonb_to_recordset($1::jsonb) AS buttons(token text,payload jsonb)",[JSON.stringify(records),u.id,ch]);
 return {text,buttons};
}
export async function htmlScreen(u:User,ch:string,text:string,rows:ReturnType<typeof button>[][],db:Db=pool):Promise<BotScreen>{return {...await screen(u,ch,text,rows,db),format:'HTML'};}
