import {transaction} from './db.js';
import {assert} from './domain.js';
import {event} from './service.js';
import {pilotReadiness} from './pilot-readiness.js';
import type {User} from '../shared/types.js';

export async function setOwnerBitrixExchange(actor:User,enabled:boolean){
 assert(actor.root_access,403,'Обменом с Битрикс24 управляет владелец.');
 if(enabled){
  assert(process.env.BITRIX_WRITE_ENABLED==='true',409,'Сначала настройте рабочий обработчик Битрикс24 на сервере.');
  assert((await pilotReadiness()).ready,409,'Сначала устраните блокирующие пункты в проверке готовности.');
 }
 return transaction(async db=>{
  const result=await db.query('UPDATE bitrix_live_config SET enabled=$1,updated_at=now() WHERE id=1 AND enabled<>$1 RETURNING id',[enabled]);
  if(result.rowCount)await event(db,null,actor.id,'bitrix_exchange_changed',enabled?'Владелец включил обмен с Битрикс24':'Владелец приостановил обмен с Битрикс24',{enabled});
  return {enabled};
 });
}
