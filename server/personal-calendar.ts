import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {assert,canSee} from './domain.js';
import {pool,transaction,type Db} from './db.js';
import {event} from './service.js';
import {businessDay} from '../shared/queues.js';
import {compactTaskTitle} from '../shared/task-title.js';
import {canLogStaffWork,isSalesManager,type CalendarTask,type PersonalCalendarMonth,type StaffWorkDay,type TaskPersonalPlan} from '../shared/personal-calendar.js';
import type {Task,User} from '../shared/types.js';

type PlanRow={assignment_epoch:number;revision:number;requires_acceptance:boolean;accepted_at:string|null;planned_at:string|null;next_step:string};
const taskEpoch=(task:Task)=>task.assignment_epoch??1;
const planReminderTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const emptyPlan=(task:Task):TaskPersonalPlan=>({epoch:taskEpoch(task),revision:0,needsAcceptance:false,acceptedAt:null,plannedAt:null});
const ownPlan=(p:PlanRow):TaskPersonalPlan=>({epoch:p.assignment_epoch,revision:p.revision,
 needsAcceptance:p.requires_acceptance&&!p.accepted_at,acceptedAt:p.accepted_at,plannedAt:p.planned_at,nextStep:p.next_step});
export const taskPlanInput=z.object({epoch:z.number().int().positive(),revision:z.number().int().nonnegative(),
 plannedAt:z.iso.datetime({offset:true}),accept:z.boolean(),nextStep:z.string().trim().max(500).optional()});
export const staffWorkInput=z.object({minutes:z.number().int().min(0).max(1440).nullable(),
 note:z.string().trim().max(2000),revision:z.number().int().nonnegative()});

export async function registerTaskAcceptance(db:Db,task:Task){
 if(task.status!=='active'||task.assignee_id===task.creator_id)return false;
 const user=(await db.query<User>('SELECT * FROM users WHERE id=$1',[task.assignee_id])).rows[0];
 if(!user||user.root_access||!(isSalesManager(user)||/^тестовый менеджер$/iu.test(user.position.trim()))||!canSee(user,task))return false;
 await db.query(`INSERT INTO personal_task_plans(task_id,assignment_epoch,user_id,requires_acceptance)
  VALUES($1,$2,$3,true) ON CONFLICT(task_id,assignment_epoch) DO NOTHING`,[task.id,taskEpoch(task),user.id]);
 return true;
}

async function assignmentPlanRow(task:Task,db:Db){
 return (await db.query<PlanRow>('SELECT * FROM personal_task_plans WHERE task_id=$1 AND assignment_epoch=$2 AND user_id=$3',
  [task.id,taskEpoch(task),task.assignee_id])).rows[0];
}
export async function taskPersonalPlan(user:User,task:Task,db:Db=pool){
 if(task.assignee_id!==user.id||user.root_access)return null;
 const row=await assignmentPlanRow(task,db);
 const plan=row?ownPlan(row):emptyPlan(task);
 return task.status==='active'?plan:{...plan,needsAcceptance:false};
}
export async function taskAssignmentReceipt(task:Task,plan:TaskPersonalPlan|null,db:Db){
 const row=plan??await assignmentPlanRow(task,db).then(value=>value?ownPlan(value):null);
 if(!row||!row.acceptedAt&&(!row.needsAcceptance||task.status!=='active'))return null;
 return {state:row.needsAcceptance?'pending' as const:'accepted' as const,acceptedAt:row.acceptedAt};
}

export async function requireTaskAcceptance(user:User,task:Task,db:Db){
 if(user.id===task.assignee_id)
  assert(!(await taskPersonalPlan(user,task,db))?.needsAcceptance,409,'Сначала примите задачу и укажите плановое время.');
}
export async function pendingAssignmentTasks(user:User,taskIds:string[],db:Db){
 if(!taskIds.length)return [];
 return (await db.query<{id:string}>(`SELECT t.id FROM personal_task_plans p
  JOIN tasks t ON t.id=p.task_id AND t.assignment_epoch=p.assignment_epoch AND t.assignee_id=p.user_id
  WHERE p.user_id=$1 AND t.id=ANY($2) AND t.status='active' AND p.requires_acceptance AND p.accepted_at IS NULL ORDER BY t.id`,
 [user.id,taskIds])).rows.map(row=>row.id);
}

