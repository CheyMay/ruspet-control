import {parsePrice} from '../shared/pricing.js';
import { readFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { pool,transaction } from '../server/db.js';
import { defaultRules,assert } from '../server/domain.js';
import { event } from '../server/service.js';
export function sourceDate(value:unknown):string|null {
 if(value===null||value===undefined||value==='')return null;
 const s=String(value).trim().replace(' ','T');
 assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s),422,`Unsupported source date: ${s}`);
 const date=new Date(s+'+03:00');assert(!isNaN(date.getTime()),422,'Invalid source date.');return date.toISOString();
}
export const sourceBoolean=(value:unknown):boolean|null=>{const v=String(value??'').trim().toLowerCase();if(v==='да')return true;if(v==='нет')return false;assert(v==='',422,`Unknown boolean value: ${v}`);return null;};
export function sourceStatus(value:unknown):'active'|'review'|'completed' {
 const statuses:Record<string,'active'|'review'|'completed'>={'Ждёт выполнения':'active','Выполняется':'active','Ждёт контроля':'review','Завершена':'completed'};
 const status=statuses[String(value)];assert(status,422,`Unmapped status: ${value}`);return status;
}
export async function importSource() {
 const bytes=await readFile('data/first-sheet.json','utf8');
 const input=JSON.parse(bytes) as {file:string;sheet:string;rows:unknown[][]};
 const hash=createHash('sha256').update(bytes).digest('hex');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431004)');
  if((await db.query('SELECT 1 FROM import_batches WHERE source_hash=$1',[hash])).rowCount)return;
  assert(!(await db.query('SELECT 1 FROM tasks LIMIT 1')).rowCount,409,'Импорт выполняется в пустую БД. Существующие задачи не перезаписываются.');
  const headers=input.rows[0].map(String), records=input.rows.slice(1).filter(r=>r[0]!==null&&r[0]!==undefined&&r[0]!=='').map((row,index)=>({row:index+2,values:Object.fromEntries(headers.map((key,i)=>[key,row[i]??null]))}));
  for(const key of ['ID','Название','Исполнитель','Постановщик','Статус','Крайний срок'])assert(headers.includes(key),422,`Missing column: ${key}`);
  assert(new Set(records.map(r=>r.values.ID)).size===records.length,422,'В первом листе есть дубли ID. Импорт отменён.');
  const names=[...new Set(records.flatMap(r=>[r.values['Исполнитель'],r.values['Постановщик']]).filter(Boolean).map(String))].sort((a,b)=>a.localeCompare(b,'ru'));
  const personId=(name:unknown)=>'person-'+createHash('sha256').update(String(name)).digest('hex').slice(0,16);
  for(const name of names)await db.query("INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,'employee','Не указан','Сотрудник из выгрузки') ON CONFLICT DO NOTHING",[personId(name),name]);
  for(const [id,name,role] of [['admin','Тестовый администратор','admin'],['director','Тестовый директор','director'],['head','Тестовый руководитель продаж','sales_head'],['lead-source','Тестовый руководитель филиала','branch_manager']])await db.query("INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,'Не указан','Тестовая роль, не назначение сотрудника') ON CONFLICT DO NOTHING",[id,name,role]);
  await db.query('INSERT INTO rule_versions(config,author_id) VALUES($1,$2)',[JSON.stringify(defaultRules),'admin']);
  for(const record of records) {
   const r=record.values;assert(r['Исполнитель']&&r['Постановщик']&&r['Название'],422,`Required value missing at row ${record.row}`);
   const id=String(r.ID);assert(/^\d+$/.test(id),422,'Некорректный ID задачи.');
   const task=(await db.query("INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,deadline,original_deadline,planned_end,status,priority,code,important,customer_risk,created_at,updated_at,completed_at,source_fields,source_status,planned_start,parent_id,price) VALUES($1,$2,$3,'Не указан',$4,$5,$6,NULL,$7,$8,'normal',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *",[id,r['Название'],r['Описание']||'',personId(r['Исполнитель']),personId(r['Постановщик']),sourceDate(r['Крайний срок']),sourceDate(r['Планируемая дата окончания']),sourceStatus(r['Статус']),String(r['Название']).split(/\s/)[0],sourceBoolean(r['Важная задача']),sourceBoolean(r['Может привести к потере клиента']),sourceDate(r['Дата создания']),sourceDate(r['Дата изменения'])||sourceDate(r['Дата создания']),sourceDate(r['Дата закрытия']),JSON.stringify(r),r['Статус'],sourceDate(r['Планируемая дата начала']),r['ID базовой задачи']?String(r['ID базовой задачи']):null,parsePrice(r['Цена задачи'])])).rows[0];
   await db.query('INSERT INTO mock_provider_tasks(id,snapshot,revision) VALUES($1,$2,1)',[id,JSON.stringify(task)]);
   await event(db,id,null,'imported',`Импорт из ${input.file} · ${input.sheet} · строка ${record.row}`,{sourceHash:hash,sourceRow:record.row,initialSnapshot:task});
  }
  await db.query('INSERT INTO import_batches(id,file_name,sheet_name,source_hash,row_count,assumptions) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),input.file,input.sheet,hash,records.length,JSON.stringify({timezone:'Europe/Moscow (assumed; source contains no timezone)',branches:'not supplied',originalDeadlines:'unknown',transferCounts:'only since import',roles:'imported people are employees; managerial accounts are test roles',statusMapping:'original text preserved in source_status',priority:'not provided; internal neutral default'})]);
  console.log(`Imported ${records.length} tasks and ${names.length} people from the first sheet. No fake approvals or comments created.`);
 });
}
if(process.argv[1]?.endsWith('import-source.ts')){await importSource();await pool.end();}
