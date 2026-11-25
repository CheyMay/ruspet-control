import {importStaff,staffSummary} from './staff-import.js';
import {listRegistrations,reviewRegistration} from './telegram-onboarding.js';
import {telegramLoginRouter,sessionUser,clearBrowserLogin,setTelegramBinding,readCookie,sessionCookieOptions,sessionIdleInterval,touchSession} from './telegram-login.js';
import {receiveBitrixEvent} from './bitrix-events.js';
import {archiveStatus} from './bitrix-archive.js';
import {selectedPilotManagers} from './pilot-selection.js';
import {companyResponsibility,syncCompanySnapshots} from './company-responsibility.js';
import {myDelegations,orgDirectory,setManager,saveSubstitution,revokeSubstitution} from './org.js';
import {companyWork,listTaskTemplates,saveTaskTemplate,removeTaskTemplate} from './task-workspace.js';
import {dadataConfigured,suggestCompanies} from './dadata.js';
import {clientPeople,saveClientPerson,archiveClientPerson,listProducts,saveProduct,portfolioOverview} from './crm.js';
import {listCompanies,saveCompany,getCompany,companyContacts,recordCompanyContact} from './okb.js';
import {saveSchedule,listSchedules,toggleSchedule,saveProcess,listProcesses,previewProcess,toggleProcess} from './work-design.js';
import {taskInput,taskPriceInput} from './task-input.js';
import {formatPrice,priceLabels,priceBand} from '../shared/pricing.js';
import {changeUserAccount,createUserAccount} from './account-access.js';
import {createEmployeeProfile,linkStaffProfile,updateEmployeeProfile} from './employee-profiles.js';
import {setStaffRollout,setStaffWorkOverride,staffRolloutStatus} from './staff-rollout.js';
import {notificationPreference,notificationPreferenceInput,personalNotifications,readNotifications,saveNotificationPreference} from './notifications.js';
import {setOwnerBitrixExchange} from './owner-operations.js';
import {taskIntegration} from './bitrix-fields.js';
import {pilotReadiness,pilotQueue} from './pilot-readiness.js';
import {managementProgress,resetObservation,setNudgePreference,nudgeTeam} from './management.js';
import {lastUndo,staffUndoHistory,undoLastAction,undoStaffAction} from './undo.js';
import {listJournal} from './journal.js';
import {reportPdf} from './report-pdf.js';
import {taskSyncStatus} from './task-sync.js';
import {reminderInput,listTaskReminders,saveTaskReminder,disableTaskReminder,acknowledgeAlert,userAlerts} from './reminders.js';
import {botView,botClick,botText,clearBotDraft,botVoiceDraft,savedVoiceDraft,type BotScreen} from './bot.js';
import {taskGroups,createTaskGroup,groupTask,groupCompanyTask} from './task-groups.js';
import {clientNotes,addClientNote} from './client-notes.js';
import {parseMoscowInput} from './bot.js';
import {parseVoiceIntent} from './voice-intent.js';
import {resolveAssignee} from './bot-voice-actions.js';
import {browserAudioFormat,transcribeAudio,voiceEnabled} from './transcription.js';
import {voiceMaxBytes} from '../shared/voice.js';
import {pilotStatus,pairPilot,configurePilot} from './telegram-pilot.js';
import {removeWebPush,saveWebPush,webPushEndpoint,webPushStatus,webPushSubscription,testDevicePush} from './web-push.js';
import {printReport} from './report-print.js';
import express from 'express';
import compression from 'compression';
import {constants as zlib} from 'node:zlib';
import {verifyPassword} from './passwords.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { pool } from './db.js';
import {resolveTaskNumber} from './task-numbers.js';
import {workspaceSearch,workspaceSearchInput} from './workspace-search.js';
import { AppError, assert } from './domain.js';
import * as service from './service.js';
import {accessDirectory,systemStatus} from './system-status.js';
import {ownerTimeRouter} from './owner-time.js';
import {calendarMonthInput,personalCalendar,saveStaffWork,saveTaskPlan,staffWorkInput,taskPlanInput} from './personal-calendar.js';
import {analyticsOverview} from './team-analytics.js';
import {analyticsAccess} from './analytics-scope.js';
import {analyticsColumns,analyticsMetrics,waitingStages} from '../shared/team-analytics.js';
import {workspaceLabelKeys} from '../shared/workspace-labels.js';
import {operationsStatus,saveAutomation,retryJob,tick} from './automation.js';
import {classifyTaskBranch,createTask,createTaskCopy,delegateTask,delegationClients,delegationLinks,delegationTargets,editTask,editTaskPrice,newTaskAssignees,reviewTask,taskAssignees} from './workflow.js';
import {decideTaskEdit,requestTaskEdit} from './task-edit-permissions.js';
import {approvalHierarchy,setApprovalHierarchy,setApprovalWatch} from './approval-hierarchy.js';
import {directorBatchStatus,directorBatchTasks,sendDirectorBatch,weeklyDirectorTasks} from './management-notices.js';
import {taskWrite} from './task-write.js';
import {trainingMaterials} from '../shared/training-materials.js';
import type { User } from '../shared/types.js';
declare global { namespace Express { interface Request { actor:User } } }
const text=z.string().trim().min(1).max(4000), date=z.iso.datetime({offset:true});
const selector=z.enum(['branchManager','salesHead','director','creator']);
const rules=z.object({requiredPrice:z.boolean().optional(),showPlanning:z.boolean().optional(),writtenRules:z.array(z.object({text:z.string().trim().min(1).max(500),severity:z.enum(['critical','warning','info'])})).max(30).optional(),overdue:z.boolean(),missingDeadline:z.boolean(),plannedOverdue:z.boolean(),requiredFields:z.boolean(),code:z.boolean(),planning:z.boolean().optional(),responseMinLength:z.number().int().min(5).max(200),reminderMinutes:z.number().int().min(1).max(1440),maxReminders:z.number().int().min(0).max(10),routes:z.object({deadline:z.array(selector).min(1).max(4),completion:z.array(selector).min(1).max(4)})});
const reportView=z.enum(['mine','created','team','sales','company']);
const reportParameters=z.object({view:reportView.optional(),actorId:z.string().max(100).optional(),from:date.optional(),to:date.optional(),assigneeId:z.string().max(100).optional(),creatorId:z.string().max(100).optional(),priceBand:z.enum(['low','medium','high','premium','unknown']).optional(),queue:z.enum(['all','front','overdue','today','review','completed','no_deadline']).optional()});
const viewAsHeader='X-Ruspet-View-As';
const viewAsReads=new Set(['/bootstrap','/journal','/management/progress','/alerts','/delegations','/reports','/workspace-search']);
const viewAsTaskRead=/^\/tasks\/[^/]+(?:\/(?:integration|delegation|reminders|discussion|results))?$/;
const viewAsReportRead=/^\/reports\/[a-f0-9-]{36}$/i;
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
const webBotChannel=(req:express.Request)=>req.query.channel==='mobile'?'mobile':'preview';
export function createApp({managerPreview=false}:{managerPreview?:boolean}={}) {
 const app=express(); app.disable('x-powered-by');
 const compress=compression({level:3,brotli:{params:{[zlib.BROTLI_PARAM_QUALITY]:3}}});
 const voiceInputs=new Map<string,Promise<BotScreen>>();
 app.use('/api',async(req,res,next)=>{
  const target=req.get(viewAsHeader);
  if(target===undefined)return next();
  res.setHeader('Cache-Control','no-store');
  const token=req.headers.cookie?.split('; ').find(value=>value.startsWith('ruspet_session='))?.slice(15);
  const administrator=token?await sessionUser(token):null;
  assert(administrator,401,'Войдите в систему.');
  assert(administrator.role==='admin',403,'Просмотр от имени сотрудника доступен администратору.');
  assert(req.method==='GET'&&(viewAsReads.has(req.path)||viewAsTaskRead.test(req.path)||viewAsReportRead.test(req.path)),403,'В режиме просмотра доступны только рабочие данные для чтения.');
  let id:string;
  try{id=decodeURIComponent(target);}catch{throw new AppError(400,'Некорректный ID сотрудника.');}
  assert(id.length>0&&id.length<=100,400,'Некорректный ID сотрудника.');
  const user=(await pool.query<User>('SELECT * FROM users WHERE id=$1',[id])).rows[0];
  assert(user,404,'Сотрудник не найден.');
  assert(!user.root_access,403,'Для доступа владельца нужен отдельный вход.');
  req.actor=user;
  next();
 });
 app.use('/api/integrations/v1/companies/batch',express.json({limit:'512kb'})); app.use(express.json({limit:'32kb'}));
 app.post(['/api/bitrix/events','/integrations/bitrix/events'],express.urlencoded({extended:true,limit:'128kb',parameterLimit:1000}),express.json({limit:'128kb'}),async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await receiveBitrixEvent(req.body));});
 const loginAttempts=new Map<string,{count:number;since:number}>();
 app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'");next();});
 app.use('/api',(req,res,next)=>{res.setHeader('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.get('origin')){const allowed=[`http://${req.get('host')}`,'http://127.0.0.1:5173','http://localhost:5173'];if(process.env.PUBLIC_ORIGIN)allowed.push(new URL(process.env.PUBLIC_ORIGIN).origin);if(!allowed.includes(req.get('origin')!))return res.status(403).json({error:'Запрос с другого сайта запрещён.'});}next();});
 app.get('/api/health',async(_req,res)=>{await pool.query('SELECT 1');res.json({ok:true,database:'postgresql',taskProvider:'mock',telegram:(await pool.query('SELECT enabled FROM telegram_settings WHERE id=1')).rows[0]?.enabled?'personal-pilot':'disabled'});});
 app.get('/api/auth/mode',(_req,res)=>res.json({demo:process.env.DEMO_AUTH!=='false'}));
 app.use('/api/auth/qr',telegramLoginRouter());
 app.get('/api/demo/users',async(_req,res)=>{assert(process.env.DEMO_AUTH!=='false',403,'Демонстрационный вход отключён.');res.json((await pool.query('SELECT * FROM users WHERE NOT root_access ORDER BY id')).rows);});
 app.post('/api/demo/login',async(req,res)=>{
  assert(process.env.DEMO_AUTH!=='false',403,'Демонстрационный вход отключён.');
  const {userId}=z.object({userId:text}).parse(req.body);const user=(await pool.query('SELECT * FROM users WHERE id=$1',[userId])).rows[0];assert(user,400,'Пользователь не найден.');
  assert(!user.root_access,403,'Для доступа владельца нужен отдельный вход.');
  const old=req.headers.cookie?.split('; ').find(v=>v.startsWith('ruspet_session='))?.slice(15);if(old)await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hash(old)]);
  const token=randomBytes(32).toString('hex');await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3::interval)",[hash(token),userId,sessionIdleInterval]);
  res.cookie('ruspet_session',token,sessionCookieOptions());res.json({user});
 });
 app.post('/api/auth/login',async(req,res)=>{
  const key=req.ip||'unknown',now=Date.now(),attempt=loginAttempts.get(key);
  if(attempt&&now-attempt.since<60_000&&attempt.count>=8)throw new AppError(429,'Слишком много попыток. Повторите через минуту.');
  const {username,password}=z.object({username:z.string().trim().toLowerCase().min(3).max(32),password:z.string().min(1).max(200)}).parse(req.body);
  const account=(await pool.query('SELECT a.password_hash,u.* FROM login_accounts a JOIN users u ON u.id=a.user_id WHERE a.username=$1 AND a.enabled AND a.password_login',[username])).rows[0];
  if(!account||!await verifyPassword(password,account.password_hash)){loginAttempts.set(key,{count:now-(attempt?.since||0)<60_000?(attempt?.count||0)+1:1,since:now-(attempt?.since||0)<60_000?attempt!.since:now});throw new AppError(401,'Неверный логин или пароль.');}
  loginAttempts.delete(key);
  const token=randomBytes(32).toString('hex');await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3::interval)",[hash(token),account.id,sessionIdleInterval]);
  res.cookie('ruspet_session',token,sessionCookieOptions());
  await clearBrowserLogin(req,res);
  delete account.password_hash;res.json({user:account});
 });
 app.get('/api/auth/me',async(req,res)=>{const token=req.headers.cookie?.split('; ').find(v=>v.startsWith('ruspet_session='))?.slice(15);if(!token)return res.status(401).json({error:'Войдите в систему.'});const user=await sessionUser(token);if(!user)return res.status(401).json({error:'Сессия завершена.'});res.json(user);});
 app.post('/api/auth/logout',async(req,res)=>{const token=req.headers.cookie?.split('; ').find(v=>v.startsWith('ruspet_session='))?.slice(15);if(token)await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hash(token)]);await clearBrowserLogin(req,res);res.clearCookie('ruspet_session',{path:'/'});res.json({ok:true});});
 app.use('/api',async(req,_res,next)=>{if(req.actor)return next();const token=req.headers.cookie?.split('; ').find(v=>v.startsWith('ruspet_session='))?.slice(15);assert(token,401,'Выберите пользователя для входа.');const user=await sessionUser(token);assert(user,401,'Сессия завершена. Войдите снова.');req.actor=user;next();});
 app.post('/api/auth/activity',async(req,res)=>{
  await touchSession(readCookie(req,'ruspet_session')!,res);
  res.json({ok:true});
 });
 app.get('/api/bootstrap',compress,async(req,res)=>{
  const {serverTime,...workspace}=await service.bootstrap(req.actor,false,req.query.view==='workspace',req.get(viewAsHeader)===undefined);
  const snapshot={...workspace,managerPreview:managerPreview||undefined};
  if(req.query.view==='workspace'){
   const version=createHash('sha256').update(JSON.stringify(snapshot)).digest('base64url');
   res.set({'X-Ruspet-Workspace-Version':version,'X-Ruspet-Server-Time':serverTime});
   if(req.get('X-Ruspet-Workspace-Version')===version){res.status(204).end();return;}
  }
  res.json({...snapshot,serverTime});
 });
 app.get('/api/undo/last',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json(await lastUndo(req.actor,z.string().min(1).max(100).optional().parse(req.query.taskId)));
 });
 app.get('/api/workspace-search',compress,async(req,res)=>{
  const input=workspaceSearchInput.parse(req.query);
  res.json(await workspaceSearch(req.actor,input,req.get(viewAsHeader)!==undefined));
 });
 app.get('/api/journal',async(req,res)=>res.json(await listJournal(req.actor,z.object({from:z.iso.date().optional(),to:z.iso.date().optional(),actor:z.string().max(100).optional(),kind:z.string().max(100).optional(),q:z.string().max(200).optional(),team:z.enum(['team','sales']).optional(),page:z.coerce.number().int().min(0).max(10000).default(0)}).parse(req.query))));
 app.post('/api/undo',async(req,res)=>{const input=z.object({id:z.uuid(),confirmed:z.literal(true)}).parse(req.body);res.json(await undoLastAction(req.actor,input.id));});
 app.get('/api/tasks/:id/staff-undo',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json(await staffUndoHistory(req.actor,String(req.params.id)));
 });
 app.post('/api/undo/staff',async(req,res)=>{
  const {id,reason}=z.object({id:z.uuid(),confirmed:z.literal(true),reason:z.string().trim().min(5).max(1000)}).parse(req.body);
  res.json(await undoStaffAction(req.actor,id,reason));
 });
 app.get('/api/management/progress',async(req,res)=>res.json(await managementProgress(req.actor,z.object({from:z.iso.date().optional(),to:z.iso.date().optional(),owner:z.string().max(100).optional(),team:z.enum(['team','sales']).optional()}).parse(req.query))));
 const analyticsQuery=z.object({period:z.enum(['day','week']).default('day'),
  group:z.preprocess(v=>typeof v==='string'?[v]:v,z.array(z.string().min(1).max(200)).max(3).default([]))});
 app.get('/api/analytics/overview',compress,async(req,res)=>{
  const query=analyticsQuery.parse(req.query);
  res.json(await analyticsOverview(req.actor,query.group,query.period));
 });
 app.get('/api/analytics/drilldown',compress,async(req,res)=>{
  const query=analyticsQuery.extend({metric:z.enum(analyticsMetrics),person:z.string().max(150).optional(),
   stage:z.enum(waitingStages).optional()}).parse(req.query);
  assert(query.metric!=='waiting'||query.person&&query.stage,400,'Выберите сотрудника и действие.');
  res.json((await analyticsOverview(req.actor,query.group,query.period,new Date(),query)).selection);
 });
 app.get('/api/analytics/layout',async(req,res)=>{
  assert(await analyticsAccess(req.actor,pool),403,'Аналитика недоступна.');
  res.json((await pool.query('SELECT widths FROM analytics_layouts WHERE user_id=$1',[req.actor.id])).rows[0]?.widths??{});
 });
 app.put('/api/analytics/layout',async(req,res)=>{
  assert(await analyticsAccess(req.actor,pool),403,'Аналитика недоступна.');
  const {column,width}=z.object({column:z.enum(analyticsColumns).nullable(),width:z.number().int().min(64).max(600).nullable()}).parse(req.body);
  if(column&&width)await pool.query(`INSERT INTO analytics_layouts(user_id,widths) VALUES($1,jsonb_build_object($2::text,$3::integer))
   ON CONFLICT(user_id) DO UPDATE SET widths=analytics_layouts.widths||excluded.widths`,[req.actor.id,column,width]);
  else await pool.query('DELETE FROM analytics_layouts WHERE user_id=$1',[req.actor.id]);
  res.json({ok:true});
 });
 app.get('/api/workspace/labels',async(_req,res)=>{
  const {rows}=await pool.query<{key:string;label:string}>('SELECT key,label FROM workspace_labels');
  res.json(Object.fromEntries(rows.map(row=>[row.key,row.label])));
 });
 app.put('/api/workspace/labels',async(req,res)=>{
  assert(req.actor.root_access,403,'Названия меняет владелец.');
  const {key,label}=z.object({key:z.enum(workspaceLabelKeys),label:z.string().trim().min(1).max(100)}).parse(req.body);
  await pool.query('INSERT INTO workspace_labels(key,label) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET label=excluded.label',[key,label]);
  res.json({key,label});
 });
 app.post('/api/management/observation',async(req,res)=>{const input=z.object({confirmed:z.literal(true),expected:z.iso.datetime({offset:true}).nullable()}).parse(req.body);res.json(await resetObservation(req.actor,input.expected));});
 app.put('/api/management/preferences',async(req,res)=>res.json(await setNudgePreference(req.actor,z.object({enabled:z.boolean()}).parse(req.body).enabled)));
 app.post('/api/management/nudge',async(req,res)=>res.json(await nudgeTeam(req.actor,z.object({confirmed:z.literal(true)}).parse(req.body).confirmed)));
 app.param('id',async(req,_res,next,id:string)=>{
  if(req.path.startsWith('/api/tasks/'))req.params.id=await resolveTaskNumber(id);
  next();
 });
 app.get('/api/tasks/:id/bitrix-activity',async(req,res)=>{assert(req.actor.role==='admin',403,'История интеграции доступна администратору.');res.json((await pool.query('SELECT kind,external_id,occurred_at,author,body FROM bitrix_task_activity WHERE task_id=$1 AND kind=$2 ORDER BY occurred_at DESC,external_id DESC LIMIT 100',[req.params.id,req.query.kind==='history'?'history':'comment'])).rows);});
 app.get('/api/tasks/:id/discussion',compress,async(req,res)=>res.json(
  await service.taskBitrixDiscussion(req.actor,String(req.params.id),req.get(viewAsHeader)===undefined,z.string().regex(/^[1-9]\d{0,17}$/).optional().parse(req.query.focus))));
 app.get('/api/tasks/:id/results',compress,async(req,res)=>res.json(
  await service.taskBitrixResults(req.actor,String(req.params.id),req.get(viewAsHeader)===undefined)));
 app.get('/api/tasks/:id/integration',async(req,res)=>res.json(await taskIntegration(req.actor,String(req.params.id))));
 app.get('/api/task-sync',async(req,res)=>{assert(req.actor.role==='admin',403,'Состояние интеграции доступно администратору.');res.json(await taskSyncStatus());});
 app.get('/api/alerts',async(req,res)=>res.json(await userAlerts(req.actor,req.get(viewAsHeader)===undefined)));
 app.get('/api/notifications',async(req,res)=>res.json(await personalNotifications(req.actor,req.query.unread==='true')));
 app.post('/api/notifications/read',async(req,res)=>{
  const {ids}=z.object({ids:z.array(z.uuid()).min(1).max(150)}).parse(req.body);
  res.json(await readNotifications(req.actor,ids));
 });
 app.get('/api/notifications/preferences',async(req,res)=>res.json(await notificationPreference(req.actor)));
 const pushSession=(req:express.Request)=>{
  const token=req.headers.cookie?.split('; ').find(value=>value.startsWith('ruspet_session='))?.slice(15);
  assert(token,401,'Войдите в систему.');
  return hash(token);
 };
 app.get('/api/notifications/push',async(req,res)=>res.json(await webPushStatus(req.actor,pushSession(req))));
 app.post('/api/notifications/push',async(req,res)=>res.json(await saveWebPush(req.actor,pushSession(req),webPushSubscription.parse(req.body))));
 app.delete('/api/notifications/push',async(req,res)=>res.json(await removeWebPush(req.actor,webPushEndpoint.parse(req.body).endpoint)));
 app.post('/api/notifications/push/test',async(req,res)=>res.json(await testDevicePush(req.actor,pushSession(req),webPushEndpoint.parse(req.body).endpoint)));
 app.put('/api/notifications/preferences',async(req,res)=>{
  res.json(await saveNotificationPreference(req.actor,notificationPreferenceInput.parse(req.body)));
 });
 app.post('/api/alerts/:id/ack',async(req,res)=>res.json(await acknowledgeAlert(req.actor,String(req.params.id))));
 app.get('/api/org',async(req,res)=>res.json(await orgDirectory(req.actor)));
 app.put('/api/org/reporting/:id',async(req,res)=>{await setManager(req.actor,String(req.params.id),req.body);res.json({ok:true});});
 app.post('/api/org/substitutions',async(req,res)=>res.status(201).json(await saveSubstitution(req.actor,req.body)));
 app.delete('/api/org/substitutions/:id',async(req,res)=>{await revokeSubstitution(req.actor,z.uuid().parse(req.params.id));res.json({ok:true});});
 app.get('/api/delegations',async(req,res)=>res.json(await myDelegations(req.actor)));
 app.get('/api/tasks/:id/delegation',async(req,res)=>res.json(await delegationLinks(req.actor,String(req.params.id))));
 app.get('/api/tasks/:id/delegation-targets',async(req,res)=>res.json(await delegationTargets(req.actor,String(req.params.id),z.uuid().optional().parse(req.query.companyId))));
 app.get('/api/tasks/:id/delegation-clients',async(req,res)=>res.json(await delegationClients(req.actor,String(req.params.id),z.string().trim().min(2).max(150).parse(req.query.q))));
 app.post('/api/tasks/:id/delegate',async(req,res)=>res.status(201).json(await delegateTask(req.actor,String(req.params.id),z.object({
  assigneeId:z.string().trim().min(1).max(100).optional(),companyId:z.uuid().optional(),responsibilityToken:z.string().regex(/^[a-f0-9]{64}$/).optional(),expectedVersion:z.number().int().positive(),
  instruction:z.string().trim().max(2000).optional(),deadline:date.nullable().optional()
 }).parse(req.body))));
 app.get('/api/tasks/:id/assignees',async(req,res)=>res.json(await taskAssignees(req.actor,String(req.params.id))));
 app.get('/api/task-assignees',async(req,res)=>res.json(await newTaskAssignees(req.actor)));
 app.get('/api/tasks/:id/reminders',async(req,res)=>res.json(await listTaskReminders(req.actor,String(req.params.id))));
 app.post('/api/tasks/:id/reminders',async(req,res)=>res.status(201).json(await saveTaskReminder(req.actor,String(req.params.id),reminderInput.parse(req.body))));
 app.delete('/api/reminders/:id',async(req,res)=>res.json(await disableTaskReminder(req.actor,String(req.params.id))));
 app.get('/api/system/bitrix-archive',async(req,res)=>res.json(await archiveStatus(req.actor)));
 app.get('/api/system/selected-managers',async(req,res)=>res.json(await selectedPilotManagers(req.actor)));
 app.get('/api/system/status',async(req,res)=>res.json(await systemStatus(req.actor)));
 app.get('/api/system/staff',async(req,res)=>res.json(await staffSummary(req.actor)));
 app.post('/api/system/staff/import',express.raw({type:'application/octet-stream',limit:'3mb'}),async(req,res)=>{assert(Buffer.isBuffer(req.body),400,'Нужен файл XLSX.');const expected=req.query.confirmed===undefined?undefined:z.string().regex(/^[a-f0-9]{64}$/).parse(req.query.confirmed);res.json(await importStaff(req.actor,req.body,expected));});
 app.get('/api/system/registrations',async(req,res)=>res.json(await listRegistrations(req.actor)));
 app.post('/api/system/registrations/:id',async(req,res)=>{const input=z.object({action:z.enum(['approve','reject']),staffId:z.uuid().optional(),userId:z.string().max(100).optional(),forceNew:z.boolean().optional(),confirmed:z.literal(true)}).parse(req.body);res.json(await reviewRegistration(req.actor,z.uuid().parse(req.params.id),input));});
 app.get('/api/system/access',async(req,res)=>res.json(await accessDirectory(req.actor)));
 app.post('/api/system/access',async(req,res)=>res.status(201).json(await createEmployeeProfile(req.actor,req.body)));
 app.put('/api/system/staff-directory/:id/profile',async(req,res)=>{
  const {userId}=z.object({userId:z.string().min(1).max(100)}).parse(req.body);
  res.json(await linkStaffProfile(req.actor,z.uuid().parse(req.params.id),userId));
 });
 app.get('/api/system/staff-rollout',async(req,res)=>res.json(await staffRolloutStatus(req.actor)));
 app.put('/api/system/staff-rollout',async(req,res)=>{
  const {enabled}=z.object({enabled:z.boolean(),confirmed:z.literal(true)}).parse(req.body);
  res.json(await setStaffRollout(req.actor,enabled));
 });
 app.put('/api/system/access/:id/work-control',async(req,res)=>{
  const {enabled}=z.object({enabled:z.boolean().nullable()}).parse(req.body);
  res.json(await setStaffWorkOverride(req.actor,String(req.params.id),enabled));
 });
 app.patch('/api/system/access/:id',async(req,res)=>res.json(await updateEmployeeProfile(req.actor,String(req.params.id),req.body)));
 app.put('/api/system/access/:id/account/:username',async(req,res)=>{
  const {action}=z.object({action:z.enum(['enable','disable','reset']),confirmed:z.literal(true)}).parse(req.body);
  res.json(await changeUserAccount(req.actor,String(req.params.id),String(req.params.username),action));
 });
 app.put('/api/owner/bitrix/exchange',async(req,res)=>{
  const {enabled}=z.object({enabled:z.boolean(),confirmed:z.literal(true)}).parse(req.body);
  res.json(await setOwnerBitrixExchange(req.actor,enabled));
 });
 app.put('/api/system/access/:id/telegram',async(req,res)=>{const input=z.object({telegramId:z.string().trim().max(16).nullable(),confirmed:z.literal(true)}).parse(req.body);res.json(await setTelegramBinding(req.actor,String(req.params.id),input.telegramId));});
 app.get('/api/system/pilot',async(req,res)=>{assert(req.actor.role==='admin',403,'Подготовку пилота видит администратор.');res.json(await pilotReadiness());});
 app.get('/api/system/pilot/queue',async(req,res)=>{assert(req.actor.role==='admin',403,'Очередь пилота видит администратор.');res.json(await pilotQueue());});
 app.post('/api/system/access/:id/account',async(req,res)=>{const input=z.object({username:z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/)}).parse(req.body);res.status(201).json(await createUserAccount(req.actor,String(req.params.id),input.username));});
 app.get('/api/operations',async(req,res)=>{assert(req.actor.role!=='employee',403,'Расписание доступно руководителю.');res.json(await operationsStatus());});
 app.put('/api/operations',async(req,res)=>{const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);await saveAutomation(req.actor,z.object({enabled:z.boolean(),morning:time,evening:time}).parse(req.body));await tick();res.json({ok:true});});
 app.post('/api/operations/retry',async(req,res)=>{await retryJob(req.actor,z.object({key:text}).parse(req.body).key);await tick();res.json({ok:true});});
 app.get('/api/telegram/status',async(req,res)=>{res.json(await pilotStatus(req.actor));});
 app.post('/api/telegram/pairing',async(req,res)=>res.json(await pairPilot(req.actor,z.object({userId:z.string().max(100).optional()}).parse(req.body||{}).userId)));
 app.put('/api/telegram/settings',async(req,res)=>{await configurePilot(req.actor,z.object({enabled:z.boolean(),delivery:z.boolean(),taskDelivery:z.boolean().optional(),deadlineDelivery:z.boolean().optional(),workdayDelivery:z.boolean().optional()}).parse(req.body));res.json({ok:true})});
 app.post('/api/bot/screen',async(req,res)=>{
  const {screen,scope}=z.object({screen:z.enum(['home','tasks','notices','inbox','search_prompt']).default('home'),
   scope:z.enum(['mine','created']).optional()}).parse(req.body||{});
  const channel=webBotChannel(req);
  await clearBotDraft(req.actor,channel);
  res.json(await botView(req.actor,channel,{op:screen,...(screen==='tasks'&&scope?{filter:scope}:{})}));
 });
 app.post('/api/bot/click',async(req,res)=>res.json(await botClick(req.actor,webBotChannel(req),z.object({token:z.string().max(64)}).parse(req.body).token)));
 app.post('/api/bot/text',async(req,res)=>{const input=z.object({text:z.string().min(1).max(4000),inputId:z.uuid()}).parse(req.body);res.json(await botText(req.actor,webBotChannel(req),input.text,input.inputId));});
 app.post('/api/bot/text-draft',async(req,res)=>{
  const {text,inputId}=z.object({text:z.string().trim().min(1).max(4000),inputId:z.uuid()}).parse(req.body);
  res.json(await botVoiceDraft(req.actor,webBotChannel(req),text,inputId,new Date(),'text'));
 });
 app.get('/api/bot/voice',async(req,res)=>res.json({enabled:voiceEnabled('web',req.actor.id)}));
 app.post('/api/bot/voice',express.raw({type:['audio/*','video/mp4'],limit:voiceMaxBytes,inflate:false}),async(req,res)=>{
  assert(voiceEnabled('web',req.actor.id),409,'Голосовые команды пока недоступны. Можно написать ответ текстом.');
  const inputId=z.uuid().parse(req.get('X-Voice-Input-Id')),channel=webBotChannel(req);
  const cached=await savedVoiceDraft(req.actor,channel,inputId);if(cached){res.json(cached);return;}
  assert(Buffer.isBuffer(req.body)&&req.body.length>0,415,'Запишите голосовое или выберите аудиофайл.');
  const format=browserAudioFormat(req.get('Content-Type')||'',req.body);
  const key=JSON.stringify([req.actor.id,channel,inputId]);
  let pending=voiceInputs.get(key);
  if(!pending){
   const audio=new Blob([new Uint8Array(req.body)]);
   pending=transcribeAudio(audio,format,req.actor.id)
    .then(transcript=>botVoiceDraft(req.actor,channel,transcript,inputId))
    .finally(()=>voiceInputs.delete(key));
   voiceInputs.set(key,pending);
  }
  res.json(await pending);
 });
 app.post('/api/voice/transcript',express.raw({type:['audio/*','video/mp4'],limit:voiceMaxBytes,inflate:false}),async(req,res)=>{
  assert(voiceEnabled('web',req.actor.id),409,'Голосовой ввод недоступен. Можно ввести текст.');
  assert(Buffer.isBuffer(req.body)&&req.body.length>0,415,'Запишите голосовое или выберите аудиофайл.');
  const format=browserAudioFormat(req.get('Content-Type')||'',req.body);
  const transcript=await transcribeAudio(new Blob([new Uint8Array(req.body)]),format,req.actor.id);
  if(req.query.mode!=='task'){res.json({transcript});return;}
  const direct=parseVoiceIntent(transcript);
  const intent=direct?.kind==='create_task'?direct:parseVoiceIntent('Создай задачу. '+transcript);
  const values=intent?.values??{};
  const person=values.assignee?await resolveAssignee(req.actor,{op:'form',kind:'create_task'},values.assignee,pool):null;
  let deadline:string|undefined;
  if(values.deadline!=='без срока'){
   try{deadline=parseMoscowInput(values.dueDay&&!/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(values.deadline??'')?values.dueDay+' 18:00':values.deadline??'');}catch{}
  }
  res.json({transcript,values,deadline,assigneeId:person?.id});
 });
 app.get('/api/task-groups',async(req,res)=>res.json(await taskGroups(req.actor)));
 app.post('/api/task-groups',async(req,res)=>{
  const input=z.object({name:z.string().trim().min(1).max(80),company:z.boolean().optional()}).parse(req.body);
  res.status(201).json(await createTaskGroup(req.actor,input.name,input.company));
 });
 app.put('/api/tasks/:id/company-epic',async(req,res)=>res.json(await groupCompanyTask(req.actor,String(req.params.id),z.object({epicId:z.uuid().nullable()}).parse(req.body).epicId)));
 app.put('/api/tasks/:id/group',async(req,res)=>res.json(await groupTask(req.actor,String(req.params.id),z.object({groupId:z.uuid().nullable()}).parse(req.body).groupId)));
 app.get('/api/okb/companies/:id/notes',async(req,res)=>res.json(await clientNotes(req.actor,{companyId:z.uuid().parse(req.params.id),taskId:z.string().max(100).optional().parse(req.query.task)},z.uuid().optional().parse(req.query.before))));
 app.post('/api/okb/companies/:id/notes',async(req,res)=>res.status(201).json(await addClientNote(req.actor,{companyId:z.uuid().parse(req.params.id),taskId:z.string().max(100).optional().parse(req.query.task)},z.object({body:z.string().trim().min(1).max(20000)}).parse(req.body).body)));
 app.post('/api/integrations/v1/companies/batch',async(req,res)=>res.json(await syncCompanySnapshots(req.actor,req.body)));
 app.get('/api/okb/companies/:id/responsibility',async(req,res)=>res.json(await companyResponsibility(req.actor,z.uuid().parse(req.params.id))));
 app.get('/api/okb/registry',async(_req,res)=>res.json({enabled:dadataConfigured()}));
 app.post('/api/okb/registry/search',async(req,res)=>res.json(await suggestCompanies(req.actor,z.object({query:z.string().trim().min(3).max(250)}).parse(req.body).query)));
 app.get('/api/okb/companies',async(req,res)=>res.json(await listCompanies(req.actor,typeof req.query.q==='string'?req.query.q:'',req.query.scope==='mine'?'mine':req.query.scope==='unassigned'?'unassigned':'accessible')));
 app.get('/api/okb/companies/:id/people',async(req,res)=>res.json(await clientPeople(req.actor,z.uuid().parse(req.params.id))));
 app.post('/api/okb/companies/:id/people',async(req,res)=>res.status(201).json(await saveClientPerson(req.actor,z.uuid().parse(req.params.id),req.body)));
 app.put('/api/okb/companies/:id/people/:personId',async(req,res)=>res.json(await saveClientPerson(req.actor,z.uuid().parse(req.params.id),req.body,z.uuid().parse(req.params.personId))));
 app.delete('/api/okb/companies/:id/people/:personId',async(req,res)=>res.json(await archiveClientPerson(req.actor,z.uuid().parse(req.params.id),z.uuid().parse(req.params.personId))));
 app.get('/api/catalog',async(req,res)=>res.json(await listProducts(req.actor,typeof req.query.q==='string'?req.query.q:'',req.query.archived==='1')));
 app.post('/api/catalog',async(req,res)=>res.status(201).json(await saveProduct(req.actor,req.body)));
 app.put('/api/catalog/:id',async(req,res)=>res.json(await saveProduct(req.actor,req.body,z.uuid().parse(req.params.id))));
 app.get('/api/analytics/clients',async(req,res)=>res.json(await portfolioOverview(req.actor)));
 app.get('/api/okb/companies/:id',async(req,res)=>res.json(await getCompany(req.actor,z.uuid().parse(req.params.id))));
 app.get('/api/okb/companies/:id/work',async(req,res)=>res.json(await companyWork(req.actor,z.uuid().parse(req.params.id))));
 app.get('/api/okb/companies/:id/contacts',async(req,res)=>res.json(await companyContacts(req.actor,z.uuid().parse(req.params.id))));
 app.post('/api/okb/companies/:id/contacts',async(req,res)=>res.status(201).json(await recordCompanyContact(req.actor,z.uuid().parse(req.params.id),req.body)));
 app.get('/api/task-templates',async(req,res)=>res.json(await listTaskTemplates(req.actor)));
 app.post('/api/task-templates',async(req,res)=>res.status(201).json(await saveTaskTemplate(req.actor,req.body)));
 app.delete('/api/task-templates/:id',async(req,res)=>{await removeTaskTemplate(req.actor,z.uuid().parse(req.params.id));res.json({ok:true});});
 app.post('/api/okb/companies',async(req,res)=>res.status(201).json(await saveCompany(req.actor,req.body)));
 app.put('/api/okb/companies/:id',async(req,res)=>res.json(await saveCompany(req.actor,req.body,z.uuid().parse(req.params.id))));
 app.get('/api/work-design/schedules',async(req,res)=>res.json(await listSchedules(req.actor)));
 app.post('/api/work-design/schedules',async(req,res)=>res.status(201).json(await saveSchedule(req.actor,req.body)));
 app.patch('/api/work-design/schedules/:id',async(req,res)=>{await toggleSchedule(req.actor,z.uuid().parse(req.params.id),z.object({enabled:z.boolean()}).parse(req.body).enabled);res.json({ok:true});});
 app.get('/api/work-design/processes',async(req,res)=>res.json(await listProcesses(req.actor)));
 app.post('/api/work-design/processes',async(req,res)=>res.status(201).json(await saveProcess(req.actor,req.body)));
 app.post('/api/work-design/processes/preview',async(req,res)=>res.json(await previewProcess(req.actor,req.body)));
 app.put('/api/work-design/processes/:id',async(req,res)=>res.json(await saveProcess(req.actor,req.body,z.uuid().parse(req.params.id))));
 app.patch('/api/work-design/processes/:id',async(req,res)=>{
  const change=z.object({enabled:z.boolean(),expectedRevision:z.number().int().positive().optional()}).parse(req.body);
  await toggleProcess(req.actor,z.uuid().parse(req.params.id),change.enabled,change.expectedRevision);res.json({ok:true});
 });
 app.post('/api/tasks',async(req,res)=>taskWrite(req,res,201,()=>createTask(req.actor,taskInput.parse(req.body))));
 app.post('/api/tasks/:id/copy',async(req,res)=>{
  const {requestId,...input}=taskInput.extend({requestId:z.uuid()}).parse(req.body);
  res.status(201).json(await createTaskCopy(req.actor,String(req.params.id),requestId,input));
 });
 app.put('/api/tasks/:id/approval-watch',async(req,res)=>{
  const {enabled}=z.object({enabled:z.boolean()}).parse(req.body);
  res.json(await setApprovalWatch(req.actor,String(req.params.id),enabled));
 });
 app.get('/api/approval-hierarchy',async(req,res)=>{
  assert(req.actor.role==='admin',403,'Маршрут настраивает администратор.');
  res.json(await approvalHierarchy(pool));
 });

 app.get('/api/director-approval-batches',async(req,res)=>res.json(await directorBatchStatus(req.actor)));
 app.post('/api/director-approval-batches',async(req,res)=>res.json(await sendDirectorBatch(req.actor)));
 app.get('/api/director-weekly-tasks',async(req,res)=>res.json(await weeklyDirectorTasks(req.actor,z.iso.date().parse(req.query.week))));
 app.get('/api/director-approval-batches/:id',async(req,res)=>res.json(await directorBatchTasks(req.actor,z.uuid().parse(req.params.id))));
 app.put('/api/approval-hierarchy',async(req,res)=>{
  const input=z.object({branchId:z.string().min(1).max(100),salesId:z.string().min(1).max(100),approveAll:z.boolean().optional(),
   directAssigneeIds:z.array(z.string().min(1).max(100)).min(1).max(500).nullable().optional(),
   creatorApproverId:z.string().min(1).max(100).nullable().optional(),extraDeadlineAssigneeIds:z.array(z.string().min(1).max(100)).max(500).optional(),
   onlySelfDirect:z.boolean().optional()}).parse(req.body);
  res.json(await setApprovalHierarchy(req.actor,input.branchId,input.salesId,input.approveAll,input.directAssigneeIds,input));
 });
 app.post('/api/tasks/:id/edit-permissions',async(req,res)=>{
  const {expectedVersion,reason}=z.object({expectedVersion:z.number().int().positive(),reason:z.string().trim().min(5).max(4000)}).parse(req.body);
  res.status(201).json(await requestTaskEdit(req.actor,String(req.params.id),expectedVersion,reason));
 });
 app.post('/api/tasks/:id/edit-permissions/:requestId/decision',async(req,res)=>{
  const {decision,comment}=z.object({decision:z.enum(['approve','reject']),comment:z.string().trim().max(4000).default('')}).parse(req.body);
  res.json(await decideTaskEdit(req.actor,String(req.params.id),z.uuid().parse(req.params.requestId),decision,comment));
 });
 app.put('/api/tasks/:id',async(req,res)=>{
  const input=taskInput.extend({reason:z.string().trim().min(5).max(4000),expectedVersion:z.number().int().positive()}).parse(req.body);
  await taskWrite(req,res,200,()=>editTask(req.actor,String(req.params.id),input,input.expectedVersion,input.reason));
 });
 app.patch('/api/tasks/:id/price',async(req,res)=>{
  const {price,expectedVersion}=z.object({price:taskPriceInput,expectedVersion:z.number().int().positive()}).parse(req.body);
  await taskWrite(req,res,200,()=>editTaskPrice(req.actor,String(req.params.id),price,expectedVersion));
 });
 app.put('/api/tasks/:id/branch',async(req,res)=>{
  const {branchId,expectedVersion}=z.object({branchId:z.string().trim().min(1).max(100),expectedVersion:z.number().int().positive()}).parse(req.body);
  await taskWrite(req,res,200,()=>classifyTaskBranch(req.actor,String(req.params.id),branchId,expectedVersion));
 });
 app.post('/api/tasks/:id/review',async(req,res)=>{
  const input=z.object({action:z.enum(['submit','accept','return','complete']),comment:z.string().trim().max(4000),expectedVersion:z.number().int().positive()}).parse(req.body);
  await taskWrite(req,res,200,()=>reviewTask(req.actor,String(req.params.id),input.action,input.comment,input.expectedVersion));
 });
 app.get('/api/tasks/:id',compress,async(req,res)=>res.json(await service.detail(req.actor,String(req.params.id),pool,true,req.get(viewAsHeader)===undefined)));
 app.get('/api/personal-calendar',compress,async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.json(await personalCalendar(req.actor,calendarMonthInput.parse(req.query.month)));
 });
 app.get('/api/personal-calendar/work.csv',async(req,res)=>{
  const month=calendarMonthInput.parse(req.query.month),calendar=await personalCalendar(req.actor,month);
  assert(calendar.canLogWork,403,'Учёт часов недоступен для вашей должности.');
  const clock=(m:number)=>Math.floor(m/60)+':'+String(m%60).padStart(2,'0');
  const text=(s:string)=>'"'+(/^[\s]*[=+@-]/.test(s)?"'":"")+s.replaceAll('"','""')+'"';
  const rows=[['Дата','Отработано (ч:мин)','Что сделано'],
   ...calendar.work.map(w=>[w.date,w.minutes===null?'':clock(w.minutes),w.note]),
   ['Итого',clock(calendar.work.reduce((sum,w)=>sum+(w.minutes??0),0)),'']];
  res.attachment('ruspet-hours-'+month+'.csv').type('text/csv').send('\uFEFF'+rows.map(row=>row.map(text).join(';')).join('\r\n'));
 });
 app.put('/api/personal-calendar/work/:date',async(req,res)=>{
  res.json(await saveStaffWork(req.actor,z.iso.date().parse(req.params.date),staffWorkInput.parse(req.body)));
 });
 app.put('/api/tasks/:id/personal-plan',async(req,res)=>{
  res.json(await saveTaskPlan(req.actor,String(req.params.id),taskPlanInput.parse(req.body)));
 });
 app.post('/api/tasks/:id/comments',async(req,res)=>{
  const input=z.object({body:text,approvalId:z.uuid().optional()}).parse(req.body);
  await taskWrite(req,res,200,async()=>{await service.addComment(req.actor,String(req.params.id),input.body,input.approvalId);return {ok:true};});
 });
 app.post('/api/tasks/:id/approvals',async(req,res)=>taskWrite(req,res,201,()=>service.requestApproval(req.actor,String(req.params.id),z.object({type:z.enum(['deadline','completion']),reason:text,plan:z.string().trim().max(4000).optional(),proposedDeadline:date.optional(),expectedVersion:z.number().int().positive()}).parse(req.body))));
 app.post('/api/approvals/history-refresh',async(req,res)=>res.json(await service.queueApprovalHistories(req.actor)));
 app.post('/api/approvals/:id/decision',async(req,res)=>taskWrite(req,res,200,()=>service.decide(req.actor,z.uuid().parse(req.params.id),z.object({decision:z.enum(['approve','reject','later','clarify']),comment:z.string().trim().max(4000).default(''),expectedStep:z.number().int().min(0).optional(),expectedRevision:z.number().int().positive().optional(),approvedDeadline:date.optional(),remindMinutes:z.number().int().min(5).max(1440).optional()}).parse(req.body))));
 app.post('/api/approvals/:id/clarification',async(req,res)=>{
  const {answer,expectedRevision}=z.object({answer:z.string().trim().min(5).max(4000),expectedRevision:z.number().int().positive().optional()}).parse(req.body);
  await taskWrite(req,res,200,()=>service.answerClarification(req.actor,z.uuid().parse(req.params.id),answer,expectedRevision));
 });
 app.post('/api/controls/:id/answer',async(req,res)=>{await service.answerControl(req.actor,z.uuid().parse(req.params.id),z.object({reason:text,progress:text,plan:text}).parse(req.body));res.json({ok:true});});
 app.post('/api/checks/run',async(req,res)=>res.json(await service.runChecks(req.actor)));
 app.post('/api/reminders/run',async(req,res)=>res.json(await service.remind(req.actor)));
 app.post('/api/reports',async(req,res)=>{const input=z.object({kind:z.enum(['snapshot','period','today','overdue','review','daily','nextday']).default('snapshot'),parameters:reportParameters.optional(),requestId:z.uuid().optional()}).parse(req.body||{});res.json(await service.makeReport(req.actor,input.kind,'manual:'+ (input.requestId||randomUUID()),new Date(),input.parameters));});
 app.get('/api/reports',async(req,res)=>{const input=z.object({view:reportView.optional(),kind:z.string().max(40).optional(),from:z.iso.date().optional(),to:z.iso.date().optional(),page:z.coerce.number().int().min(0).max(100000).default(0)}).parse(req.query);assert(!input.from||!input.to||input.from<=input.to,400,'Дата начала позже даты окончания.');res.json(await service.listReports(req.actor,input));});
 app.get('/api/reports/:id',async(req,res)=>res.json(await service.getReport(req.actor,z.uuid().parse(req.params.id))));
 app.put('/api/rules',async(req,res)=>{const data=z.object({rules,expectedVersion:z.number().int().positive()}).parse(req.body);res.json(await service.saveRules(req.actor,data.rules,data.expectedVersion));});
 app.post('/api/tasks/:id/mock-change',async(req,res)=>{assert(process.env.DEMO_AUTH!=='false',404,'Действие недоступно.');await service.simulateExternalChange(req.actor,String(req.params.id),z.object({expectedVersion:z.number().int().positive()}).parse(req.body).expectedVersion);res.json({ok:true});});
 app.get('/api/reports/:id/pdf',async(req,res)=>{const report=await service.getReport(req.actor,z.uuid().parse(req.params.id));const bytes=await reportPdf(report);res.setHeader('Content-Disposition',`inline; filename=ruspet-${report.day}.pdf`);res.type('application/pdf').send(bytes);});
 app.get('/api/reports/:id/print',async(req,res)=>{const report=await service.getReport(req.actor,z.uuid().parse(req.params.id));res.type('html').send(printReport(report));});
 app.get('/api/reports/:id/csv',async(req,res)=>{const report=await service.getReport(req.actor,z.uuid().parse(req.params.id));const data={users:(await pool.query('SELECT id,name FROM users')).rows};const cell=(v:unknown)=>{let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};const rows=[['ID','Задача','Ответственный','Цена','Категория цены','Срок','Статус','Переносов'],...report.rows.map((t:any)=>[t.id,t.title,report.analysis?.team.find((u:{id:string;name:string})=>u.id===t.assignee_id)?.name||data.users.find(u=>u.id===t.assignee_id)?.name||t.assignee_id,formatPrice(t),priceLabels[priceBand(t)],t.deadline?new Date(t.deadline).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}):'Без срока',({active:'В работе',review:'Ждёт приёмки',completed:'Завершена'} as Record<string,string>)[t.status],t.transfer_count])];res.setHeader('Content-Disposition',`attachment; filename="ruspet-${report.day}.csv"`);res.type('text/csv').send('\uFEFF'+rows.map(row=>row.map(cell).join(';')).join('\r\n'));});
 app.use('/api/time',ownerTimeRouter());
 app.get('/api/owner/work-log.xlsx',(req,res)=>{
  assert(req.actor.root_access,403,'Хронология работ доступна владельцу.');
  res.setHeader('Cache-Control','private, no-store');
  res.download(resolve('.secrets/ruspet-work-log.xlsx'),'РУСПЭТ — хронология работ.xlsx',{dotfiles:'allow'});
 });
 app.get('/api/owner/training/:id',(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  assert(req.actor.root_access,403,'Материалы доступны владельцу.');
  const material=trainingMaterials.find(item=>item.id===req.params.id);
  assert(material,404,'Такого материала нет.');
  res.download(fileURLToPath(new URL('./training/'+material.file,import.meta.url)),material.download);
 });
 app.use('/api',(_req,res)=>res.status(404).json({error:'Маршрут API не найден.'}));
 app.get('/time',async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  const token=req.headers.cookie?.split('; ').find(value=>value.startsWith('ruspet_session='))?.slice(15);
  const user=token?await sessionUser(token):null;
  if(!user?.root_access)return res.status(user?403:401).sendFile(resolve('server/time/locked.html'));
  await touchSession(token!,res);
  res.sendFile(resolve('server/time/plan.html'));
 });
 app.use('/assets',compress,express.static(resolve('dist/assets'),{maxAge:'1y',immutable:true}));
 app.use(express.static(resolve('dist')));app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html')));
 app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(error instanceof ZodError)return res.status(400).json({error:'Проверьте заполнение полей.',fields:error.issues.map(i=>({path:i.path,message:i.message}))});
  if(error instanceof AppError)return res.status(error.status).json({error:error.message});
  const code=(error as {code?:string}).code;if(code==='23505'||code==='40001'||code==='40P01')return res.status(409).json({error:'Данные уже изменены другим действием. Обновите страницу.'});
  if((error as {status?:number}).status===400)return res.status(400).json({error:'Некорректный запрос.'});
  if((error as {status?:number}).status===413)return res.status(413).json({error:'Файл превышает допустимый размер.'});
  console.error('Request failed',error instanceof Error?error.message:'unknown');res.status(500).json({error:'Не удалось выполнить действие. Попробуйте ещё раз.'});
 });return app;
}