export async function saveTaskPlan(user:User,id:string,input:z.infer<typeof taskPlanInput>){
 return transaction(async db=>{
  const task=(await db.query<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
  assert(task&&canSee(user,task),404,'Задача недоступна.');
  const current=await taskPersonalPlan(user,task,db);
  assert(current,403,'План задачи может заполнить только исполнитель.');
  assert(task.status==='active',409,'План можно изменить, пока задача в работе.');
  assert(current.epoch===input.epoch,409,'Исполнитель задачи изменился. Откройте актуальную карточку.');
  const when=new Date(input.plannedAt),now=Date.now();
  assert(Number.isFinite(+when),400,'Укажите корректную дату и время.');
  const plannedAt=when.toISOString();
  // Repeating an already saved form is harmless after a lost response.
  const nextStep=input.nextStep??current.nextStep??'';
  if(current.plannedAt===plannedAt&&nextStep===(current.nextStep??'')&&(!input.accept||current.acceptedAt))return current;
  assert(current.revision===input.revision,409,'План уже изменился. Обновите карточку.');
  assert(current.needsAcceptance===input.accept,409,current.needsAcceptance?'Сначала примите задачу.':'Назначение уже принято.');
  assert(+when>now,400,'Выберите будущее плановое время.');
  const row=(await db.query<PlanRow>(`INSERT INTO personal_task_plans AS p(task_id,assignment_epoch,user_id,planned_at,revision,next_step)
   VALUES($1,$2,$3,$4,1,$6) ON CONFLICT(task_id,assignment_epoch) DO UPDATE SET
   planned_at=excluded.planned_at,next_step=excluded.next_step,revision=p.revision+1,
   accepted_at=CASE WHEN $5 THEN clock_timestamp() ELSE p.accepted_at END RETURNING *`,
  [id,current.epoch,user.id,plannedAt,input.accept,nextStep])).rows[0];
  await db.query(`UPDATE task_alerts SET canceled_at=now() WHERE task_id=$1 AND recipient_id=$2
   AND personal_plan_epoch=$3 AND acknowledged_at IS NULL AND canceled_at IS NULL`,[id,user.id,current.epoch]);
  await db.query(`UPDATE outbox SET withdrawn_at=now() WHERE task_id=$1 AND recipient_id=$2
   AND personal_plan_alert_id IS NOT NULL AND read_at IS NULL AND withdrawn_at IS NULL`,[id,user.id]);
  const lead=+when-now>30*60000?30:+when-now>10*60000?10:0;
  const due=new Date(+when-lead*60000),expires=new Date(+when+60*60000);
  const time=planReminderTime.format(when);
  const body=`Ваш план на ${time} МСК\n#${id} · ${compactTaskTitle(task.title,160)}${nextStep?'\nСледующий шаг: '+nextStep:''}`;
  await db.query(`INSERT INTO task_alerts(id,dedupe_key,recipient_id,task_id,kind,body,due_at,expires_at,personal_plan_epoch)
   VALUES($1,$2,$3,$4,'task',$5,$6,$7,$8)`,[randomUUID(),`personal-plan:${id}:${current.epoch}:${row.revision}`,
   user.id,id,body,due.toISOString(),expires.toISOString(),current.epoch]);
  if(input.accept){
   await db.query(`UPDATE outbox SET read_at=coalesce(read_at,now()) WHERE task_assignment AND task_id=$1 AND recipient_id=$2
    AND withdrawn_at IS NULL`,[id,user.id]);
   await event(db,id,user.id,'assignment_accepted','Исполнитель принял задачу');
  }
  return ownPlan(row);
 });
}

export const calendarMonthInput=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export async function personalCalendar(user:User,month:string,db:Db=pool,now=new Date()):Promise<PersonalCalendarMonth>{
 const first=calendarMonthInput.parse(month)+'-01';
 const plans=(await db.query<Task&PlanRow>(`SELECT t.*,p.requires_acceptance,p.accepted_at,p.planned_at,p.revision,p.next_step
  FROM personal_task_plans p JOIN tasks t ON t.id=p.task_id AND t.assignment_epoch=p.assignment_epoch AND t.assignee_id=p.user_id
  WHERE p.user_id=$1 AND (p.planned_at >= $2::date::timestamp AT TIME ZONE 'Europe/Moscow'
   AND p.planned_at < ($2::date+interval '1 month') AT TIME ZONE 'Europe/Moscow'
   OR p.requires_acceptance AND p.accepted_at IS NULL AND t.status='active')
  ORDER BY p.planned_at NULLS LAST,t.updated_at DESC,t.id`,[user.id,first])).rows.filter(task=>canSee(user,task));
 const deadlines=(await db.query<Task>(`SELECT * FROM tasks WHERE assignee_id=$1 AND status<>'completed'
  AND deadline >= $2::date::timestamp AT TIME ZONE 'Europe/Moscow'
  AND deadline < ($2::date+interval '1 month') AT TIME ZONE 'Europe/Moscow' ORDER BY deadline,id`,[user.id,first])).rows
  .filter(task=>canSee(user,task)).map(({id,title,deadline,status})=>({id,title,deadline,status}));
 const canLogWork=canLogStaffWork(user);
 const work=canLogWork?(await db.query<StaffWorkDay>(`SELECT work_date date,worked_minutes minutes,note,revision FROM staff_work_days
  WHERE user_id=$1 AND work_date >= $2 AND work_date < $2::date+interval '1 month' ORDER BY work_date`,[user.id,first])).rows:[];
 const compact=(row:Task&PlanRow):CalendarTask=>({id:row.id,title:row.title,deadline:row.deadline,status:row.status,plan:ownPlan(row)});
 return {today:businessDay(now),canLogWork,work,deadlines,scheduled:plans.filter(p=>p.planned_at).map(compact),
  awaiting:plans.filter(p=>p.status==='active'&&p.requires_acceptance&&!p.accepted_at).map(compact)};
}

export async function saveStaffWork(user:User,date:string,input:z.infer<typeof staffWorkInput>){
 assert(canLogStaffWork(user),403,'Учёт часов недоступен для вашей должности.');
 assert(date<=businessDay(new Date()),400,'Фактические часы можно записать за сегодня или прошедший день.');
 const result=await pool.query<StaffWorkDay>(`INSERT INTO staff_work_days AS d(user_id,work_date,worked_minutes,note)
  SELECT $1,$2,$3,$4 WHERE $5=0 OR EXISTS(SELECT 1 FROM staff_work_days WHERE user_id=$1 AND work_date=$2)
  ON CONFLICT(user_id,work_date) DO UPDATE SET worked_minutes=excluded.worked_minutes,note=excluded.note,revision=d.revision+1
  WHERE d.revision=$5 RETURNING work_date date,worked_minutes minutes,note,revision`,[user.id,date,input.minutes,input.note,input.revision]);
 assert(result.rowCount,409,'Часы уже изменились. Обновите календарь.');
 return result.rows[0];
}

export const validPlanAlert=`EXISTS(SELECT 1 FROM tasks t WHERE t.id=a.task_id AND t.status='active'
 AND t.assignee_id=a.recipient_id AND t.assignment_epoch=a.personal_plan_epoch)`;
export const visiblePlanNotice=`(o.personal_plan_alert_id IS NULL OR o.read_at IS NOT NULL OR EXISTS(
 SELECT 1 FROM task_alerts a WHERE a.id=o.personal_plan_alert_id
 AND a.canceled_at IS NULL AND ${validPlanAlert}))`;

export async function generateWebPlanNotices(now=new Date()){
 await pool.query(`INSERT INTO outbox(id,task_id,recipient_id,body,dedupe_key,created_at,personal_plan_alert_id)
  SELECT gen_random_uuid(),a.task_id,a.recipient_id,a.body,'personal-plan-notice:'||a.id,$1,a.id
  FROM task_alerts a WHERE a.personal_plan_epoch IS NOT NULL AND a.canceled_at IS NULL AND a.acknowledged_at IS NULL
   AND a.due_at<=$1 AND a.expires_at>$1 AND ${validPlanAlert}
  ON CONFLICT(dedupe_key) DO NOTHING`,[now.toISOString()]);
}
