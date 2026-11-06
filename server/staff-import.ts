import {createHash,randomUUID} from 'node:crypto';
import readXlsxFile from 'read-excel-file/node';
import {pool,transaction,type Db} from './db.js';
import {assert,AppError} from './domain.js';
import type {User} from '../shared/types.js';

export const nameParts=(value:string)=>value.toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[,\s]+/g,' ').trim().split(' ').filter(Boolean).sort();
export const nameKey=(value:string)=>nameParts(value).join(' ');
export function namesMatch(a:string,b:string){
 const x=nameParts(a),y=nameParts(b),small=x.length<=y.length?x:y,remaining=[...(x.length<=y.length?y:x)];
 return x.length>=2&&y.length>=2&&small.every(part=>{const index=remaining.indexOf(part);if(index<0)return false;remaining.splice(index,1);return true;});
}
export function normalPhone(value:unknown){let digits=String(value??'').replace(/\D/g,'');if(digits.length===10)digits='7'+digits;if(digits.length===11&&digits.startsWith('8'))digits='7'+digits.slice(1);return /^\d{11,15}$/.test(digits)?digits:null;}
type StaffRow={sourceKey:string;name:string;organisation:string;department:string;emails:string[];phones:string[];bitrixId:string|null};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
function checkZip(data:Buffer){
 assert(data.length>22&&data.length<=3*1024*1024,400,'Выберите XLSX размером до 3 МБ.');
 const end=data.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));assert(end>=0&&end+22<=data.length,400,'Некорректный XLSX.');
 const count=data.readUInt16LE(end+10);let cursor=data.readUInt32LE(end+16),total=0;assert(count>0&&count<=1000,400,'Слишком сложный XLSX.');
 for(let i=0;i<count;i++){
  assert(cursor+46<=data.length&&data.readUInt32LE(cursor)===0x02014b50,400,'Некорректный архив XLSX.');
  const size=data.readUInt32LE(cursor+24);total+=size;assert(size<=8*1024*1024&&total<=24*1024*1024,400,'Слишком большой распакованный XLSX.');
  cursor+=46+data.readUInt16LE(cursor+28)+data.readUInt16LE(cursor+30)+data.readUInt16LE(cursor+32);
 }
}
export async function parseStaffFile(data:Buffer){
 checkZip(data);let sheets:Awaited<ReturnType<typeof readXlsxFile>>;
 try{sheets=await readXlsxFile(data)}catch{throw new AppError(400,'Не удалось прочитать XLSX. Проверьте формат файла.');}
 const rows=new Map<string,StaffRow>();let duplicates=0;
 for(const sheet of sheets){
  // The combined sheet repeats the same employees and has a different layout.
  if(sheet.sheet==='Общий список')continue;
  const header=sheet.data.findIndex(row=>row.some(v=>String(v||'').toLowerCase().includes('фамилия'))&&row.some(v=>String(v||'').toLowerCase().includes('телефон')));
  if(header<0)continue;const titles=sheet.data[header].map(v=>String(v||'').toLowerCase());
  const col=(part:string)=>titles.findIndex(v=>v.includes(part));let department='';
  for(const cells of sheet.data.slice(header+1)){
   if(cells[col('отдел')])department=String(cells[col('отдел')]).trim().slice(0,150);
   const name=String(cells[col('фамилия')]||'').replace(/\s+/g,' ').trim();
   if(!/^[\p{L}\s,\-]{3,150}$/u.test(name)||nameParts(name).length<2||/фамилия|ваканси|уволен/i.test(name))continue;
   const phones=[...new Set((String(cells[col('телефон')]||'').match(/\+?\d[\d ()\-.]{8,}\d/g)||[]).map(normalPhone).filter((p):p is string=>!!p))].sort();
   const emails=[...new Set(titles.flatMap((title,i)=>title.includes('почта')?(String(cells[i]||'').match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi)||[]).map(v=>v.toLowerCase()):[]))].sort();
   const external=String(cells[col('bitrix')]||'').trim(),bitrixId=/^[1-9]\d{0,11}$/.test(external)?external:null;
   const sourceKey=hash(JSON.stringify([sheet.sheet,nameKey(name),department,bitrixId]));
   const old=rows.get(sourceKey);if(old){old.phones=[...new Set([...old.phones,...phones])].sort();old.emails=[...new Set([...old.emails,...emails])].sort();duplicates++;}
   else rows.set(sourceKey,{sourceKey,name,organisation:sheet.sheet,department,phones,emails,bitrixId});
   assert(rows.size<=1000,400,'Не более 1000 сотрудников в одном файле.');
  }
 }
 assert(rows.size,400,'Не найдены листы с колонками «Фамилия, имя» и «Номер телефона».');
 return {rows:[...rows.values()].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)),duplicates};
}
async function makePlan(db:Db,data:Buffer){
 const parsed=await parseStaffFile(data),users=(await db.query('SELECT u.*,b.external_id::text FROM users u LEFT JOIN bitrix_user_links b ON b.user_id=u.id')).rows;
 const existing=(await db.query('SELECT source_key,user_id FROM staff_directory')).rows;
 const rows=parsed.rows.map(row=>{
  const old=existing.find(e=>e.source_key===row.sourceKey),byId=row.bitrixId?users.filter(u=>u.external_id===row.bitrixId&&namesMatch(row.name,u.name)):[];
  const matched=byId.length?byId:users.filter(u=>namesMatch(row.name,u.name));
  const repeated=parsed.rows.filter(r=>namesMatch(r.name,row.name)).length>1;
  return {...row,userId:old?.user_id??(matched.length===1&&(!repeated||byId.length===1)?matched[0].id:null),ambiguous:!old?.user_id&&(matched.length>1||repeated)};
 });
 const digest=hash(JSON.stringify(rows));return {digest,rows,duplicates:parsed.duplicates};
}
export async function importStaff(actor:User,data:Buffer,expected?:string){
 assert(actor.role==='admin',403,'Справочник загружает администратор.');
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431008)');const plan=await makePlan(db,data);
  if(expected){
   assert(expected===plan.digest,409,'Файл или сопоставление изменились. Повторите предварительный просмотр.');
   for(const row of plan.rows)await db.query(`INSERT INTO staff_directory(id,source_key,name,name_key,organisation,department,emails,phones,bitrix_id,user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(source_key) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,
    emails=excluded.emails,phones=excluded.phones,bitrix_id=excluded.bitrix_id,user_id=coalesce(staff_directory.user_id,excluded.user_id),updated_at=now()`,[randomUUID(),row.sourceKey,row.name,nameKey(row.name),row.organisation,row.department,row.emails,row.phones,row.bitrixId,row.userId]);
   await db.query("INSERT INTO task_events(id,actor_id,kind,message,data) VALUES($1,$2,'staff_import','Обновлён справочник сотрудников',$3)",[randomUUID(),actor.id,JSON.stringify({count:plan.rows.length})]);
  }
  return {digest:plan.digest,count:plan.rows.length,duplicates:plan.duplicates,applied:!!expected,
   rows:plan.rows.map(r=>({name:r.name,organisation:r.organisation,department:r.department,hasPhone:!!r.phones.length,matched:!!r.userId,ambiguous:r.ambiguous}))};
 });
}
export async function staffSummary(actor:User){assert(actor.role==='admin',403,'Справочник доступен администратору.');return (await pool.query('SELECT count(*)::int total,count(*) FILTER(WHERE cardinality(phones)>0)::int with_phone FROM staff_directory WHERE enabled')).rows[0];}
