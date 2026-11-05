import {pool,type Db} from './db.js';
import {assert,canSee} from './domain.js';
import type {User,Task} from '../shared/types.js';
import type {BitrixRequest} from './bitrix-rest.js';
import {bitrixId} from './bitrix-sync.js';
export function fieldValue(raw:Record<string,unknown>,code:string):unknown {
 if(Object.hasOwn(raw,code))return raw[code];
 const canonical=code.replaceAll('_','').toLowerCase();
 const keys=Object.keys(raw).filter(k=>k.replaceAll('_','').toLowerCase()===canonical);
 assert(keys.length<=1,409,'Неоднозначное имя поля Битрикс24: '+code);
 return keys.length?raw[keys[0]]:undefined;
}
export async function discoverTaskFields(request:BitrixRequest){
 const result=await request<{fields:Record<string,Record<string,unknown>>}>('tasks.task.getFields',{});
 if(!result.fields||typeof result.fields!=='object'||Array.isArray(result.fields))throw Error('Нет описания полей задачи.');
 const rows=Object.entries(result.fields).filter(([code,value])=>/^[A-Z][A-Z0-9_]*$/.test(code)&&value&&typeof value==='object');
 if(!rows.some(([code])=>code==='TITLE'))throw Error('Справочник полей не содержит TITLE.');
 for(const [code,description] of rows)await pool.query('INSERT INTO bitrix_field_catalog(code,description) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET description=excluded.description,fetched_at=now()',[code,JSON.stringify(description)]);
 return rows.map(([code,description])=>({code,...description}));
}
export async function fullSelection(db:Db=pool){return ['*',...(await db.query("SELECT code FROM bitrix_field_catalog WHERE code LIKE 'UF\\_%' ESCAPE '\\' ORDER BY code")).rows.map(r=>r.code),'UF_CRM_TASK','UF_TASK_WEBDAV_FILES','UF_MAIL_MESSAGE','CHAT_ID','RELATED_TASKS'];}
export async function mapBitrixUser(request:BitrixRequest,userId:string,externalId:string,confirmed:boolean){
 const local=(await pool.query('SELECT id,name,role FROM users WHERE id=$1',[userId])).rows[0];assert(local,404,'Локальный пользователь не найден.');
 assert(bitrixId(externalId),400,'Нужен числовой ID пользователя Битрикс24.');
 const remote=await request<Record<string,unknown>[]>('user.get',{ID:externalId});
 assert(Array.isArray(remote)&&remote.length===1&&String(remote[0].ID)===externalId,400,'Битрикс24 не подтвердил пользователя.');
 assert(remote[0].ACTIVE===true||remote[0].ACTIVE==='Y',400,'Пользователь Битрикс24 не активен.');
 if(confirmed){
  const existing=(await pool.query('SELECT external_id FROM bitrix_user_links WHERE user_id=$1',[userId])).rows[0];
  assert(!existing||String(existing.external_id)===externalId,409,'У пользователя уже другая привязка. Требуется отдельная сверка.');
  await pool.query('INSERT INTO bitrix_user_links(user_id,external_id) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET verified_at=now()',[userId,externalId]);
 }
 return {confirmed,local,remote:{id:externalId,name:[remote[0].NAME,remote[0].LAST_NAME].filter(Boolean).join(' ')}};
}
export async function taskIntegration(actor:User,id:string,includeFields=true){
 const task=(await pool.query<Task>('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];assert(task&&canSee(actor,task),404,'Задача недоступна.');
 const link=(await pool.query('SELECT external_id,live_enabled,conflict,checked_at FROM bitrix_task_links WHERE task_id=$1',[id])).rows[0];
 if(!link)return {linked:false,enabled:false,state:'local',fields:[],error:null};
 const op=(await pool.query("SELECT event_id,state,error FROM bitrix_operations WHERE task_id=$1 AND state NOT IN ('sent','canceled') ORDER BY sequence LIMIT 1",[id])).rows[0];
 const source=(await pool.query('SELECT raw,fetched_at FROM bitrix_task_snapshots WHERE external_id=$1',[link.external_id])).rows[0];
 const cfg=(await pool.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0];
 const showFields=includeFields&&(actor.role==='admin'||link.live_enabled&&!link.conflict);
 const catalog=showFields?(await pool.query('SELECT code,description FROM bitrix_field_catalog')).rows:[];
 const raw=source?.raw||{};
 const fields=showFields?Object.entries(raw).map(([code,value])=>{const title=catalog.find(f=>f.code.replaceAll('_','').toLowerCase()===code.replaceAll('_','').toLowerCase())?.description.title;return {code,title:typeof title==='string'?title:code,value}}):[];
 return {linked:true,enabled:link.live_enabled,operationId:op?.event_id||null,paused:link.live_enabled&&!cfg.enabled,state:op?.state||(link.live_enabled?(link.conflict?'blocked':cfg.enabled?'synced':'paused'):'read_only'),error:op?.error||link.conflict||null,checkedAt:link.checked_at,fetchedAt:source?.fetched_at,externalId:String(link.external_id),fields};
}
