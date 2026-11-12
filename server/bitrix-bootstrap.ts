import {readFile} from 'node:fs/promises';
import {pool} from './db.js';
import {BitrixError,type BitrixRequest,type BitrixMethod} from './bitrix-rest.js';
import {importBitrixTask} from './bitrix-import.js';
import {bitrixId,remoteTask,syncLinkedTask,taskFields} from './bitrix-sync.js';
import {ensureBitrixUser,normalizedName} from './bitrix-users.js';

async function exportRows(file:string){
 const input=JSON.parse(await readFile(file,'utf8'));
 if(!Array.isArray(input.rows)||!Array.isArray(input.rows[0]))throw new BitrixError('Нет строк нормализованной выгрузки.');
 const headers=input.rows[0] as string[];
 if(new Set(headers).size!==headers.length||!['ID','Название','Описание','Крайний срок','Статус','Исполнитель','Постановщик'].every(k=>headers.includes(k)))throw new BitrixError('Нет обязательных столбцов выгрузки.');
 const ids=new Set<string>();
 return input.rows.slice(1).map((cells:unknown[])=>{
  if(!Array.isArray(cells)||cells.length!==headers.length)throw new BitrixError('Неверное число ячеек.');
  const row=Object.fromEntries(headers.map((key,i)=>[key,String(cells[i]??'')]));
  const id=bitrixId(row.ID);
  if(!id||ids.has(id))throw new BitrixError('Неверный или повторяющийся ID выгрузки.');
  ids.add(id);return row as Record<string,string>;
 }) as Record<string,string>[];
}
export async function mapExportUsers(request:BitrixRequest,file:string){
 const rows=await exportRows(file);
 const needed=new Set(rows.flatMap(row=>[normalizedName(row['Исполнитель']),normalizedName(row['Постановщик'])]));
 const people:{ID:string;NAME?:string;LAST_NAME?:string;SECOND_NAME?:string}[]=[];
 let complete=false;
 for(let page=0;page<20;page++){
  const records=await request<typeof people>('user.get',{sort:'ID',order:'ASC',start:page*50,select:['ID','NAME','LAST_NAME','SECOND_NAME']});
  if(!Array.isArray(records))throw new BitrixError('Нет списка пользователей.');
  people.push(...records);
  if(records.length<50){complete=true;break;}
 }
 if(!complete)throw new BitrixError('Каталог больше 1000 сотрудников. Нужна отдельная постраничная привязка.');
 const name=(person:typeof people[number])=>normalizedName([person.LAST_NAME,person.NAME,person.SECOND_NAME].filter(Boolean).join(' '));
 let mapped=0,ambiguous=0;
 for(const person of people){
  if(!needed.has(name(person)))continue;
  if(people.filter(other=>name(other)===name(person)).length!==1){ambiguous++;continue;}
  const cached:BitrixRequest=async <T>()=>[person] as T;
  await ensureBitrixUser(cached,String(person.ID));mapped++;
 }
 return {mapped,ambiguous};
}
const sourceDate=(value:string)=>{
 if(!value.trim())return null;
 const match=/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(value.trim());
 const iso=match?`${match[3]}-${match[2]}-${match[1]}T${match[4]}+03:00`:value;
 if(!Number.isFinite(Date.parse(iso)))throw new BitrixError('Неверная дата выгрузки.');
 return new Date(iso).toISOString();
};
export async function bootstrapBitrixExport(file:string,apply=false){
 const rows=await exportRows(file);
 const portal=(await pool.query('SELECT portal FROM bitrix_rest_gate WHERE id=1')).rows[0]?.portal;
 if(!process.env.BITRIX_PORTAL||portal!==process.env.BITRIX_PORTAL.toLowerCase())throw new BitrixError('Сначала подтвердите портал командой export-users.');
 const people=(await pool.query('SELECT u.name,l.external_id FROM bitrix_user_links l JOIN users u ON u.id=l.user_id')).rows;
 const person=(name:string)=>{
  const matches=people.filter(row=>normalizedName(row.name)===normalizedName(name));
  if(matches.length!==1)throw new BitrixError('Не все сотрудники выгрузки однозначно связаны. Выполните export-users или map-user.');
  return String(matches[0].external_id);
 };
 const statuses:Record<string,string>={'Ждёт выполнения':'2','Выполняется':'3','Ждёт контроля':'4','Завершена':'5','Отложена':'6'};
 const mappings=(await pool.query('SELECT * FROM bitrix_field_map')).rows;
 const tasks=rows.map(row=>{
  if(!statuses[row['Статус']])throw new BitrixError('Неизвестный статус в выгрузке.');
  const extras=Object.fromEntries(mappings.map(m=>[m.external_code,row[({price:'Цена задачи',important:'Важная задача',customer_risk:'Может привести к потере клиента'} as Record<string,string>)[m.local_key]]??'']));
  for(const m of mappings)if(m.local_key!=='price')extras[m.external_code]=extras[m.external_code]==='Да'?'1':extras[m.external_code]==='Нет'?'0':'';
  return remoteTask({...extras,id:row.ID,title:row['Название'],description:row['Описание'],deadline:sourceDate(row['Крайний срок']),
   status:statuses[row['Статус']],responsibleId:person(row['Исполнитель']),createdBy:person(row['Постановщик']),closedDate:sourceDate(row['Дата закрытия']||'')});
 });
 const existing=new Set((await pool.query('SELECT id FROM tasks')).rows.map(row=>row.id));
 const linked=new Set((await pool.query('SELECT external_id FROM bitrix_task_links')).rows.map(row=>String(row.external_id)));
 const result={total:tasks.length,newTasks:tasks.filter(t=>!existing.has(t.id)&&!linked.has(t.id)).length,
  alreadyLinked:tasks.filter(t=>linked.has(t.id)).length,applied:0,conflicts:0};
 if(!apply)return result;
 // A file is only an initial source, never a replacement for already linked live state.
 for(const task of tasks){
  if(linked.has(task.id))continue;
  const cached:BitrixRequest=async <T>(method:BitrixMethod,params:object)=>{
   if(method!=='tasks.task.get'||String((params as {taskId:unknown}).taskId)!==task.id)throw new BitrixError('Начальная сверка не должна обращаться к REST.');
   return {task} as T;
  };
  const id=await importBitrixTask(cached,task.id);
  const plan=await syncLinkedTask(cached,id,false);
  if(plan.conflict.length||plan.outbound.length)result.conflicts++;else result.applied++;
 }
 return result;
}
export async function catchupBitrix(request:BitrixRequest,since:string,after='0',maxPages=10,importNew=true){
 if(!Number.isFinite(Date.parse(since))||!/[zZ]|[+-]\d{2}:\d{2}$/.test(since))throw new BitrixError('Укажите время выгрузки ISO 8601 с часовым поясом.');
 let cursor=after,total=0,conflicts=0;
 for(let page=0;page<maxPages;page++){
  const result=await request<{tasks:Record<string,unknown>[]}>('tasks.task.list',{order:{ID:'asc'},filter:{'>=CHANGED_DATE':since,'>ID':cursor},select:taskFields});
  if(!Array.isArray(result.tasks))throw new BitrixError('Нет изменённых задач в ответе.');
  if(!result.tasks.length)return {total,conflicts,cursor,complete:true};
  for(const record of result.tasks){
   const task=remoteTask(record);
   if(BigInt(task.id)<=BigInt(cursor))throw new BitrixError('Неверный порядок задач сверки.');
   if(!importNew&&!(await pool.query('SELECT 1 FROM bitrix_task_links WHERE external_id=$1',[task.id])).rowCount){cursor=task.id;continue;}
   const cached:BitrixRequest=async <T>(method:BitrixMethod,params:object)=>{
    if(method==='tasks.task.get')return {task:record} as T;
    return request<T>(method,params);
   };
   const id=await importBitrixTask(cached,task.id);
   const plan=await syncLinkedTask(cached,id,false);
   if(plan.conflict.length||plan.outbound.length)conflicts++;
   cursor=task.id;total++;
  }
 }
 return {total,conflicts,cursor,complete:false};
}
