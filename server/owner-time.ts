import {readFileSync} from 'node:fs';
import {Router} from 'express';
import {z} from 'zod';
import {pool,transaction,type Db} from './db.js';
import {assert} from './domain.js';
import type {User} from '../shared/types.js';

const initialDate='2026-11-13';
const initialPlan=JSON.parse(readFileSync(new URL('./time/initial-plan.json',import.meta.url),'utf8'));
const daySchema=z.iso.date().refine(value=>value>='1900-01-01'&&value<'9999-01-01');
const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const planSchema=z.array(z.object({
 start:clock.or(z.literal('')),end:clock.or(z.literal('')),title:z.string().trim().min(1).max(200),
 items:z.array(z.object({id:z.string().min(1).max(80),text:z.string().trim().min(1).max(400),done:z.boolean()})).max(20)
}).refine(block=>!block.start||!block.end||block.start<block.end)).max(30);
const workSchema=z.object({minutes:z.number().int().min(0).max(1440).nullable(),note:z.string().trim().max(2000),loggedAt:z.iso.datetime().nullable()});
type Work={minutes:number|null;note?:string};
type Day={date:string;minutes:number|null;note:string;loggedAt:string|null;plan:z.infer<typeof planSchema>|null};
const emptyDay=(date:string):Day=>({date,minutes:null,note:'',loggedAt:null,plan:null});
const dayFields='work_date AS date,worked_minutes AS minutes,note,logged_at AS "loggedAt",plan';
const moscowFormatter=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const moscowTime=(now:Date)=>moscowFormatter.format(now).split(' ');
export const formatWork=(minutes:number)=>`${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,'0')}`;

export function parseWork(text:string):Work|null{
 const value=text.trim(),separator=/\r?\n|\s+[—–-]\s+/.exec(value);
 const duration=(separator?value.slice(0,separator.index):value).trim();
 const note=separator?value.slice(separator.index+separator[0].length).trim():undefined;
 const clockMatch=/^(\d{1,2}):([0-5]\d)$/.exec(duration);
 const unitMatch=/^(\d{1,2})\s*ч(?:\s*(\d{1,2})\s*(?:м|мин))?$/iu.exec(duration);
 const decimalMatch=/^\d{1,2}(?:[.,]\d{1,2})?$/.test(duration);
 let minutes:number;
 if(clockMatch)minutes=Number(clockMatch[1])*60+Number(clockMatch[2]);
 else if(unitMatch&&Number(unitMatch[2]||0)<60)minutes=Number(unitMatch[1])*60+Number(unitMatch[2]||0);
 else if(decimalMatch)minutes=Math.round(Number(duration.replace(',','.'))*60);
 else return null;
 return minutes<=1440&&(note?.length??0)<=2000?{minutes,note}:null;
}

async function saveWork(db:Db,userId:string,date:string,work:Work,expected?:string|null){
 const result=await db.query<Day>(`
  INSERT INTO owner_time_days AS d(user_id,work_date,worked_minutes,note,logged_at)
  SELECT $1,$2,$3,COALESCE($4,''),clock_timestamp()
  WHERE NOT $6::boolean OR $5::timestamptz IS NULL OR EXISTS
   (SELECT 1 FROM owner_time_days WHERE user_id=$1 AND work_date=$2)
  ON CONFLICT(user_id,work_date) DO UPDATE SET
   worked_minutes=excluded.worked_minutes,note=COALESCE($4,d.note),logged_at=clock_timestamp()
  WHERE NOT $6::boolean OR date_trunc('milliseconds',d.logged_at) IS NOT DISTINCT FROM $5::timestamptz
  RETURNING ${dayFields}`,[userId,date,work.minutes,work.note??null,expected??null,expected!==undefined]);
 assert(result.rowCount,409,'Запись уже изменилась. Обновите месяц и проверьте часы.');
 return result.rows[0];
}
async function monthDays(userId:string,month:unknown){
 const monthValue=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(month);
 const first=daySchema.parse(monthValue+'-01');
 const rows=(await pool.query<Day>(`SELECT ${dayFields} FROM owner_time_days
  WHERE user_id=$1 AND work_date >= $2::date AND work_date < $2::date + interval '1 month' ORDER BY work_date`,[userId,first])).rows;
 const index=new Map(rows.map(row=>[row.date,row]));
 const year=Number(first.slice(0,4)),number=Number(first.slice(5,7));
 return Array.from({length:new Date(Date.UTC(year,number,0)).getUTCDate()},(_,i)=>{
  const date=monthValue+'-'+String(i+1).padStart(2,'0'),day=index.get(date)||emptyDay(date);
  return {...day,plan:day.plan??(date===initialDate?initialPlan:null),initialPlan:date===initialDate&&day.plan===null};
 });
}
const csvCell=(value:string)=>'"'+(/^[\s]*[=+@-]/.test(value)?"'":"")+value.replaceAll('"','""')+'"';

