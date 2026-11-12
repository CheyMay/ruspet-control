import {pool,transaction} from './db.js';
import {BitrixError,type BitrixRequest} from './bitrix-rest.js';
import {bitrixId} from './bitrix-sync.js';
let nextPoll=0;
/** This feed is shared per Bitrix user. Explicit exclusive-account configuration is mandatory. */
export async function processBitrixImEvents(request:BitrixRequest){
 if(process.env.BITRIX_IM_EVENTS_EXCLUSIVE!=='true'||Date.now()<nextPoll)return false;
 nextPoll=Date.now()+15000;
 try{
  const state=(await pool.query('SELECT * FROM bitrix_im_state WHERE id=1')).rows[0];
  if(!state.subscribed_at||Date.now()-Date.parse(state.subscribed_at)>12*3600000){
   await request('im.v2.Event.subscribe',{});
   await pool.query('UPDATE bitrix_im_state SET subscribed_at=now() WHERE id=1');
  }
  const result=await request<{events:{eventId:unknown;type:string;data:any}[];nextOffset:unknown;hasMore:boolean}>('im.v2.Event.get',{offset:Number(state.next_offset),limit:100});
  const next=String(result.nextOffset);
  if(!Array.isArray(result.events)||!/^\d+$/.test(next)||BigInt(next)<BigInt(state.next_offset))throw new BitrixError('Неверный курсор событий чата.');
  if(result.events.some(event=>!bitrixId(event.eventId)||BigInt(String(event.eventId))<BigInt(state.next_offset)||BigInt(String(event.eventId))>=BigInt(next)))throw new BitrixError('События чата вышли за границы курсора.');
  await transaction(async db=>{
   for(const event of result.events){
    const names:Record<string,string>={ONIMV2MESSAGEADD:'ONTASKCOMMENTADD',ONIMV2MESSAGEUPDATE:'ONTASKCOMMENTUPDATE',ONIMV2MESSAGEDELETE:'ONTASKCOMMENTDELETE'};
    if(!names[event.type])continue;
    const chatId=bitrixId(event.data?.chat?.id),messageId=bitrixId(event.data?.message?.id??event.data?.messageId);
    if(!chatId||!messageId)throw new BitrixError('Нет ID события сообщения.');
    const link=(await db.query("SELECT l.external_id FROM bitrix_task_links l JOIN bitrix_task_snapshots s ON s.external_id=l.external_id WHERE s.raw_snapshot->>'chatId'=$1",[chatId])).rows[0];
    if(!link)continue; // Never copy unrelated private conversations.
    await db.query(`INSERT INTO bitrix_comment_events(task_external_id,transport,external_id,event) VALUES($1,'chat',$2,$3)
     ON CONFLICT(task_external_id,transport,external_id) DO UPDATE SET event=excluded.event,revision=bitrix_comment_events.revision+1,processed_at=NULL,last_error=NULL`,[link.external_id,messageId,names[event.type]]);
   }
   // Only the next network request acknowledges this offset, after the local COMMIT.
   await db.query('UPDATE bitrix_im_state SET next_offset=$1,checked_at=now(),last_error=NULL WHERE id=1',[next]);
  });
  if(result.hasMore)nextPoll=0;
 }catch(e){
  nextPoll=Date.now()+60000;
  await pool.query('UPDATE bitrix_im_state SET last_error=$1 WHERE id=1',[e instanceof BitrixError?e.message:'Ошибка получения событий мессенджера.']);
 }
 return true;
}
