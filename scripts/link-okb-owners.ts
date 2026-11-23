import {randomUUID} from 'node:crypto';
import {pool} from '../server/db.js';
import {closeOkb,okbPool} from '../server/okb.js';

const words=(name:string)=>name.normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё','е').match(/[\p{L}-]+/gu)??[];
const key=(parts:string[])=>[...parts].sort().join(' ');
async function link(apply:boolean){
 const users=(await pool.query<{id:string;name:string;eligible:boolean}>(`SELECT u.id,u.name,
  (u.role IN ('employee','branch_manager','sales_head') AND NOT u.root_access AND u.branch_id<>'Учебный доступ'
   AND (NOT EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id)
    OR EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled))) AS eligible FROM users u`)).rows;
 const byName=new Map<string,Set<string>>();
 for(const u of users){
  const tokens=words(u.name);
  const keys=[key(tokens)];
  if(tokens.length===3){
   for(let skip=0;skip<3;skip++)keys.push(key(tokens.filter((_,i)=>i!==skip)));
  }
  for(const pattern of keys){
   if(!byName.has(pattern))byName.set(pattern,new Set());
   byName.get(pattern)!.add(u.id);
  }
 }
 const eligible=new Set(users.filter(user=>user.eligible).map(user=>user.id));
 const db=await okbPool().connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(431031)');
  const rows=(await db.query<{id:string;legacy:string}>(`SELECT id,xlsx_source->>'manager' legacy FROM companies
   WHERE manager_id IS NULL AND bitrix_id IS NULL AND bitrix_deleted_at IS NULL AND coalesce(xlsx_source->>'manager','')<>''`)).rows;
  const updates=rows.flatMap(row=>{
   const tokens=words(row.legacy);
   if(tokens.length<2||tokens.some(token=>token.length<2))return [];
   const matches=byName.get(key(tokens));
   const id=matches?.size===1?[...matches][0]:null;
   return id&&eligible.has(id)?[{id:row.id,owner:id,event:randomUUID()}]:[];
  });
  if(apply&&updates.length)await db.query(`WITH incoming AS (
   SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,owner text,event uuid)
  ), changed AS (
   UPDATE companies c SET manager_id=i.owner,manager_source='manual',version=c.version+1,updated_at=now()
   FROM incoming i WHERE c.id=i.id AND c.manager_id IS NULL AND c.bitrix_id IS NULL RETURNING c.id,c.manager_id,i.event
  ) INSERT INTO company_responsibility_events(id,company_id,source,before_value,after_value)
   SELECT event,id,'manual','{"managerId":null}'::jsonb,jsonb_build_object('managerId',manager_id,'origin','xlsx') FROM changed`,[JSON.stringify(updates)]);
  await db.query(apply?'COMMIT':'ROLLBACK');
  return {apply,eligible:rows.length,matched:updates.length,toReview:rows.length-updates.length};
 }catch(error){await db.query('ROLLBACK');throw error;}
 finally{db.release();}
}
const apply=process.argv[2]==='--apply';
try{console.log(JSON.stringify(await link(apply)));}
finally{await closeOkb();await pool.end();}
