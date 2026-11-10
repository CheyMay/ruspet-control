import {randomUUID} from 'node:crypto';
import readXlsxFile from 'read-excel-file/node';
import {assert,AppError} from './domain.js';
import {okbPool} from './okb.js';
import {checkWorkbookZip} from './xlsx.js';

const columns={
 name1c:'название как в 1с',name:'название 1',manager:'менеджер',address:'адрес',region:'регион',
 type:'тип компании',branch:'филиал, от лица которого отгружается клиент'
};
type Source=Record<keyof typeof columns,string>;
type Company={id:string;name:string;status:string;xlsx_source:Source|null};
const fields=Object.keys(columns) as (keyof Source)[];
const clean=(value:unknown)=>String(value??'').replace(/\s+/g,' ').trim();
const key=(value:string)=>clean(value).toLocaleLowerCase('ru-RU').replaceAll('ё','е');
function status(type:string){
 switch(key(type)){
  case 'действующий клиент':return 'active';
  case 'потерянный клиент':return 'former';
  case 'потенциальный клиент':
  case 'потенциальный клиент неопределенной категории':return 'prospect';
  default:return 'unclassified';
 }
}

export async function readOkbExport(data:Buffer){
 checkWorkbookZip(data);
 let sheets:Awaited<ReturnType<typeof readXlsxFile>>;
 try{sheets=await readXlsxFile(data);}catch{throw new AppError(400,'Не удалось прочитать выгрузку ОКБ в формате XLSX.');}
 const matches=sheets.map(sheet=>({sheet,header:sheet.data.findIndex(row=>fields.every(field=>row.some(cell=>key(clean(cell))===columns[field])))})).filter(match=>match.header>=0);
 assert(matches.length===1,400,'Нужен один лист с семью колонками выгрузки ОКБ.');
 const {sheet,header}=matches[0];
 const titles=sheet.data[header].map(cell=>key(clean(cell)));
 assert(fields.every(field=>titles.filter(title=>title===columns[field]).length===1),400,'В заголовке ОКБ повторяются колонки.');
 const positions=fields.map(field=>titles.indexOf(columns[field]));
 const seenNames=new Set<string>(),seen1c=new Set<string>(),rows:{line:number;source:Source}[]=[];
 for(const [index,row] of sheet.data.slice(header+1).entries()){
  const values=positions.map(position=>clean(row[position]));
  if(!values.some(Boolean))continue;
  const line=header+index+2;
  const source=Object.fromEntries(fields.map((field,i)=>[field,values[i]])) as Source;
  assert(source.name.length>=2&&source.name.length<=250&&values.every(value=>value.length<=1000),400,`Строка ${line}: проверьте название и длину полей.`);
  const name=key(source.name),name1c=key(source.name1c);
  assert(!seenNames.has(name)&&!(name1c&&seen1c.has(name1c)),400,`Строка ${line}: название компании или название из 1С повторяется в выгрузке.`);
  seenNames.add(name);if(name1c)seen1c.add(name1c);
  rows.push({line,source});
  assert(rows.length<=20000,400,'В одной выгрузке ОКБ допускается до 20 000 компаний.');
 }
 assert(rows.length>0,400,'В выгрузке ОКБ нет компаний.');
 return rows;
}

export async function importOkbExport(data:Buffer,apply=false){
 const rows=await readOkbExport(data),db=await okbPool().connect();
 try{
  await db.query('BEGIN');
  const {rows:[target]}=await db.query('SELECT current_database() AS name');
  assert(target.name==='ruspet_okb',409,'Импорт ожидает отдельную БД ruspet_okb.');
  await db.query('SELECT pg_advisory_xact_lock(431031)');
  const existing=(await db.query<Company>('SELECT id,name,status,xlsx_source FROM companies')).rows;
  const nameMatches=new Map<string,Company>(),oneCMatches=new Map<string,Company>();
  const otherNames=new Set<string>();
  for(const company of existing){
   const source=company.xlsx_source;
   if(!source){otherNames.add(key(company.name));continue;}
   nameMatches.set(key(source.name),company);
   if(source.name1c)oneCMatches.set(key(source.name1c),company);
  }
  const used=new Set<string>(),changes:{id:string;name:string;status:string;source:Source}[]=[];
  const counts={rows:rows.length,created:0,updated:0,unchanged:0,unclassified:0};
  for(const {line,source} of rows){
   const name=key(source.name),name1c=key(source.name1c);
   const byName=nameMatches.get(name),by1c=oneCMatches.get(name1c),match=by1c??byName;
   const old=match?.xlsx_source;
   assert(!(by1c&&byName&&by1c.id!==byName.id)&&!(match&&used.has(match.id))&&
    !(byName?.xlsx_source?.name1c&&name1c&&key(byName.xlsx_source.name1c)!==name1c)&&
    !(!match&&otherNames.has(name)),409,`Строка ${line}: неоднозначное совпадение с существующей карточкой ОКБ.`);
   if(match)used.add(match.id);
   if(old?.name1c&&!source.name1c)source.name1c=old.name1c;
   const importedStatus=status(source.type);
   if(importedStatus==='unclassified')counts.unclassified++;
   if(old&&fields.every(field=>old[field]===source[field])){counts.unchanged++;continue;}
   if(match)counts.updated++;else counts.created++;
   changes.push({id:match?.id??randomUUID(),
    name:match&&old&&match.name!==old.name?match.name:source.name,
    status:match&&old&&match.status!==status(old.type)?match.status:importedStatus,source});
  }
  if(apply&&changes.length)await db.query(`INSERT INTO companies(id,name,status,xlsx_source,contact,notes)
   SELECT id,name,status,source,'','' FROM jsonb_to_recordset($1::jsonb) AS c(id uuid,name text,status text,source jsonb)
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,status=excluded.status,xlsx_source=excluded.xlsx_source,
   version=companies.version+1,updated_at=clock_timestamp()`,[JSON.stringify(changes)]);
  await db.query(apply?'COMMIT':'ROLLBACK');
  return {applied:apply,...counts};
 }catch(error){await db.query('ROLLBACK');throw error;}
 finally{db.release();}
}