export function ownerTimeRouter(){
 const router=Router();
 router.use((req,_res,next)=>{assert(req.actor?.root_access,403,'Планер доступен владельцу.');next();});
 router.get('/month',async(req,res)=>{
  const days=await monthDays(req.actor.id,req.query.month);
  const [today]=moscowTime(new Date());
  const status=(await pool.query(`SELECT s.enabled AS "botEnabled",
    EXISTS(SELECT 1 FROM telegram_binding WHERE user_id=$1) AS linked,
    COALESCE((SELECT reminders FROM owner_time_preferences WHERE user_id=$1),true) AS reminders,
    (SELECT state FROM owner_time_prompts WHERE user_id=$1 AND work_date=$2) AS "promptState"
    FROM telegram_settings s WHERE s.id=1`,[req.actor.id,today])).rows[0];
  res.json({today,days,status});
 });
 router.get('/report.csv',async(req,res)=>{
  const days=await monthDays(req.actor.id,req.query.month);
  const rows=[
   ['Дата','Отработано (ч:мин)','Что сделано'],
   ...days.map(day=>[day.date,day.minutes===null?'':formatWork(day.minutes),day.note]),
   ['Итого',formatWork(days.reduce((sum,day)=>sum+(day.minutes??0),0)),'']
  ];
  res.attachment(`ruspet-time-${days[0].date.slice(0,7)}.csv`).type('text/csv').send('\uFEFF'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n'));
 });
 router.put('/days/:date/work',async(req,res)=>{
  const date=daySchema.parse(req.params.date),input=workSchema.parse(req.body);
  assert(date<=moscowTime(new Date())[0],400,'Фактические часы можно записать за сегодня или прошедший день.');
  res.json(await saveWork(pool,req.actor.id,date,input,input.loggedAt));
 });
 router.put('/days/:date/plan',async(req,res)=>{
  const date=daySchema.parse(req.params.date),plan=planSchema.parse(req.body);
  await pool.query(`INSERT INTO owner_time_days(user_id,work_date,plan) VALUES($1,$2,$3)
   ON CONFLICT(user_id,work_date) DO UPDATE SET plan=excluded.plan`,[req.actor.id,date,JSON.stringify(plan)]);
  res.json({plan});
 });
 router.put('/reminders',async(req,res)=>{
  const {enabled}=z.object({enabled:z.boolean()}).parse(req.body);
  await pool.query(`INSERT INTO owner_time_preferences(user_id,reminders) VALUES($1,$2)
   ON CONFLICT(user_id) DO UPDATE SET reminders=excluded.reminders`,[req.actor.id,enabled]);
  res.json({enabled});
 });
 return router;
}

export async function sendOwnerTimePrompt(now:Date,send:(chat:string,text:string)=>Promise<number>){
 const [date,time]=moscowTime(now);
 if(time<'21:00')return;
 const prompt=(await pool.query<{user_id:string;binding_id:number;chat_id:string}>(`
  WITH eligible AS (
   SELECT u.id,b.id AS binding_id,b.chat_id FROM users u JOIN telegram_binding b ON b.user_id=u.id
   JOIN telegram_settings s ON s.id=1 AND s.enabled
   LEFT JOIN owner_time_preferences p ON p.user_id=u.id
   WHERE u.root_access AND b.chat_id ~ '^[1-9][0-9]{0,15}$' AND COALESCE(p.reminders,true)
    AND EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)
  ), claimed AS (
   INSERT INTO owner_time_prompts(user_id,work_date,binding_id,state)
   SELECT id,$1,binding_id,'sending' FROM eligible
   ON CONFLICT(user_id,work_date) DO NOTHING RETURNING user_id,binding_id
  )
  SELECT c.*,e.chat_id FROM claimed c JOIN eligible e ON e.id=c.user_id`,[date])).rows[0];
 if(!prompt)return;
 const label=date.split('-').reverse().join('.');
 let messageId:number;
 try{
  messageId=await send(prompt.chat_id,`Сколько времени вы работали ${label}?\n\nОтветьте, например, «7:30». Со следующей строки можно написать, что сделали. Запись появится в личном планере.`);
 }catch{
  await pool.query("UPDATE owner_time_prompts SET state='unconfirmed' WHERE user_id=$1 AND work_date=$2",[prompt.user_id,date]);
  return;
 }
 await pool.query("UPDATE owner_time_prompts SET state='sent',message_id=$3 WHERE user_id=$1 AND work_date=$2",[prompt.user_id,date,messageId]);
}

type OwnerMessage={message_id:number;date:number;text?:string;chat?:{id:number;type:string};from?:{id:number;is_bot?:boolean};reply_to_message?:{message_id:number;from?:{is_bot?:boolean}}};
export async function ownerTimeReply(user:User,message:OwnerMessage){
 const chat=String(message.chat?.id);
 if(!user.root_access||message.chat?.type!=='private'||!message.from||message.from.is_bot||String(message.from.id)!==chat)return null;
 const text=message.text?.trim()??'';
 const command=/^\/time(?:\s|$)/.test(text);
 const original=message.reply_to_message?.from?.is_bot?message.reply_to_message.message_id:null;
 if(!command&&!original)return null;
 return transaction(async db=>{
  const binding=(await db.query<{id:number}>(`SELECT b.id FROM telegram_binding b JOIN users u ON u.id=b.user_id
   WHERE u.id=$1 AND u.root_access AND b.chat_id=$2
    AND EXISTS(SELECT 1 FROM login_accounts a WHERE a.user_id=u.id AND a.enabled)
   FOR UPDATE OF b`,[user.id,chat])).rows[0];
  if(!binding)return null;
  const prompt=original?(await db.query<{work_date:string}>(`SELECT work_date FROM owner_time_prompts
   WHERE user_id=$1 AND binding_id=$2 AND message_id=$3 AND state='sent'`,[user.id,binding.id,original])).rows[0]:null;
  if(!command&&!prompt)return null;
  const work=parseWork(command?text.slice(5).trim():text);
  if(!work)return 'Укажите время, например 7:30. Что сделали, можно добавить с новой строки.';
  const date=prompt?.work_date??moscowTime(new Date(message.date*1000))[0];
  const fresh=await db.query('INSERT INTO owner_time_replies(binding_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[binding.id,message.message_id]);
  if(fresh.rowCount)await saveWork(db,user.id,date,work);
  return fresh.rowCount
   ?`В планере за ${date.split('-').reverse().join('.')} записано ${formatWork(work.minutes!)}.`
   :'Этот ответ уже обработан. Текущую запись можно посмотреть в планере.';
 });
}
