import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {pool} from '../server/db.js';
import {closeOkb} from '../server/okb.js';
import {assert,AppError} from '../server/domain.js';
import {bitrixClient,BitrixError} from '../server/bitrix-rest.js';
import {fetchBitrixCompanies,syncCompanySnapshots} from '../server/company-responsibility.js';
import type {User} from '../shared/types.js';

const {values}=parseArgs({options:{actor:{type:'string'},apply:{type:'boolean'},watch:{type:'boolean'},'max-pages':{type:'string',default:'100'},after:{type:'string',default:'0'}}});
let stopped=false;process.once('SIGTERM',()=>{stopped=true;});process.once('SIGINT',()=>{stopped=true;});
try{
 assert(values.actor,400,'Укажите --actor с ID администратора.');
 assert(!values.watch||values.apply,400,'Периодический импорт требует --apply.');
 assert(!values.watch||values.after==='0',400,'Периодическая синхронизация требует полного обхода с --after 0.');
 const pages=Number(values['max-pages']);assert(Number.isInteger(pages)&&pages>=1&&pages<=1000,400,'--max-pages: от 1 до 1000.');
 const actor=(await pool.query<User>('SELECT * FROM users WHERE id=$1',[values.actor])).rows[0];
 assert(actor?.role==='admin',403,'Импорт выполняет администратор.');
 const request=await bitrixClient();
 do{
  let after=values.after!,complete=false,total=0;
  for(let page=0;page<pages&&!stopped;page++){
   const result=await fetchBitrixCompanies(request,after);
   if(result.companies.length)await syncCompanySnapshots(actor,{portal:process.env.BITRIX_PORTAL,dryRun:!values.apply,companies:result.companies});
   total+=result.companies.length;after=result.cursor;complete=result.complete;
   if(complete)break;
  }
  console.log(JSON.stringify({dryRun:!values.apply,processed:total,after,complete}));
  assert(complete||stopped,409,'Достигнут предел страниц. Продолжите с --after из последнего результата; полный обход не завершён.');
  // A fresh full scan also catches reassignment of an older company.
  if(values.watch&&!stopped)for(let minute=0;minute<15&&!stopped;minute++)await delay(60000);
 }while(values.watch&&!stopped);
}catch(error){console.error(error instanceof AppError||error instanceof BitrixError?error.message:'Импорт компаний остановлен. Проверьте настройки, схему ОКБ и доступность БД. Значения доступа не выводятся.');process.exitCode=1;}
finally{await closeOkb();await pool.end();}
