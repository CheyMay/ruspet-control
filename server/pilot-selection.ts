import {pool,transaction} from './db.js';
import {assert} from './domain.js';
import {requireArchiveAdmin} from './bitrix-archive.js';
import type {User} from '../shared/types.js';
export async function selectedPilotManagers(actor:User){
 requireArchiveAdmin(actor);
 const selected=(await pool.query('SELECT * FROM bitrix_pilot_selection ORDER BY ordinal')).rows;
 const result=[];
 for(const item of selected){
  const matches=(await pool.query('SELECT u.id,u.name,u.role,l.external_id FROM users u LEFT JOIN bitrix_user_links l ON l.user_id=u.id WHERE lower(trim(u.name))=lower($1)',[item.expected_name])).rows;
  result.push({...item,matches,ready:matches.length===1&&matches[0].role==='employee'&&!!matches[0].external_id});
 }
 return result;
}
export async function applySelectedManagers(actor:User){
 requireArchiveAdmin(actor);
 return transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431025)');
  assert(!(await db.query('SELECT enabled FROM bitrix_live_config WHERE id=1')).rows[0].enabled,409,'Сначала приостановите пилот.');
  const selected=await selectedPilotManagers(actor);
  assert(selected.length===2&&selected.every(s=>s.ready),409,'Подтвердите два однозначных профиля менеджеров и их ID Битрикс24.');
  const ids=selected.map(s=>s.matches[0].id);assert(new Set(ids).size===2,409,'Нужны два разных сотрудника.');
  await db.query("DELETE FROM bitrix_pilot_members WHERE pilot_role='manager'");
  for(const id of ids)await db.query("INSERT INTO bitrix_pilot_members(user_id,pilot_role) VALUES($1,'manager') ON CONFLICT(user_id) DO UPDATE SET pilot_role='manager'",[id]);
  return {managers:ids,enabled:false};
 });
}
