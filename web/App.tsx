import {StaffOnboarding} from './StaffOnboarding.js';
import {BitrixArchiveStatus} from './BitrixArchiveStatus.js';
import {PilotReadiness} from './PilotReadiness.js';
import {TaskBranchReview,TaskCardFields,TaskEditPanel} from './TaskCardSections.js';
import {roleLabels as roles} from './employee-roles.js';
import {DelegationInbox,OrgWorkspace} from './OrgWorkspace.js';
import {TaskDelegation} from './TaskDelegation.js';
import {CompanyReference} from './TaskComposeTools.js';
import type {ProcessDraft} from './WorkDesign.js';
import {BitrixActivity} from './BitrixActivity.js';
import {TaskDiscussion,TaskResults} from './TaskDiscussion.js';
import {EmployeeFilter,SearchFilter} from './SearchFilter.js';
import {AccessDirectory,SystemHealth,moscowTimestamp} from './SystemHealth.js';
import {useRememberedFilter} from './remembered-filter.js';
import {Journal} from './Journal.js';
import {ApprovalWorkspace,DirectorBatch} from './ApprovalWorkspace.js';
import {ApprovalHierarchySettings} from './ApprovalHierarchySettings.js';
import {UndoAction} from './UndoAction.js';
import {StaffUndo} from './StaffUndo.js';
import {ManagementPreference,Performance} from './Management.js';
import {formatPrice,priceBand,priceLabels,taskPrice} from '../shared/pricing.js';
import {branchCovers,unassignedBranch} from '../shared/branches.js';
import {ReminderInbox} from './ReminderInbox.js';
import {ManagerHome} from './ManagerHome.js';
import {TaskRoleSwitch} from './TaskRoleSwitch.js';
import {MobileWorkspace} from './MobileWorkspace.js';
import {PersonalCalendar,PersonalTaskPlan} from './PersonalCalendar.js';
import {NotificationCenter,NotificationSettings} from './NotificationCenter.js';
import {syncDeviceNotifications} from './DeviceNotifications.js';
import {SettingsSections} from './SettingsSections.js';
import {canOpenWorkspacePage,type WorkspacePage as Page} from '../shared/workspace-access.js';
import {TaskReminders} from './TaskReminders.js';
import {QualityWorkspace} from './QualityWorkspace.js';
import {WrittenRules} from './WrittenRules.js';
import {Login} from './Login.js';
import {ThemeToggle} from './ThemeToggle.js';
import {CapMark} from './CapMark.js';
import {ActionWorkspace} from './ActionWorkspace.js';
import {BotConversation} from './BotConversation.js';
import {TelegramSettings} from './TelegramSettings.js';
import {workCount,workLabels,workQueue,workQueueTitle,type WorkBucket} from '../shared/work-queue.js';
import { Component, lazy, Suspense, useEffect, useLayoutEffect, useState, useRef, useSyncExternalStore, type ReactNode, type FormEvent } from 'react';
import { LayoutDashboard, ListTodo, GitPullRequest, ShieldCheck, ChartNoAxesCombined, BarChart3, Users, History, Settings2, Search, ArrowUpRight, ArrowRight, ChevronRight, Check, Clock3, X, Bell, Download, RefreshCw, Filter, MessageSquare, ChevronDown, PanelLeftClose, CheckCheck, AlertCircle, Send, CalendarDays, Link, Copy, Pencil, Bookmark } from 'lucide-react';
import { businessDay, taskQueue, elapsedToday, plannedToday } from '../shared/queues.js';
import {compareWorkPlan,hasCompanyOverview,type ReportView} from '../shared/report-parameters.js';
import {summarize} from '../shared/analytics.js';
import {TeamTasks} from './TeamTasks.js';
import { Dashboard } from './Dashboard.js';
import {Appearance} from './Appearance.js';
import {canEditTaskPrice} from '../shared/task-edit.js';
import {approvalChangeLines} from '../shared/approval-changes.js';
import { CompleteTaskDialog,ReviewActions,TaskEditor,TaskPriceEditor } from './TaskWorkflow.js';
import {TaskPeople} from './TaskPeople.js';
import {activeTaskApproval,approvalTurn,canComplete,canSetApprovedDeadline,taskNextAction} from '../shared/actions.js';
import { History as TaskHistory } from './History.js';
import { Operations } from './Operations.js';
import {api,ApiError,loadWorkspace,viewAs} from './api.js';
import type { Bootstrap, Task, User, TaskDetail, Rules, Approval, DeadlineTransfer, Event } from '../shared/types.js';
const TeamAnalytics=lazy(()=>import('./TeamAnalytics.js').then(module=>({default:module.TeamAnalytics})));
const Reports=lazy(()=>import('./Reports.js').then(module=>({default:module.Reports})));
const Okb=lazy(()=>import('./WorkDesign.js').then(module=>({default:module.Okb})));
const WorkDesign=lazy(()=>import('./WorkDesign.js').then(module=>({default:module.WorkDesign})));
const canUseOkb=(user:User)=>canOpenWorkspacePage(user,'okb');
const retryableTaskWrite=(method:string,path:string)=>method==='PATCH'&&/^\/tasks\/[^/]+\/price$/.test(path)||method==='POST'&&(path==='/tasks'||/^\/tasks\/[^/]+\/(comments|review|approvals)$/.test(path)||/^\/approvals\/[^/]+\/(decision|clarification)$/.test(path))
 ||method==='PUT'&&/^\/tasks\/[^/]+$/.test(path);
class WorkspaceSection extends Component<{label:string;children:ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){
  return this.state.failed?<div className="alert error" role="alert"><span>Раздел не загрузился. Проверьте связь и обновите страницу.</span>
   <button className="button secondary" onClick={()=>location.reload()}>Обновить страницу</button></div>:
   <Suspense fallback={<p className="panel section-loading" role="status">{this.props.label}</p>}>{this.props.children}</Suspense>;
 }
}
const nav=[{id:'overview',label:'Главная',icon:LayoutDashboard},{id:'actions',label:workQueueTitle,icon:Bell},{id:'tasks',label:'Задачи',icon:ListTodo},{id:'calendar',label:'Мой календарь',icon:CalendarDays},{id:'approvals',label:'Согласования',icon:GitPullRequest},{id:'bot',label:'Рабочий бот',icon:MessageSquare},{id:'analytics',label:'Аналитика',icon:ChartNoAxesCombined},{id:'checks',label:'Проверки задач',icon:ShieldCheck},{id:'reports',label:'Отчёты',icon:BarChart3},{id:'people',label:'Работа сотрудников',icon:Users},{id:'journal',label:'История действий',icon:History},{id:'delegations',label:'Мои поручения',icon:ListTodo},{id:'org',label:'Оргструктура',icon:Users},{id:'processes',label:'Бизнес-процессы',icon:GitPullRequest},{id:'okb',label:'ОКБ',icon:Users},{id:'settings',label:'Настройки',icon:Settings2}] as const;
const viewingEmployee=viewAs!==null;
const phone=window.matchMedia('(max-width: 760px)');
function watchPhone(change:()=>void){phone.addEventListener('change',change);return()=>phone.removeEventListener('change',change);}
const previewSections=new Set<Page>(['overview','actions','tasks','approvals','checks','reports','people','journal','delegations','notifications']);
const date=(v:string|null,full=false)=>v?new Date(v).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',...(full?{hour:'2-digit',minute:'2-digit'}:{})}):'Без срока';
const day=(v:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
const initials=(name:string)=>name.split(' ').slice(0,2).map(s=>s[0]).join('');
const stateLabels:Record<string,string>={canceled:'Отменено',pending:'На согласовании',approved:'Согласовано',rejected:'Отказано',stale:'Требует нового запроса',active:'В работе',review:'На приёмке',completed:'Завершена',waiting:'Ждём ответа',answered:'Ответ получен',escalated:'Эскалация',resolved:'Устранено'};
const managed=(u:User)=>u.role!=='employee';
const allowedRequest=(u:User,t:Task)=>u.id===t.assignee_id||u.id===t.creator_id||managed(u)&&(u.role!=='branch_manager'||(u.company_branch_access||branchCovers(u.branch_id,t.branch_id)));
function Empty({children}: {children:ReactNode}){return <div className="empty"><CheckCheck size={28}/><h3>Здесь пока нет записей</h3><p>{children}</p></div>;}
function Badge({state,children}: {state:string;children?:ReactNode}) {return <span className={`badge ${state}`}><i/>{children||stateLabels[state]||state}</span>;}
function Avatar({user,small=false}: {user?:User;small?:boolean}){return <span className={`avatar ${small?'small':''} color-${(user?.id.length||0)%4}`}>{initials(user?.name||'—')}</span>;}
function Tabs({items,value,onChange}: {items:{id:string;label:string;count?:number}[];value:string;onChange:(id:string)=>void}) {return <div className="tabs" role="tablist">{items.map(item=><button role="tab" aria-selected={value===item.id} key={item.id} className={value===item.id?'selected':''} onClick={()=>onChange(item.id)}>{item.label}{item.count!==undefined&&<span>{item.count}</span>}</button>)}</div>;}
function Timeline({events,users}: {events:Event[];users:User[]}){return <div className="timeline">{events.map(e=><div className="timeline-row" key={e.id}><span className={`event-dot ${e.kind.includes('reject')?'red':''}`}/><div><strong>{e.message}</strong><p>{users.find(u=>u.id===e.actor_id)?.name||'Система'} · {date(e.created_at,true)}</p>{typeof e.data.comment==='string'&&e.data.comment&&<blockquote>{e.data.comment}</blockquote>}{e.kind==='deadline_changed'&&<p className="change-line">{date((e.data.before as Task)?.deadline,true)} <ArrowRight size={13}/> {date((e.data.after as Task)?.deadline,true)}</p>}</div></div>)}</div>;}
export function App(){
 const compact=useSyncExternalStore(watchPhone,()=>phone.matches);
 const [users,setUsers]=useState<User[]>([]),[data,setData]=useState<Bootstrap|null>(null),[requestedPage,setPage]=useState<Page>('overview'),[error,setError]=useState(''),[toast,setToast]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [filter,setFilter]=useRememberedFilter(data?.user.id,'App.filter','all'),[search,setSearch]=useState(''),[branch,setBranch]=useRememberedFilter(data?.user.id,'App.branch','all'),[owner,setOwner]=useRememberedFilter(data?.user.id,'App.owner','all'),[workDay,setWorkDay]=useState<string|null>(null),[priceFilter,setPriceFilter]=useRememberedFilter(data?.user.id,'App.priceFilter','all'),[linkedIds,setLinkedIds]=useState<string[]|null>(null),[reportOpen,setReportOpen]=useState<string|null>(null),[reportPdf,setReportPdf]=useState(false),[sort,setSort]=useRememberedFilter(data?.user.id,'App.sort','deadline'),[fromDate,setFromDate]=useRememberedFilter(data?.user.id,'App.fromDate',''),[toDate,setToDate]=useRememberedFilter(data?.user.id,'App.toDate',''),[tablePage,setTablePage]=useState(0);
 const [settingsTarget,setSettingsTarget]=useState<string>();
 const [noticeTab,setNoticeTab]=useState('feed');
 const [showTaskMetrics,setShowTaskMetrics]=useState(false);
 const [workEntry,setWorkEntry]=useState<{bucket:'all'|WorkBucket;visit:number}>({bucket:'all',visit:0});
 const [taskView,setTaskView]=useState<ReportView|null>(null),[reportView,setReportView]=useState<ReportView|null>(null);
 const page=data&&!canOpenWorkspacePage(data.user,requestedPage,data.analyticsAccess)&&!(requestedPage==='reports'&&reportOpen)?'overview':requestedPage;
 const [selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<TaskDetail|null>(null),[drawerTab,setDrawerTab]=useState('info'),[requestType,setRequestType]=useState<'deadline'|'completion'|null>(null),[mobileMenu,setMobileMenu]=useState(false);
 const [detailError,setDetailError]=useState('');
 const [demo,setDemo]=useState(true),[processDraft,setProcessDraft]=useState<ProcessDraft|null>(null);
 const [editor,setEditor]=useState<{task:Task|null;copyOf?:Task;companyId?:string}|null>(null);
 const [completingTask,setCompletingTask]=useState<Task|null>(null);
 const [okbCompany,setOkbCompany]=useState<string|null>(null);
 const refreshGeneration=useRef(0),detailGeneration=useRef(0),toastTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const taskOpener=useRef<HTMLElement|null>(null),drawerClose=useRef<HTMLButtonElement>(null);
 const snapshot=useRef<Awaited<ReturnType<typeof loadWorkspace>>|undefined>(undefined);
 const pendingWrites=useRef(new Map<string,string>());
 const writeRunning=useRef(false);
 const [connectionIssue,setConnectionIssue]=useState<'unavailable'|'expired'|null>(null);
 const lastNoticeCheck=useRef<{userId:string;at:string}|null>(null);
 const showToast=(message:string)=>{setToast(message);if(toastTimer.current)clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),5000);};
 async function refresh(){
  const generation=++refreshGeneration.current;
  try{
   const next=await loadWorkspace(snapshot.current);
   if(generation===refreshGeneration.current){
    if(snapshot.current&&snapshot.current.data.user.id!==next.data.user.id){closeTask();setEditor(null);pendingWrites.current.clear();}
    snapshot.current=next;
    setData(next.data);
    setConnectionIssue(null);
   }
   return next.data;
  }catch(error){
   if(generation===refreshGeneration.current)setConnectionIssue(error instanceof ApiError&&error.status===401?'expired':'unavailable');
   throw error;
  }
 }
 async function refreshDetail(id:string){
  const generation=detailGeneration.current;
  const next=await api<TaskDetail>('/tasks/'+encodeURIComponent(id),'GET',undefined,{timeout:10000});
  if(generation===detailGeneration.current){setDetail(next);setDetailError('');}
 }
 async function openTask(id:string,tab='info'){
  if(!selected&&document.activeElement instanceof HTMLElement)taskOpener.current=document.activeElement;
  const generation=++detailGeneration.current;
  setSelected(id);setDrawerTab(tab);setDetail(null);setDetailError('');setError('');
  window.history.replaceState(null,'',`#task=${encodeURIComponent(id)}`);
  try{await refreshDetail(id);}catch(e){if(generation===detailGeneration.current)setDetailError((e as Error).message);}
 }
 function closeTask(){detailGeneration.current++;setSelected(null);setDetail(null);setRequestType(null);window.history.replaceState(null,'',window.location.pathname+window.location.search);}
 useLayoutEffect(()=>{
  if(selected)drawerClose.current?.focus({preventScroll:true});
  else{
   if(taskOpener.current?.isConnected)taskOpener.current.focus({preventScroll:true});
   taskOpener.current=null;
  }
 },[selected]);
 async function login(id:string){refreshGeneration.current++;setBusy(true);setError('');try{await api('/demo/login','POST',{userId:id});closeTask();setEditor(null);setTablePage(0);setSearch('');setLinkedIds(null);setWorkDay(null);setProcessDraft(null);setOkbCompany(null);pendingWrites.current.clear();snapshot.current=undefined;await refresh();showToast('Пользователь переключён. Права доступа применены.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function logout(){
  setBusy(true);
  try{
   await api('/auth/logout','POST',{},{timeout:10000});
   refreshGeneration.current++;snapshot.current=undefined;pendingWrites.current.clear();
   setSearch('');setLinkedIds(null);setWorkDay(null);closeTask();setEditor(null);setProcessDraft(null);setOkbCompany(null);
   setPage('overview');setError('');setConnectionIssue(null);setData(null);
  }catch(error){setError((error as Error).message);}
  finally{setBusy(false);}
 }
 async function act(path:string,body?:unknown,method='POST',message='Изменения сохранены',onSaved?:(id:string)=>void){
  if(viewingEmployee||writeRunning.current)return false;
  const request=retryableTaskWrite(method,path)?JSON.stringify([data?.user.id,method,path,body]):null;
  const key=request?(pendingWrites.current.get(request)??crypto.randomUUID()):undefined;
  if(request&&key)pendingWrites.current.set(request,key);
  const generation=detailGeneration.current;
  writeRunning.current=true;setBusy(true);setError('');
  try{
   const result=await api<{id?:string;state?:string;count?:number}>(path,method,body,key?{key,timeout:15000}:undefined);
   if(request)pendingWrites.current.delete(request);
   await refresh().catch(()=>{});
   if(result?.id&&onSaved)onSaved(result.id);
   else if(selected&&generation===detailGeneration.current)await refreshDetail(selected).catch(e=>setError(e.message));
   showToast(result?.state==='stale'?'Задача изменилась. Создайте новый запрос.':typeof result?.count==='number'?`Обработано уведомлений: ${result.count}`:message);
   return true;
  }catch(e){
   const unconfirmed=e instanceof ApiError&&(e.unconfirmed||e.status===401);
   if(unconfirmed)setConnectionIssue(e instanceof ApiError&&e.status===401?'expired':'unavailable');
   if(request&&!unconfirmed)pendingWrites.current.delete(request);
   if(e instanceof ApiError&&e.status===409){
    if(completingTask){
     const latest=await api<TaskDetail>('/tasks/'+encodeURIComponent(completingTask.id)).catch(()=>null);
     if(latest)setCompletingTask(latest.task);
    }
    if(selected&&generation===detailGeneration.current)await refreshDetail(selected).catch(()=>{});
    else await refresh().catch(()=>{});
   }
   setError(unconfirmed&&request?'Сохранение не подтверждено. Когда связь восстановится, повторите отправку в этой вкладке с теми же данными.':
    e instanceof ApiError&&e.unconfirmed?'Результат действия неизвестен. Проверьте задачу или историю перед повтором.':(e as Error).message);
   return false;
  }finally{writeRunning.current=false;setBusy(false);}
 }
 useEffect(()=>{
  let live=true;
  async function start(){
   try{
    const mode=viewingEmployee?{demo:false}:await api<{demo:boolean}>('/auth/mode','GET',undefined,{timeout:10000});
    if(!live)return;
    setDemo(mode.demo);
    if(mode.demo){const list=await api<User[]>('/demo/users','GET',undefined,{timeout:10000});if(!live)return;setUsers(list);}
    let next;
    try{next=await loadWorkspace();}
    catch(error){
     if(!live)return;
     if(!(error instanceof ApiError)||error.status!==401||viewingEmployee)throw error;
     if(!mode.demo)return;
     await api('/demo/login','POST',{userId:'director'},{timeout:10000});
     next=await loadWorkspace();
    }
    if(!live)return;
    snapshot.current=next;setData(next.data);
    const task=new URLSearchParams(location.hash.slice(1)).get('task');
    if(task)void openTask(task);
   }catch(error){if(live)setError((error as Error).message);}
   finally{if(live)setLoading(false);}
  }
  void start();
  return()=>{live=false;};
 },[]);
 useEffect(()=>{
  if(!data?.user.id)return;
  let last=0;
  const activity=()=>{
   if(document.visibilityState!=='visible'||!navigator.onLine||Date.now()-last<60000)return;
   last=Date.now();
   void fetch('/api/auth/activity',{method:'POST',credentials:'same-origin'}).then(res=>{if(!res.ok)last=0;}).catch(()=>{last=0;});
  };
  activity();
  const events=['pointerdown','keydown','wheel'] as const;
  for(const name of events)window.addEventListener(name,activity,{passive:true});
  return()=>{for(const name of events)window.removeEventListener(name,activity);};
 },[data?.user.id]);
 useEffect(()=>{setTablePage(0);},[filter,search,owner,branch,sort,priceFilter,fromDate,toDate]);
 useEffect(()=>{if(editor)setError('');},[editor]);
 useEffect(()=>{
  if(!data||!('serviceWorker' in navigator))return;
  if(!viewingEmployee)void syncDeviceNotifications(data.user.id).catch(()=>{});
  const received=(event:MessageEvent)=>{if(event.data?.type==='ruspet-task-notice')void refresh().catch(()=>{});};
  navigator.serviceWorker.addEventListener('message',received);
  return()=>navigator.serviceWorker.removeEventListener('message',received);
 },[data?.user.id]);
 useEffect(()=>{
  if(!data||viewingEmployee)return;
  const previous=lastNoticeCheck.current;
  lastNoticeCheck.current={userId:data.user.id,at:data.serverTime};
  if(previous?.userId===data.user.id&&data.notifications.some(notice=>(notice.task_notice||notice.staff_review||notice.management_notice)&&!notice.read_at&&notice.created_at>previous.at))
   showToast('Новые рабочие уведомления');
 },[data]);
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(completingTask&&!busy)setCompletingTask(null);else if(editor)setEditor(null);else if(requestType)setRequestType(null);else closeTask();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[requestType,editor,completingTask,busy]);
 function openSettings(target:string){go('settings');setSettingsTarget(target);}
 function go(next:Page,taskFilter?:string,view?:ReportView,workBucket:'all'|WorkBucket='all'){if((viewingEmployee&&!previewSections.has(next))||(data&&!canOpenWorkspacePage(data.user,next,data.analyticsAccess)))return;if(next!=='okb')setOkbCompany(null);if(next!=='processes')setProcessDraft(null);setTablePage(0);setPage(next);setMobileMenu(false);setShowTaskMetrics(false);if(next==='settings')setSettingsTarget(undefined);if(next==='notifications')setNoticeTab('feed');if(next==='actions')setWorkEntry(previous=>({bucket:workBucket,visit:previous.visit+1}));if(next==='tasks'&&(view||!taskFilter)){setTaskView(view??null);if(!taskFilter){setOwner('all');setFilter('all');setSearch('');setFromDate('');setToDate('');setBranch('all');setPriceFilter('all');setLinkedIds(null);setWorkDay(null);}}if(next==='reports'){setReportOpen(null);setReportPdf(false);setReportView(view??null);}if(next!=='tasks'){setLinkedIds(null);setWorkDay(null);}if(taskFilter){setSearch('');setFromDate('');setToDate('');setWorkDay(null);setLinkedIds(null);setPriceFilter('all');setFilter(taskFilter);setOwner('all');setBranch('all');}}
 const userById=(id:string)=>data?.users.find(u=>u.id===id);
 useEffect(()=>{
  if(!data)return;
  const refreshVisible=()=>{
   if(document.visibilityState!=='visible')return;
   void refresh().then(()=>{if(selected)return refreshDetail(selected);}).catch(()=>{});
  };
  const offline=()=>setConnectionIssue('unavailable');
  const poll=()=>{if(!busy&&!editor&&!requestType&&navigator.onLine)refreshVisible();};
  const visible=()=>{const stamp=snapshot.current?.data.serverTime;if(!stamp||Date.now()-Date.parse(stamp)>60000)poll();};
  window.addEventListener('online',refreshVisible);
  window.addEventListener('offline',offline);
  document.addEventListener('visibilitychange',visible);
  if(!navigator.onLine)offline();
  const timer=setInterval(poll,60000);
  return()=>{
   clearInterval(timer);
   window.removeEventListener('online',refreshVisible);
   window.removeEventListener('offline',offline);
   document.removeEventListener('visibilitychange',visible);
  };
 },[data?.user.id,busy,editor,requestType,selected]);
 useEffect(()=>{if(data&&!data.rules.showPlanning&&filter==='planned_today')setFilter('all');},[data?.rules.showPlanning,filter]);
 const appliedLink=useRef('');
 useEffect(()=>{if(!data)return;const marker=data.user.id+':'+location.search;if(appliedLink.current===marker)return;appliedLink.current=marker;const q=new URLSearchParams(location.search);if(q.get('view')==='registrations'&&data.user.role==='admin'){setSettingsTarget('registrations');setPage('settings');return;}if(q.get('view')==='approvals'&&canOpenWorkspacePage(data.user,'approvals')){setPage('approvals');return;}if(q.get('view')==='notifications'){setPage('notifications');return;}if(q.get('view')==='actions'){const bucket=q.get('queue')||'';setWorkEntry({bucket:Object.hasOwn(workLabels,bucket)?bucket as WorkBucket:'all',visit:0});setPage('actions');return;}if(q.get('view')==='analytics'&&data.analyticsAccess&&!viewingEmployee){setPage('analytics');return;}if(q.get('view')==='calendar'&&!viewingEmployee){setPage('calendar');return;}if(q.get('view')==='reports'){if(!q.get('report')&&!canOpenWorkspacePage(data.user,'reports'))return;setPage('reports');setReportOpen(q.get('report'));setReportPdf(q.get('format')==='pdf');return;}if(q.get('view')!=='tasks')return;setPage('tasks');setTaskView(q.get('scope')==='created'?'created':q.get('scope')==='team'?'team':q.get('scope')==='mine'||q.get('owner')===data.user.id?'mine':hasCompanyOverview(data.user)?'company':q.get('owner')&&managed(data.user)?'team':null);setTablePage(0);setSearch('');setBranch('all');setFromDate('');setToDate('');setLinkedIds(null);setFilter(q.get('filter')||'all');setOwner(q.get('owner')||'all');setWorkDay(q.get('day'));if(['deadline','title','transfers','price_desc','work_priority'].includes(q.get('sort')||''))setSort(q.get('sort')!);setPriceFilter(q.get('price')||'all');if(q.get('task'))void openTask(q.get('task')!);const reportId=q.get('report');if(reportId)void api<import('../shared/types.js').Report>('/reports/'+encodeURIComponent(reportId)).then(r=>{const subset=q.get('subset'),s=r.summary,at=new Date(s?.to||r.created_at);const outcomeIds:Record<string,string[]|undefined>={submitted:s?.activity.submittedIds,transferred:s?.outcomes?.transferIds,requested_transfer:s?.outcomes?.requestedTransferIds,explained:s?.outcomes?.explanationIds,approval_decision:s?.approvalQueue?.decisionIds,approval_clarification:s?.approvalQueue?.clarificationIds,creator_open:s?.creatorProgress?.openIds,creator_moved:s?.creatorProgress?.movedIds,creator_idle:s?.creatorProgress?.idleOverdueIds,creator_decision:s?.creatorProgress?.myDecisionIds,creator_on_time:s?.creatorProgress?.closedOnTimeIds,creator_late:s?.creatorProgress?.closedLateIds};const ids=subset&&subset in outcomeIds?outcomeIds[subset]:subset==='elapsed_today'?r.rows.filter(t=>elapsedToday(t,at)).map(t=>t.id):subset==='due_later_today'?r.rows.filter(t=>taskQueue(t,at)==='today'&&!elapsedToday(t,at)).map(t=>t.id):subset==='expected'?s?.front.expectedIds:subset==='front_closed'?s?.front.closedIds:subset==='processed'?s?.activity.processedIds:subset==='closed'?s?.activity.closedIds:subset==='remaining'?s?.front.remainingIds:subset==='tomorrow'?s?.tomorrow.ids:subset==='late'?s?.lateIds:r.rows.filter(t=>!subset||subset==='all'||taskQueue(t,at)===subset).map(t=>t.id);setLinkedIds(ids||[]);setFilter('all');}).catch(e=>setError(e.message));},[data?.user.id]);
 const now=data?new Date(data.serverTime):new Date();
 const overdue=(t:Task)=>taskQueue(t,now)==='overdue';
 const taskState=(t:Task)=>t.status==='completed'?'completed':data?.approvals.some(a=>activeTaskApproval(t,a))?'pending':overdue(t)?'overdue':t.status;
 const filterTasks=(items:Task[],f=filter)=>items.filter(t=>f==='all'||f==='risk'&&t.customer_risk===true&&t.status!=='completed'||f.startsWith('day:')&&t.status==='active'&&!!t.deadline&&businessDay(t.deadline)===f.slice(4)||f==='planned_today'&&plannedToday(t,now)||f==='active'&&t.status!=='completed'||f==='overdue'&&overdue(t)||f==='my_due'&&t.assignee_id===data?.user.id&&['today','overdue'].includes(taskQueue(t,now))&&taskNextAction(t,data?.approvals.find(a=>activeTaskApproval(t,a)),data?.approvalScope)?.userId===data?.user.id||f==='today'&&taskQueue(t,now)==='today'||f==='upcoming'&&taskQueue(t,now)==='upcoming'||f==='no_deadline'&&taskQueue(t,now)==='no_deadline'||f==='completed'&&t.status==='completed'||f==='review'&&t.status==='review'||f==='waiting'&&data?.controls.some(c=>c.task_id===t.id&&['waiting','escalated'].includes(c.state))||f==='pending'&&data?.approvals.some(a=>activeTaskApproval(t,a)));
 function renderTaskTable(tasks:Task[]) {
  return tasks.length?<div className="table-scroll"><table>
   <thead><tr><th>Задача</th><th>Исполнитель и постановщик</th><th>Цена · категория</th><th>Крайний срок</th><th>Состояние</th><th>Переносы</th><th aria-label="Действия"/></tr></thead>
   <tbody>{tasks.slice(tablePage*50,tablePage*50+50).map(t=>{
    const approval=data!.approvals.find(a=>activeTaskApproval(t,a));
    const next=taskNextAction(t,approval,data!.approvalScope);
    return <tr key={t.id}>
    <td><button className="task-link" onClick={()=>void openTask(t.id)}><span className="task-id">#{t.id} <span>{t.code}</span></span><strong>{t.title}</strong></button></td>
    <td><TaskPeople task={t} users={data!.users}/><small>{t.branch_id}</small></td>
    <td><strong>{formatPrice(t)}</strong><small>{priceLabels[priceBand(t)]}</small></td>
    <td className={overdue(t)?'late-date':''}>{date(t.deadline,true)}
     {elapsedToday(t,now)&&<small className="red-text">Время истекло сегодня</small>}
     {overdue(t)&&<small>Просрочено {Math.max(1,Math.round((new Date(businessDay(now)).getTime()-new Date(businessDay(t.deadline!)).getTime())/86400000))} дн.</small>}
    </td>
    <td><Badge state={taskState(t)}>{taskState(t)==='overdue'?'Просрочена':undefined}</Badge>{(approval||t.status==='review')&&next?.userId&&<small>{next.label} · {userById(next.userId)?.name??next.userId}</small>}</td>
    <td className="mono">{t.transfer_count||'—'}</td>
    <td><div className="task-row-actions">
     {!viewingEmployee&&canComplete(data!.user,t,data!.approvalScope)&&!approval&&!data!.pendingAssignmentIds?.includes(t.id)&&
      <button type="button" className="button secondary" disabled={busy} onClick={()=>{setError('');setCompletingTask(t);}}>Завершить</button>}
    </div></td>
   </tr>;})}</tbody>
  </table></div>:<Empty>Задач с выбранными условиями нет. Попробуйте изменить фильтры.</Empty>;
 }
 if(loading)return <div className="boot" role="status" aria-live="polite"><CapMark loading/><h2>РУСПЭТ</h2><p>Загружаем рабочее пространство…</p></div>;
 if(!data&&viewingEmployee)return <div className="boot"><h2>Просмотр недоступен</h2><p role="alert">{error}</p><a className="button secondary" href="/">Перейти в панель</a></div>;
 if(!data&&!demo&&!error)return <Login onLogin={value=>{snapshot.current=undefined;pendingWrites.current.clear();setConnectionIssue(null);setData(value);}}/>;
 if(!data)return <div className="boot"><h2>Не удалось открыть систему</h2><p>{error}</p><button onClick={()=>location.reload()}>Попробовать снова</button></div>;
 const connectionNotice=connectionIssue&&<div className="alert error connection-notice" role="status">
  <span>{connectionIssue==='expired'?'Сессия завершилась. Войдите снова в другой вкладке, чтобы сохранить открытые формы.':
   `Не удалось обновить данные. Последняя синхронизация в ${new Date(data.serverTime).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'})} МСК.`}</span>
  {connectionIssue==='expired'?<a className="button secondary" href="/" target="_blank" rel="noopener">Войти</a>:
   <button className="button secondary" disabled={busy} onClick={()=>void refresh().catch(()=>{})}>Повторить</button>}
 </div>;
 const requestedView=new URLSearchParams(location.search).get('view');
 const mobilePath=location.pathname==='/mobile'||location.pathname==='/mobile/';
 if(!viewingEmployee&&(mobilePath||compact&&data.user.role==='employee'&&location.pathname==='/'&&!location.hash&&(!requestedView||requestedView==='notifications'))){
  return <MobileWorkspace key={data.user.id} user={data.user} refresh={refresh} calendarRefresh={data.serverTime} analytics={!!data.analyticsAccess} unread={data.notifications.some(item=>!item.read_at)} connectionNotice={connectionNotice}/>;
 }
 const company=hasCompanyOverview(data.user),teamAllowed=managed(data.user);
 const currentScope=taskView==='company'&&!company?'mine':taskView==='team'&&!teamAllowed?'mine':taskView??'mine';
 const members=new Set(data.teamIds);
 const scopedTasks=linkedIds?data.tasks.filter(t=>linkedIds.includes(t.id)):currentScope==='mine'?data.tasks.filter(t=>t.assignee_id===data.user.id):
  currentScope==='created'?data.tasks.filter(t=>t.creator_id===data.user.id):
  currentScope==='team'?data.tasks.filter(t=>members.has(t.assignee_id)):data.tasks;
 const taskIndex=new Map(data.tasks.map(task=>[task.id,task]));
 const teamDirectory=currentScope==='team'&&!linkedIds&&owner==='all'&&filter==='all'&&!workDay;
 const pending=data.approvals.filter(a=>{const task=taskIndex.get(a.task_id);return !!task&&activeTaskApproval(task,a);});
 const pendingTasks=new Set(pending.map(a=>a.task_id));
 const matchingTasks=scopedTasks.filter(t=>(priceFilter==='all'||priceBand(t)===priceFilter)&&(branch==='all'||t.branch_id===branch)&&(currentScope==='mine'&&!linkedIds||owner==='all'||t.assignee_id===owner)&&(!fromDate||!!t.deadline&&businessDay(t.deadline)>=fromDate)&&(!toDate||!!t.deadline&&businessDay(t.deadline)<=toDate)&&`${t.title} ${t.id} ${userById(t.assignee_id)?.name}`.toLowerCase().includes(search.trim().replace(/^#\s*/,'').toLowerCase()));
 const visible=filterTasks(matchingTasks).sort((a,b)=>sort==='price_desc'?(taskPrice(b)??-1)-(taskPrice(a)??-1):sort==='work_priority'?compareWorkPlan(a,b,workDay||businessDay(now)):sort==='title'?a.title.localeCompare(b.title,'ru'):sort==='transfers'?b.transfer_count-a.transfer_count:(a.deadline||'9999').localeCompare(b.deadline||'9999'));
 const myWork=workQueue(data),myActionCount=workCount(myWork);
 const myApprovals=pending.filter(a=>approvalTurn(a).userId===data.user.id);
 const scopedMetrics=summarize(matchingTasks,now);
 const taskTabs=[{id:'all',label:'Все задачи',count:matchingTasks.length},{id:'today',label:'Срок сегодня',count:scopedMetrics.today},...(data.rules.showPlanning?[{id:'planned_today',label:'План на сегодня'}]:[]),{id:'overdue',label:'Просрочки прошлых дней',count:scopedMetrics.overdue},{id:'review',label:'На приёмке',count:scopedMetrics.review},{id:'upcoming',label:'Предстоящие'},{id:'no_deadline',label:'Без срока'},{id:'pending',label:'На согласовании',count:matchingTasks.filter(task=>pendingTasks.has(task.id)).length},{id:'completed',label:'Завершены'}];
 const cardApproval=detail?.approvals.some(a=>activeTaskApproval(detail.task,a));
 const cardCanComplete=!!detail&&!viewingEmployee&&!cardApproval&&!detail.personalPlan?.needsAcceptance&&canComplete(data.user,detail.task,detail.approvalScope);
 const title=page==='notifications'?'Уведомления':nav.find(n=>n.id===page)?.label;
 return <div className="app">
  <aside className={mobileMenu?'sidebar mobile-open':'sidebar'}><a className="brand" href="#" onClick={e=>{e.preventDefault();go('overview');}}><CapMark/><span>РУСПЭТ<small>Контроль и согласование</small></span></a>{data.managerPreview&&<p className="nav-label">Учебный стенд</p>}<nav>{nav.filter(n=>(!viewingEmployee||previewSections.has(n.id))&&canOpenWorkspacePage(data.user,n.id,data.analyticsAccess)).map(({id,label,icon:Icon},i)=><button key={id} className={`${page===id?'active':''} ${i===6?'nav-divider':''}`} onClick={()=>go(id)}><Icon size={18}/><span>{label}</span>{id==='actions'&&myActionCount>0&&<b title="Задачи, где ход за вами">{myActionCount}</b>}{id==='approvals'&&myApprovals.length>0&&<b>{myApprovals.length}</b>}</button>)}{!viewingEmployee&&data.user.root_access&&<a className="owner-planner-link" href="/time"><CalendarDays size={18}/> Личный планер</a>}{!viewingEmployee&&<a className="owner-planner-link" href="/mobile"><MessageSquare size={18}/> Мобильная версия</a>}</nav></aside>
  <div className="workspace-main"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-toggle" aria-label="Меню" onClick={()=>setMobileMenu(!mobileMenu)}><PanelLeftClose size={19}/></button><span>Рабочее пространство</span><ChevronRight size={14}/><strong>{title}</strong></div><div className="topbar-right"><ThemeToggle/>{demo&&<span className="demo-label">ДЕМО</span>}<button className="icon-button notification-button" aria-label="Уведомления" onClick={()=>go('notifications')}><Bell size={19}/>{data.notifications.some(item=>!item.read_at)&&<i/>}</button><div className="user-switch"><Avatar user={data.user}/>{demo?<div><label htmlFor="persona">Демонстрационная роль</label><select id="persona" value={data.user.id} disabled={busy} onChange={e=>void login(e.target.value)}>{users.map(u=><option key={u.id} value={u.id}>{u.name} · {roles[u.role]}</option>)}</select></div>:<div><strong>{data.user.name}</strong><small>{data.user.root_access?'Владелец · root':data.user.position.trim()||roles[data.user.role]}</small></div>}{!demo&&!viewingEmployee&&<button className="text-button" disabled={busy} onClick={()=>void logout()}>Выйти</button>}</div></div></header>
  <main>{viewingEmployee&&<div className="source-banner view-as-banner"><div><strong>Просмотр от имени {data.user.name}</strong><p>Данные и задачи доступны по роли сотрудника. Режим только для чтения.</p></div><a className="button secondary" href="/">В админскую панель</a></div>}{page!=='analytics'&&<div className="page-heading"><div>{page==='overview'&&<div className="eyebrow">{new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric',weekday:'long'}).format(now)}</div>}<h1>{title}</h1>{page!=='overview'&&<p>{({org:'Руководители команд и временные замещения.',delegations:'Выданные поручения, сроки и приёмка.',processes:'Условия создания задач и расписания повторений.',okb:'Компании, контакты и состояние работы с ними.',actions:'Просрочки, оставшиеся сроки на сегодня и задачи, где нужен следующий шаг.',bot:'Личные чаты и действия по задачам.',overview:'',tasks:'Сроки, исполнители и полная история каждой задачи.',approvals:'Запросы на перенос крайнего срока и закрытие задач.',checks:'Нарушения по задачам и ответы сотрудников.',reports:'Сохранённые снимки состояния. Часовой пояс — Москва.',people:'Нагрузка и состояние задач в вашей области доступа.',journal:'История действий, ответов и решений без перезаписи.',settings:'Правила контроля, маршруты и состояние подключений.',notifications:'Уведомления по задачам, проверкам и решениям.'} as Record<Page,string>)[page]}</p>}</div><div className="heading-actions">{page!=='bot'&&<button className="button secondary square" aria-label="Обновить данные" disabled={busy} onClick={()=>{setBusy(true);refresh().then(()=>showToast('Данные обновлены')).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}><RefreshCw size={16}/></button>}{page==='bot'&&<button className="button secondary" onClick={()=>openSettings('notices')}>Уведомления и Telegram</button>}{!viewingEmployee&&page==='tasks'&&<button className="button primary" disabled={busy} onClick={()=>setEditor({task:null})}>Создать задачу</button>}{!viewingEmployee&&managed(data.user)&&page==='checks'&&<button className="button primary" disabled={busy} onClick={()=>void act('/checks/run',undefined,'POST','Проверка завершена. Нарушения и запросы обновлены.')} ><ShieldCheck size={17}/> Проверить задачи</button>}</div></div>}
  {connectionNotice}
  {error&&<div className="alert error" role="alert"><AlertCircle size={18}/><span>{error}</span><button className="icon-button" aria-label="Скрыть ошибку" onClick={()=>setError('')}><X size={16}/></button></div>}
  {!viewingEmployee&&!selected&&page!=='analytics'&&<UndoAction refreshKey={data.user.id+data.serverTime} busy={busy} act={act}/>}
  {page==='actions'&&<ActionWorkspace key={data.user.id+':'+workEntry.visit} data={data} initial={workEntry.bucket} queue={myWork} open={openTask} complete={viewingEmployee?undefined:task=>{setError('');setCompletingTask(task);}} busy={busy}/>}
  {page==='bot'&&<BotConversation key={data.user.id} refresh={refresh}/>}
  {page==='overview'&&<ManagerHome data={data} queue={myWork} open={openTask} actions={bucket=>go('actions',undefined,undefined,bucket)} tasks={filter=>go('tasks',filter,'mine')} placed={()=>go('tasks','all','created')}
   complete={viewingEmployee?undefined:task=>{setError('');setCompletingTask(task);}} busy={busy}
   team={teamAllowed?()=>go('tasks','all','team'):undefined} calendar={viewingEmployee?undefined:()=>go('calendar')}/>}


  {!viewingEmployee&&page==='calendar'&&(data.user.root_access?<section className="panel"><div className="panel-heading"><h2>Личный планер</h2><a className="button primary" href="/time">Открыть планер</a></div></section>:<PersonalCalendar open={id=>void openTask(id)} refreshKey={data.serverTime}/>)}
  {page==='analytics'&&!viewingEmployee&&data.analyticsAccess&&<WorkspaceSection label="Загружаем аналитику…"><TeamAnalytics key={data.user.id} openTask={(id,tab)=>void openTask(id,tab)}/></WorkspaceSection>}


  {page==='tasks'&&<><div className="task-scope-switches" aria-label="Область задач">
   <TaskRoleSwitch value={!linkedIds&&(currentScope==='mine'||currentScope==='created')?currentScope:undefined} change={scope=>go('tasks','all',scope)}/>
   {teamAllowed&&<button className={'button '+(!linkedIds&&currentScope==='team'?'primary':'secondary')} onClick={()=>go('tasks','all','team')}>Задачи команды</button>}
   {company&&<button className={'button '+(!linkedIds&&currentScope==='company'?'primary':'secondary')} onClick={()=>go('tasks','all','company')}>Вся компания</button>}
  </div>{company&&currentScope==='company'&&!linkedIds&&<details className="report-more" open={showTaskMetrics} onToggle={e=>setShowTaskMetrics(e.currentTarget.open)}>
   <summary>Сводка по ценам и срокам</summary>
   {showTaskMetrics&&<><Dashboard key={data.user.id} data={data} now={now} go={(f,id,price)=>{go('tasks',f,'company');setOwner(id||'all');if(price)setPriceFilter(price);}}/>
    {data.source&&<details className="report-more"><summary>Источник и свежесть данных</summary><p>{data.source.file_name} · {data.source.sheet_name} · {data.source.row_count} задач</p>
     {data.selection&&<p>В рабочей выборке: {data.selection.included}. Исключено: {data.selection.checklist} с чек-листами и {data.selection.unfinishedAnalysis} на анализ невыполненных задач.</p>}
     <dl className="freshness"><div><dt>Импорт в систему</dt><dd>{moscowTimestamp(data.source.imported_at)}</dd></div><div><dt>Последнее изменение задач</dt><dd>{moscowTimestamp(data.lastTaskChange)}</dd></div><div><dt>Расчёт показателей</dt><dd>{moscowTimestamp(data.serverTime)}</dd></div></dl>
    </details>}</>}
  </details>}{teamDirectory?<TeamTasks tasks={scopedTasks} users={data.users} now={now} onSelect={(id,f)=>{go('tasks',f,'team');setOwner(id);}}/>:<>{linkedIds&&<div className="source-banner">Выборка из сохранённого отчёта · показано текущее состояние доступных задач.<button className="text-button" onClick={()=>go('tasks','all')}>Сбросить выборку</button></div>}<Tabs value={filter} onChange={setFilter} items={taskTabs}/>{!taskTabs.some(t=>t.id===filter)&&<div className="active-filter">Выборка: {({active:'Активные',review:'Ожидают приёмки',my_due:'Мои просрочки и сроки на сегодня',waiting:'Ждут ответа исполнителя'} as Record<string,string>)[filter]||(filter.startsWith('day:')?'Крайний срок '+filter.slice(4):filter==='risk'?'Риск потери клиента':filter)}<button className="text-button" onClick={()=>setFilter('all')}>Сбросить</button></div>}<section className="panel task-panel"><div className="filters"><label className="search-input"><Search size={17}/><input aria-label="Поиск задач" placeholder="Название, номер или сотрудник" value={search} onChange={e=>setSearch(e.target.value)}/></label><SearchFilter label="Филиал" value={branch} onChange={setBranch} empty={{value:'all',label:'Все филиалы'}} placeholder="Название подразделения" options={[...new Set(data.tasks.map(t=>t.branch_id))].sort((a,b)=>a.localeCompare(b,'ru')).map(value=>({value,label:value}))}/>{(currentScope!=='mine'||linkedIds)&&<EmployeeFilter label="Исполнитель" value={owner} onChange={setOwner} empty={{value:'all',label:'Все исполнители'}} people={data.users.filter(u=>u.id===owner||scopedTasks.some(t=>t.assignee_id===u.id))}/>}<label className="date-filter">Крайний срок от<input aria-label="Крайний срок от" type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)}/></label><label className="date-filter">до<input aria-label="Крайний срок до" type="date" min={fromDate} value={toDate} onChange={e=>setToDate(e.target.value)}/></label><select aria-label="Категория цены" value={priceFilter} onChange={e=>{setPriceFilter(e.target.value);setTablePage(0)}}><option value="all">Любая цена</option>{Object.entries(priceLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><select aria-label="Сортировка" value={sort} onChange={e=>setSort(e.target.value)}><option value="deadline">По сроку</option><option value="price_desc">По цене: сначала дороже</option><option value="work_priority">Порядок работы: просрочки и цена</option><option value="title">По названию</option><option value="transfers">По переносам</option></select></div>{(search||currentScope!=='mine'&&owner!=='all'||branch!=='all'||fromDate||toDate||priceFilter!=='all'||workDay)&&<div className="active-filter"><span>{[search&&'Поиск: '+search,currentScope!=='mine'&&owner!=='all'&&userById(owner)?.name,branch!=='all'&&branch,fromDate&&'С '+fromDate,toDate&&'По '+toDate,priceFilter!=='all'&&priceLabels[priceFilter as keyof typeof priceLabels],workDay&&'На '+workDay].filter(Boolean).join(' · ')}</span><button className="text-button" onClick={()=>go('tasks','all')}>Сбросить фильтры</button></div>}{renderTaskTable(visible)}{visible.length>50&&<div className="pagination"><button className="button secondary" disabled={tablePage===0} onClick={()=>setTablePage(p=>p-1)}>Назад</button><span>{tablePage+1} / {Math.ceil(visible.length/50)}</span><button className="button secondary" disabled={(tablePage+1)*50>=visible.length} onClick={()=>setTablePage(p=>p+1)}>Далее</button></div>}<div className="panel-footer"><span>Найдено {visible.length} из {scopedTasks.length}</span></div></section></>}</>}
  {page==='approvals'&&data.user.role==='admin'&&!viewingEmployee&&<DirectorBatch stamp={data.serverTime}/>}
  {page==='approvals'&&<ApprovalWorkspace readOnly={viewingEmployee} data={data} render={a=><ApprovalCard a={a} data={data} busy={busy} act={act} openTask={openTask}/>}/>}
  {page==='checks'&&<QualityWorkspace key={data.user.id} data={data} open={(id,tab)=>void openTask(id,tab)} settings={viewingEmployee?undefined:()=>openSettings('rules')}/>}
  {page==='reports'&&<WorkspaceSection label="Загружаем отчёты…"><Reports key={data.user.id+':'+(reportView??'default')} initialView={reportView??undefined} initialReport={reportOpen} downloadPdf={reportPdf} readOnly={viewingEmployee} data={data} refresh={refresh} openAutomation={company&&!viewingEmployee?()=>openSettings('automation'):undefined}/></WorkspaceSection>}
  {page==='people'&&managed(data.user)&&<Performance data={data} open={openTask} canObserve={company&&!viewingEmployee}/>}
  {page==='journal'&&<Journal data={data} open={openTask}/>}
  {page==='notifications'&&<>
   <Tabs value={noticeTab} onChange={setNoticeTab} items={[{id:'feed',label:'Лента'},{id:'reminders',label:'Напоминания'}]}/>
   {noticeTab==='reminders'?<ReminderInbox readOnly={viewingEmployee} key={data.user.id} userId={data.user.id} open={openTask} onChange={refresh}/>:<NotificationCenter key={data.user.id} items={data.notifications} readOnly={viewingEmployee} open={openTask} refresh={refresh}/>}
  </>}
  {page==='okb'&&canUseOkb(data.user)&&<WorkspaceSection label="Загружаем ОКБ…"><Okb key={data.user.id} initialId={okbCompany} users={data.users} openTask={id=>{setOkbCompany(null);void openTask(id);}} createTask={companyId=>{setOkbCompany(null);setEditor({task:null,companyId});}}/></WorkspaceSection>}
  {page==='org'&&['admin','director'].includes(data.user.role)&&<OrgWorkspace currentUser={data.user}/>}
  {page==='delegations'&&managed(data.user)&&<DelegationInbox open={openTask}/>}
  {page==='processes'&&<WorkspaceSection label="Загружаем бизнес-процессы…"><WorkDesign key={data.user.id} user={data.user} users={data.users} draft={processDraft} open={openTask}/></WorkspaceSection>}
  {page==='settings'&&<SettingsSections key={data.user.id+':'+(settingsTarget??'')} userId={data.user.id} initial={data.user.role==='admin'?'staff':'notices'} initialSelection={settingsTarget} items={[
   ...(data.user.role==='admin'?[{id:'staff',label:'Сотрудники и права',content:<AccessDirectory roles={roles} currentUserId={data.user.id}/>},
    {id:'registrations',label:'Заявки и подключение',content:<StaffOnboarding roles={roles}/>}]:[]),
   ...(managed(data.user)?[{id:'rules',label:'Правила и согласования',content:<>{data.user.role==='admin'&&<ApprovalHierarchySettings users={data.users}/>}<Settings key={data.rulesVersion} data={data} busy={busy} act={act}/></>}]:[]),
   {id:'notices',label:'Уведомления и Telegram',content:<><NotificationSettings userId={data.user.id}/><TelegramSettings key={data.user.id} user={data.user} users={data.users}/>{company&&<ManagementPreference/>}</>},
   {id:'appearance',label:'Оформление',content:<Appearance/>},
   ...(company?[{id:'automation',label:'Расписание отчётов',content:<Operations onChange={refresh} editable={data.user.role==='admin'}/>}]:[]),
   ...(data.user.role==='admin'?[
    {id:'system',label:'Система и подключения',content:<><SystemHealth/><PilotReadiness root={!!data.user.root_access}/><BitrixArchiveStatus/></>}
   ]:[])
  ]}/>}
  <footer className="main-footer"><span>РУСПЭТ · Контроль и согласование задач</span></footer></main></div>
  {selected&&<div className="drawer-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)closeTask();}}>
   <div className="drawer task-card" role="dialog" aria-modal="true" aria-label="Карточка задачи">
    <div className="drawer-top"><span>ЗАДАЧА #{selected}</span>
     <div className="task-card-toolbar">
      {detail&&!viewingEmployee&&<>
       {detail.editAccess.canEdit?<button type="button" className="button secondary" disabled={busy} onClick={()=>setEditor({task:detail.task})}><Pencil size={15}/>Редактировать</button>:
        (detail.editAccess.canRequest||detail.editAccess.request)&&<button type="button" className="button secondary" onClick={()=>setDrawerTab('approvals')}>
         {detail.editAccess.request?.state==='pending'?'К запросу правки':'Запросить редактирование'}
        </button>}
      </>}
      {cardCanComplete&&<button type="button" className="button primary" disabled={busy} onClick={()=>{setError('');setCompletingTask(detail!.task);}}>Завершить задачу</button>}
      <details key={selected} className="task-card-more" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.open=false;}} onKeyDown={e=>{
       if(e.key!=='Escape'||!e.currentTarget.open)return;
       e.stopPropagation();e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();
      }}>
       <summary className="button secondary">Ещё <ChevronDown size={14}/></summary>
       <div className="task-card-more-actions" onClick={e=>{
        if(e.target instanceof Element&&e.target.closest('button'))e.currentTarget.parentElement?.removeAttribute('open');
       }}>
        {detail&&!viewingEmployee&&<>
         <button type="button" disabled={busy} onClick={()=>setEditor({task:null,copyOf:detail.task})}><Copy size={15}/>Создать копию</button>
         {detail.approvalWatch?.canChange&&detail.task.status!=='completed'&&(detail.approvalWatch.byCode?
          <span><Bookmark size={15}/>Контроль по коду В</span>:
          <button type="button" disabled={busy} onClick={()=>void act('/tasks/'+encodeURIComponent(detail.task.id)+'/approval-watch',{enabled:!detail.approvalWatch?.manual},'PUT')}>
           <Bookmark size={15}/>{detail.approvalWatch.manual?'Снять с контроля':'Взять на контроль'}
          </button>)}
        </>}
        <button type="button" onClick={()=>{
         const href=new URL('/',location.origin);
         href.searchParams.set('view','tasks');href.searchParams.set('task',selected);
         void navigator.clipboard.writeText(href.href).then(()=>showToast('Ссылка скопирована')).catch(()=>setError('Не удалось скопировать ссылку.'));
        }}><Link size={15}/>Скопировать ссылку</button>
       </div>
      </details>
      <button type="button" ref={drawerClose} className="icon-button" aria-label="Закрыть карточку" onClick={closeTask}><X size={21}/></button>
     </div>
    </div>
    {detail?<><div className="drawer-heading">
     <Badge state={taskState(detail.task)}>{taskState(detail.task)==='overdue'?'Просрочена':undefined}</Badge>
     <h2>{detail.task.title}</h2>
     <p>{[detail.task.branch_id,detail.task.code].filter(Boolean).join(' · ')}</p>
    </div>
    {detail.approvalProgress&&drawerTab!=='approvals'&&<section className="task-approval-progress" aria-label="Текущий этап согласования">
     <GitPullRequest size={18} aria-hidden="true"/>
     <div role="status">
      <strong>На согласовании · {detail.approvalProgress.type==='deadline'?'перенос крайнего срока':'закрытие задачи'}</strong>
      <p>Этап {detail.approvalProgress.step} из {detail.approvalProgress.total} · {detail.approvalProgress.label}
       {detail.approvalProgress.approver&&<> · <b>{detail.approvalProgress.approver}</b></>}</p>
      {detail.approvalProgress.clarificationBy
       ?<p>Нужен ответ на уточнение · <b>{detail.approvalProgress.clarificationBy}</b></p>
       :detail.approvalProgress.deferredUntil&&Date.parse(detail.approvalProgress.deferredUntil)>now.getTime()&&
        <p>Решение отложено до {date(detail.approvalProgress.deferredUntil,true)}</p>}
     </div>
     <button type="button" className="text-button" onClick={()=>setDrawerTab('approvals')}>К согласованию</button>
    </section>}
    <Tabs value={drawerTab} onChange={setDrawerTab} items={[
     {id:'info',label:'Обзор'},{id:'result',label:'Результат',count:detail.submissions.length||undefined},
     {id:'fields',label:'Поля'},{id:'discussion',label:'Обсуждение',count:detail.comments.length+detail.bitrixCommentCount||undefined},
     {id:'approvals',label:'Согласования',count:detail.approvals.length+(detail.editAccess.request?.state==='pending'?1:0)||undefined},
     {id:'links',label:'Связи и напоминания'},{id:'history',label:'История'}
    ]}/>
    <div className="drawer-body" key={drawerTab} data-tab={drawerTab} role="tabpanel">
    {error&&<div className="alert error" role="alert">{error}</div>}
    {drawerTab==='info'&&<div className="task-card-overview">
     <div>
      {detail.editAccess.canDecide&&!viewingEmployee&&<section className="task-card-section">
       <h3>Исполнитель просит разрешение на редактирование</h3>
       <button type="button" className="button primary" onClick={()=>setDrawerTab('approvals')}>Рассмотреть запрос</button>
      </section>}
      <section className="task-card-section"><h3>Описание задачи</h3>
       <p className="description">{detail.task.description||'Описание задачи не заполнено.'}</p>
      </section>
      {data.findings.some(f=>f.task_id===selected)&&<div className="findings-box">
       <h3><AlertCircle size={17}/>Требует внимания</h3>
       {data.findings.filter(f=>f.task_id===selected).map(f=><p key={f.id}>{f.message}</p>)}
      </div>}
     </div>
     <aside>
      {!viewingEmployee&&detail.personalPlan&&(detail.task.status==='active'||detail.personalPlan.plannedAt)&&<PersonalTaskPlan key={detail.task.id+':'+detail.personalPlan.epoch} task={detail.task} plan={detail.personalPlan} busy={busy} error={error} act={act}/>}
      <section className="task-card-section"><h3>Ответственные и срок</h3>
       <div className="task-facts">
        <div><span>Исполнитель</span><div className="person"><Avatar small user={userById(detail.task.assignee_id)}/><strong>{userById(detail.task.assignee_id)?.name}</strong></div></div>
        <div><span>Постановщик</span><strong>{userById(detail.task.creator_id)?.name}</strong></div>
        {detail.assignmentReceipt&&(!detail.personalPlan||viewingEmployee)&&<div><span>Приём задачи</span><strong>{detail.assignmentReceipt.state==='accepted'?'Задача принята':'Ждёт подтверждения исполнителя'}</strong></div>}
        <div><span>Крайний срок</span><strong className={overdue(detail.task)?'red-text':''}>{date(detail.task.deadline,true)}{detail.task.deadline?' МСК':''}</strong></div>
        <div><span>Цена задачи</span><strong>{formatPrice(detail.task)}</strong><small>{priceLabels[priceBand(detail.task)]}</small>{!viewingEmployee&&canEditTaskPrice(data.user,detail.task)&&<TaskPriceEditor key={detail.task.id+':'+detail.task.version} task={detail.task} busy={busy} act={act}/>}</div>
       </div>
       <div className="task-card-buttons">
        {!cardApproval&&!viewingEmployee&&detail.task.status!=='completed'&&allowedRequest(data.user,detail.task)&&
         <button type="button" disabled={busy} className="button secondary" onClick={()=>setRequestType('deadline')}><CalendarDays size={15}/>Предложить новый срок</button>}
        {!cardApproval&&detail.task.status==='review'&&<button type="button" className="button primary" onClick={()=>setDrawerTab('result')}>К приёмке</button>}
        {!cardApproval&&!cardCanComplete&&!viewingEmployee&&!detail.personalPlan?.needsAcceptance&&detail.task.status==='active'&&allowedRequest(data.user,detail.task)&&
         <button type="button" className="button secondary" onClick={()=>setDrawerTab('result')}>Сдать результат</button>}
       </div>
      </section>
      <section className="task-card-section"><h3>Изменения и возвраты</h3>
       <dl className="task-card-fields">
        <div><dt>Переносов срока</dt><dd>{detail.task.transfer_count}</dd></div>
        <div><dt>Отказов в согласовании</dt><dd>{detail.approvals.filter(a=>a.state==='rejected').length}</dd></div>
        <div><dt>Возвратов с приёмки</dt><dd>{detail.submissions.filter(s=>s.state==='returned').length}</dd></div>
       </dl>
      </section>
     </aside>
    </div>}
    {drawerTab==='fields'&&<>{!viewingEmployee&&['admin','director','sales_head'].includes(data.user.role)&&detail.task.branch_id===unassignedBranch&&
     <TaskBranchReview key={detail.task.id} task={detail.task} users={data.users} busy={busy} act={act}/>}
     <TaskCardFields task={detail.task} showPlanning={!!data.rules.showPlanning} date={date}/></>}
    {drawerTab==='links'&&<section className="task-card-section">
     {!viewingEmployee&&detail.task.company_id&&canUseOkb(data.user)&&<CompanyReference key={detail.task.company_id} id={detail.task.company_id} open={id=>{closeTask();go('okb');setOkbCompany(id);}}/>}
     <TaskDelegation readOnly={viewingEmployee} key={detail.task.id} task={detail.task} user={data.user} users={data.users} open={openTask}
      onCreated={()=>{void refreshDetail(detail.task.id).catch(e=>setError(e.message));void refresh().catch(()=>{});}}/>
     <TaskReminders readOnly={viewingEmployee} key={detail.task.id+data.user.id} task={detail.task} user={data.user} users={data.users}/>
    </section>}
    {drawerTab==='result'&&<>
     {!viewingEmployee&&!cardApproval&&(detail.personalPlan?.needsAcceptance?
      <div className="task-card-section"><p>Перед сдачей результата примите задачу и выберите плановое время.</p><button type="button" className="button secondary" onClick={()=>setDrawerTab('info')}>К приёму задачи</button></div>:
      <ReviewActions key={detail.task.id+detail.task.version} task={detail.task} user={data.user} scope={detail.approvalScope} busy={busy} act={act}/>)}
     {detail.submissions.length?<section className="submission-history">{detail.submissions.map(s=><article key={s.id}>
      <strong>{s.restored_from?'Приёмка восстановлена после отмены':s.automatic?'Автоматическая сдача после приёмки поручений':'Сдача №'+s.round} · {({review:'Ожидает приёмки',returned:'Возвращена',accepted:'Принята'})[s.state]}</strong>
      <small>{userById(s.author_id)?.name} · {date(s.submitted_at,true)}</small><p>{s.result}</p>
      {s.remark&&<blockquote><strong>{userById(s.reviewer_id||'')?.name}: </strong>{s.remark}</blockquote>}
     </article>)}</section>:null}
     <TaskResults key={selected} id={selected} linked={detail.bitrixLinked} hasLocal={!!detail.submissions.length}/>
    </>}
  {drawerTab==='discussion'&&<><TaskDiscussion key={selected} id={selected} comments={detail.comments} users={data.users}/>{!viewingEmployee&&detail.controls.filter(c=>['waiting','escalated'].includes(c.state)&&(data.user.id===c.assignee_id||data.user.role==='admin')).map(c=><ExplanationForm key={c.id} min={data.rules.responseMinLength} busy={busy} submit={body=>act(`/controls/${c.id}/answer`,body)}/>)}{!viewingEmployee&&<form className="comment-form" onSubmit={async e=>{e.preventDefault();const form=e.currentTarget;const f=new FormData(form),body=String(f.get('body')),approvalId=String(f.get('approvalId')||'')||undefined;if(await act(`/tasks/${selected}/comments`,{body,approvalId}))form.reset();}}>{detail.approvals.some(a=>!a.canceled_at)&&<label>К чему относится сообщение<select name="approvalId"><option value="">К задаче в целом</option>{detail.approvals.filter(a=>!a.canceled_at).map(a=><option key={a.id} value={a.id}>{a.type==='deadline'?'Перенос':'Закрытие'} от {date(a.created_at,true)}</option>)}</select></label>}<label>Комментарий<textarea name="body" required maxLength={4000} placeholder="Добавьте уточнение или результат работы…"/></label><button className="button primary" disabled={busy}><Send size={15}/>Отправить</button></form>}</>}
  {drawerTab==='history'&&<>{!viewingEmployee&&<UndoAction taskId={selected} refreshKey={data.user.id+data.serverTime} busy={busy} act={act}/>}
   {!viewingEmployee&&data.user.role==='admin'&&data.user.staff_undo_access&&<StaffUndo key={selected} taskId={selected} refreshKey={data.serverTime} busy={busy} error={error} act={act}/>}
   <TaskHistory showPlanning={!!data.rules.showPlanning} events={detail.events} users={data.users}/>{!viewingEmployee&&data.user.role==='admin'&&<BitrixActivity key={selected} id={selected} kind="history"/>}{demo&&!viewingEmployee&&data.user.role==='admin'&&<div className="demo-action"><p>Проверка сохранения согласования при изменении задачи</p><button className="text-button" disabled={busy} onClick={()=>void act('/tasks/'+selected+'/mock-change',{expectedVersion:detail.task.version})}>Изменить описание в mock-источнике <ArrowUpRight size={14}/></button></div>}</>}
  {drawerTab==='approvals'&&<>{!viewingEmployee&&<TaskEditPanel key={selected} task={detail.task} access={detail.editAccess} users={data.users} busy={busy} act={act}/>}<div className='task-card-approvals'>{detail.approvals.map(a=><div key={a.id}><ApprovalCard a={a} data={data} busy={busy} act={act} openTask={openTask} taskDetail={detail} inDrawer/>{detail.decisions.filter(d=>d.approval_id===a.id).map(d=><div className="decision-record" key={d.id}><Check size={14}/><div>{userById(d.actor_id)?.name} · {({approve:'Согласовал',reject:'Отказал',later:'Вернётся позже',clarify:'Запросил уточнение'} as Record<string,string>)[d.decision]}<small>{d.retracted?'Отменено · ':''}{date(d.created_at,true)}{d.comment&&` · ${d.comment}`}</small></div></div>)}</div>)}{!detail.approvals.length&&<Empty>Запросить перенос крайнего срока можно в обзоре.</Empty>}</div></>}
    </div></>:<div className="empty">{detailError?<><p role="alert">{detailError}</p><button className="button secondary" onClick={()=>void openTask(selected,drawerTab)}>Повторить загрузку</button></>:'Загружаем карточку…'}</div>}</div></div>}
  {requestType&&detail&&<RequestModal type={requestType} task={detail.task} min={data.rules.responseMinLength} busy={busy} error={error} close={()=>setRequestType(null)} submit={async body=>{if(await act(`/tasks/${detail.task.id}/approvals`,body)){setRequestType(null);setDrawerTab('approvals');}}}/>}
  {editor&&<TaskEditor key={editor.task?.id||editor.copyOf?.id||editor.companyId||'new'} task={editor.task} copyOf={editor.copyOf} companyId={editor.companyId} canLink={canUseOkb(data.user)} availableTasks={data.tasks} showPlanning={!!data.rules.showPlanning} users={data.users} user={data.user} busy={busy} saveError={error} save={(path,body,method,message)=>act(path,body,method,message,editor.copyOf?id=>void openTask(id):undefined)} close={()=>setEditor(null)} onConditional={canUseOkb(data.user)?draft=>{setProcessDraft(draft);setEditor(null);go('processes');}:undefined}/>}
  {completingTask&&<CompleteTaskDialog key={completingTask.id} task={completingTask} users={data.users} busy={busy} error={error}
   close={()=>setCompletingTask(null)} save={comment=>act('/tasks/'+encodeURIComponent(completingTask.id)+'/review',
    {action:'complete',comment,expectedVersion:completingTask.version},'POST','Задача завершена')}/>}
  {toast&&<div className="toast" role="status"><CheckCheck size={18}/>{toast}</div>}
 </div>;
}
type Act=(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>;
const transferDate=(value:string|null)=>value?new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}):'Без срока';
function DeadlineHistory({items,openDiscussion}:{items:DeadlineTransfer[];openDiscussion:()=>void}){
 return <aside className="approval-deadline-history" aria-label="История переносов">
  <h3>Прошлые переносы <small>{items.length}</small></h3>
  {!items.length?<p>Записей о переносах пока нет.</p>:<ol aria-label="Изменения крайнего срока" tabIndex={0}>
   {items.map(item=><li key={item.id}>
    <strong>{transferDate(item.from)} <span aria-hidden="true">→</span> {transferDate(item.to)}</strong>
    <small>{transferDate(item.occurredAt)} МСК · {item.author}</small>
    {item.reason&&<p><strong>Причина</strong><br/>{item.reason}</p>}
    {item.comments?.map(note=><div className="approval-transfer-comment" key={note.id}>
     <small>{note.source==='result'?'Из результата работы':'Из комментария'} · {note.author} · {transferDate(note.occurredAt)} МСК</small><p>{note.text}</p>
    </div>)}
    {!item.reason&&!item.comments?.length&&<small>Причина не найдена в обсуждении</small>}
   </li>)}
  </ol>}
  {items.length>0&&<button type="button" className="text-button approval-history-discussion" onClick={openDiscussion}>Открыть обсуждение</button>}
 </aside>;
}
const moscowDateInput=(value:string)=>new Date(Date.parse(value)+3*3600000).toISOString().slice(0,16);
function ApprovalCard({a,data,busy,act,openTask,inDrawer=false,taskDetail}: {
 a:Approval;data:Bootstrap;busy:boolean;act:Act;openTask:(id:string,tab?:string)=>Promise<void>;inDrawer?:boolean;taskDetail?:TaskDetail;
}) {
 const [comment,setComment]=useState(''),[thread,setThread]=useState('');
 const [answer,setAnswer]=useState('');
 const task=taskDetail?.task??data.tasks.find(t=>t.id===a.task_id);
 const [deadlineDraft,setDeadlineDraft]=useState<{revision:string;value:string}|null>(null);
 const transfers=taskDetail?.deadlineHistory??data.deadlineHistory?.[a.task_id]??[];
 const turn=approvalTurn(a);
 const actor=data.users.find(u=>u.id===a.route[a.current_step]?.userId);
 const nextPerson=data.users.find(u=>u.id===turn.userId)?.name;
 const waiting=turn.clarification;
 const resultReview=a.type==='completion'&&task?.status==='review';
 const change=a.task_change;
 const active=!!task&&activeTaskApproval(task,a);
 const canDecide=active&&!change?.routeIssue&&actor?.id===data.user.id&&!waiting;
 const canAnswer=active&&waiting&&a.requester_id===data.user.id;
 const isDeadline=a.type==='deadline';
 const editDeadlineInline=!viewingEmployee&&canDecide&&canSetApprovedDeadline(data.user.id,taskDetail?.deadlineApproverId??data.deadlineApproverId,a);
 const revision=`${a.id}:${a.action_revision}:${a.current_step}`;
 const proposed=a.proposed_deadline?moscowDateInput(a.proposed_deadline):'';
 const finalDate=deadlineDraft?.revision===revision?deadlineDraft.value:proposed;
 const changedDeadline=editDeadlineInline&&finalDate!==proposed;
 const finalTime=Date.parse(changedDeadline?finalDate+':00+03:00':a.proposed_deadline??'');
 const alreadySet=!changedDeadline&&!!a.proposed_deadline&&a.proposed_deadline===task?.deadline;
 const deadlineError=!Number.isFinite(finalTime)?'Укажите дату и время.':
  finalTime<=Date.now()&&!alreadySet?'Укажите срок в будущем.':'';
 const defaultAccept=isDeadline||resultReview;
 const approve=()=>void act(`/approvals/${a.id}/decision`,{
  decision:'approve',comment,expectedRevision:a.action_revision,expectedStep:a.current_step,
  ...(changedDeadline?{approvedDeadline:new Date(finalTime).toISOString()}:{})
 });
 return <section className={`panel approval-card ${inDrawer?'in-drawer':''}`}>
  <div className="approval-header"><div><span className="eyebrow">{a.type==='deadline'?'ПЕРЕНОС КРАЙНЕГО СРОКА':'ЗАКРЫТИЕ ЗАДАЧИ'} · #{a.task_id}</span>{!inDrawer&&<button className="approval-title" onClick={()=>void openTask(a.task_id,'approvals')}>{task?.title}<ArrowUpRight size={16}/></button>}</div><Badge state={a.canceled_at?'canceled':a.state==='pending'&&!active?'stale':a.state}/></div>
  <div className="approval-task-meta">
   {task&&<TaskPeople task={task} users={data.users}/>}
   <p>Цена задачи <strong>{task?formatPrice(task):'—'}</strong></p>
  </div>
  <div className="approval-body"><div className="approval-main">
  {isDeadline&&<div className="deadline-change"><div><span>Текущий крайний срок</span><strong>{date(task?.deadline||null,true)}</strong></div><ArrowRight size={20}/><div><span>Предложенный крайний срок</span><strong>{date(a.proposed_deadline,true)}</strong></div><small>МСК</small></div>}
  {editDeadlineInline&&<div className="approval-deadline-editor">
   <label>Итоговый крайний срок · МСК
    <input type="datetime-local" value={finalDate} min={moscowDateInput(new Date().toISOString())}
     aria-invalid={!!deadlineError} disabled={busy} onChange={e=>setDeadlineDraft({revision,value:e.target.value})}/>
   </label>
   <button type="button" className="button primary" disabled={busy||!!deadlineError} onClick={approve}>
    <Check size={16}/>{changedDeadline?'Согласовать с новым сроком':'Согласовать перенос'}
   </button>
   {(deadlineError||changedDeadline)&&<div className="approval-deadline-feedback">
    {deadlineError&&<small className="red-text">{deadlineError}</small>}
    {changedDeadline&&proposed&&<button type="button" className="text-button" disabled={busy} onClick={()=>setDeadlineDraft(null)}>Вернуть предложенный</button>}
   </div>}
  </div>}
  {a.approved_deadline&&a.approved_deadline!==a.proposed_deadline&&<p className="inline-note"><Check size={15}/> Согласованный крайний срок <strong>{date(a.approved_deadline,true)} МСК</strong></p>}
  {change&&<aside className="approval-update">
   <strong>{change.source==='bitrix'?'Изменения из Битрикс24':'Изменения в РУСПЭТ'} · {date(change.at,true)} МСК</strong>
   <ul>{approvalChangeLines(change,id=>data.users.find(u=>u.id===id)?.name).map(line=><li key={line}>{line}</li>)}</ul>
   {change.routeChanged&&<p>Маршрут пересчитан. Запрос снова на первом этапе.</p>}
   {change.routeIssue&&a.state==='pending'&&<p>Нужен другой согласующий. Проверьте участников и маршрут задачи.</p>}
  </aside>}
  <div className={`approval-context ${isDeadline?'single':''}`}><div><span>Причина</span><p>{a.reason}</p></div>
   {!isDeadline&&<div><span>Результат работы</span><p>{a.plan}</p></div>}
  </div>
  <div className="route-stage"><strong>Этап {a.current_step+1} из {a.route.length}: {a.route[a.current_step]?.label}</strong><span>{waiting?`Уточнение ждём от ${nextPerson||'автора запроса'}`:a.state==='pending'?`Решение за ${nextPerson||'согласующим'}`:a.canceled_at?'Отменено':stateLabels[a.state]}</span></div>
  {a.route.length>1&&<div className="route">{a.route.map((s,i)=><div key={i} className={i<a.current_step||a.state==='approved'?'done':i===a.current_step?'current':''}><span>{i<a.current_step||a.state==='approved'?<Check size={13}/>:i+1}</span><div><strong>{s.label}</strong><small>{data.users.find(u=>u.id===s.userId)?.name}</small></div>{i<a.route.length-1&&<ChevronRight size={14}/>}</div>)}</div>}
  {a.clarification_question&&<div className="clarification-thread"><strong>Уточнение согласующего</strong><p>{a.clarification_question}</p>{a.clarification_answer&&<><strong>Ответ автора запроса</strong><p>{a.clarification_answer}</p></>}</div>}
  {a.deferred_until&&a.state==='pending'&&<p className="inline-note"><Clock3 size={14}/> Решение отложено до {date(a.deferred_until,true)} МСК</p>}
  {a.state==='stale'&&!a.canceled_at&&<p className="inline-note red-text">Задача изменилась. Нужен новый запрос с актуальными данными.</p>}
  {!viewingEmployee&&canAnswer&&<div className="decision-form"><textarea aria-label="Ответ на уточнение" placeholder="Ответьте на вопрос согласующего…" value={answer} onChange={e=>setAnswer(e.target.value)} maxLength={4000}/><button className="button primary" disabled={busy||answer.trim().length<5} onClick={()=>void act(`/approvals/${a.id}/clarification`,{answer})}>Отправить ответ</button></div>}
  {!viewingEmployee&&canDecide&&<div className="decision-form">
   <input aria-label="Комментарий или вопрос" placeholder={defaultAccept?"Комментарий обязателен при отказе или уточнении":"Комментарий к решению или вопрос · минимум 5 символов"} maxLength={4000} value={comment} onChange={e=>setComment(e.target.value)}/><div>{!editDeadlineInline&&<button className="button primary" disabled={busy||!defaultAccept&&comment.trim().length<5} onClick={approve}><Check size={16}/>{a.current_step<a.route.length-1?"Согласовать и передать":resultReview?"Принять результат":"Согласовать"}</button>}<button className="button reject" disabled={busy||comment.trim().length<5} onClick={()=>void act(`/approvals/${a.id}/decision`,{decision:'reject',comment,expectedRevision:a.action_revision,expectedStep:a.current_step})}>{resultReview?"Вернуть с замечаниями":"Отклонить запрос"}</button><button className="button secondary" disabled={busy||comment.trim().length<5} onClick={()=>void act(`/approvals/${a.id}/decision`,{decision:'clarify',comment,expectedRevision:a.action_revision,expectedStep:a.current_step})}>Уточнить</button><button className="text-button" disabled={busy} onClick={()=>void act(`/approvals/${a.id}/decision`,{decision:'later',comment,expectedRevision:a.action_revision,expectedStep:a.current_step,remindMinutes:60})}><Clock3 size={15}/>Напомнить через час</button></div></div>}

 <details className="approval-discussion"><summary>Обсуждение запроса · {(data.approvalComments||[]).filter(c=>c.approval_id===a.id).length}</summary>{(data.approvalComments||[]).filter(c=>c.approval_id===a.id).map(c=><article className="comment" key={c.id}><div><strong>{data.users.find(u=>u.id===c.author_id)?.name}<small>{date(c.created_at,true)}</small></strong><p>{c.body}</p></div></article>)}{!viewingEmployee&&<><label>Сообщение по этому запросу<textarea maxLength={4000} value={thread} onChange={e=>setThread(e.target.value)} placeholder="Уточнение, ответ или ссылка на результат…"/></label><button className="button secondary" disabled={busy||!thread.trim()} onClick={async()=>{if(await act(`/tasks/${a.task_id}/comments`,{body:thread,approvalId:a.id}))setThread('')}}>Отправить сообщение</button></>}</details>
 </div><DeadlineHistory items={transfers} openDiscussion={()=>void openTask(a.task_id,'discussion')}/></div>
 </section>;
}
function ExplanationForm({min,busy,submit}: {min:number;busy:boolean;submit:(body:unknown)=>Promise<boolean>}){return <form className="explanation-form" onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);await submit({reason:f.get('reason'),progress:f.get('progress'),plan:f.get('plan')});}}><h3>Ответ по результатам проверки</h3><p>Каждое поле — минимум {min} символов. Это проверка полноты, содержание оценивает руководитель.</p>{[{id:'reason',label:'Что помешало выполнить задачу?'},{id:'progress',label:'Что уже сделано?'},{id:'plan',label:'Что будете делать дальше?'}].map(f=><label key={f.id}>{f.label}<textarea name={f.id} required minLength={min} maxLength={4000}/></label>)}<button disabled={busy} className="button primary">Сохранить объяснение</button></form>;}
function RequestModal({type,task,min,busy,error,close,submit}: {type:'deadline'|'completion';task:Task;min:number;busy:boolean;error:string;close:()=>void;submit:(body:unknown)=>Promise<void>}){return <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-label="Новый запрос" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void submit({type,reason:f.get('reason'),expectedVersion:task.version,...(type==='deadline'?{proposedDeadline:new Date(String(f.get('deadline'))+':00+03:00').toISOString()}:{plan:f.get('plan')})});}}><div className="panel-heading"><h2>{type==='deadline'?'Запросить перенос срока':'Запросить закрытие'}</h2><button type="button" className="icon-button" aria-label="Закрыть запрос" onClick={close}><X size={20}/></button></div><p>#{task.id} · {task.title}</p>{error&&<div className="alert error" role="alert">{error}</div>}{type==='deadline'&&<label>Новый срок · Москва (UTC+3)<input autoFocus name="deadline" type="datetime-local" required/></label>}<label>Причина запроса<textarea autoFocus={type==='completion'} name="reason" required minLength={min} maxLength={4000} placeholder="Что изменилось и почему требуется решение…"/></label>{type==='completion'?<label>Результат выполненной работы<textarea name="plan" required minLength={min} maxLength={4000}/></label>:<p className="muted">Крайний срок изменится после согласования.</p>}<div className="drawer-actions"><button type="button" className="button secondary" onClick={close}>Отмена</button><button disabled={busy} className="button primary">Отправить на согласование</button></div></form></div>;}
function Settings({data,busy,act}: {data:Bootstrap;busy:boolean;act:Act}){
 const [rules,setRules]=useState<Rules>(data.rules);const admin=data.user.role==='admin';const selectors=[{id:'branchManager',name:'Руководитель филиала'},{id:'salesHead',name:'Руководитель продаж'},{id:'director',name:'Директор'},{id:'creator',name:'Постановщик'}];
 return <div className="settings-grid"><form className="panel settings-form" onSubmit={e=>{e.preventDefault();void act('/rules',{rules,expectedVersion:data.rulesVersion},'PUT');}}><div className="panel-heading"><div><h2>Правила контроля</h2><p>Изменения сохраняются отдельной версией</p></div><Badge state="active">v{data.rulesVersion}</Badge></div><label className="toggle-row"><span><strong>Показывать планирование</strong><small>Плановые даты, нагрузка и проверки планирования. Данные сохраняются при выключении.</small></span><input type="checkbox" checked={!!rules.showPlanning} disabled={!admin||busy} onChange={e=>setRules({...rules,showPlanning:e.target.checked})}/></label>{([{key:'overdue',title:'Просроченный крайний срок',desc:'Незавершённые задачи, срок которых уже прошёл.'},{key:'missingDeadline',title:'Отсутствие крайнего срока',desc:'Задачи без даты завершения.'},{key:'plannedOverdue',title:'Нарушение планового срока',desc:'Плановый срок прошёл, крайний ещё не наступил.'},{key:'requiredFields',title:'Обязательные признаки задачи',desc:'Важность и риск потери клиента должны быть заполнены.'},{key:'planning',title:'Качество плана и подзадачи',desc:'Полнота дат, длительность до 6 часов и соответствие срокам родителя.'},{key:'code',title:'Буквенный код · правило GAS',desc:'Формат [РЕ][ЗПОВ][БМ]*; старые коды с # разрешены. Личные задачи исключены.'}] as const).filter(r=>rules.showPlanning||!['plannedOverdue','planning'].includes(r.key)).map(r=><label className="toggle-row" key={r.key}><span><strong>{r.title}</strong><small>{r.desc}</small></span><input type="checkbox" checked={rules[r.key]??false} disabled={!admin||busy} onChange={e=>setRules({...rules,[r.key]:e.target.checked})}/></label>)}<WrittenRules value={rules.writtenRules||[]} disabled={!admin||busy} onChange={writtenRules=>setRules({...rules,writtenRules})}/><div className="numeric-settings">{[{id:'responseMinLength',label:'Минимум символов в поле ответа',min:5,max:200},{id:'reminderMinutes',label:'Интервал напоминаний, мин.',min:1,max:1440},{id:'maxReminders',label:'Напоминаний до эскалации',min:0,max:10}].map(n=><label key={n.id}>{n.label}<input type="number" required min={n.min} max={n.max} value={rules[n.id as 'responseMinLength']} disabled={!admin||busy} onChange={e=>setRules({...rules,[n.id]:Number(e.target.value)})}/></label>)}</div><h3>Маршруты согласования</h3><p className="muted">Демонстрационные маршруты. Уже созданные запросы сохраняют свою версию.</p>{(['deadline','completion'] as const).map(kind=><div className="route-editor" key={kind}><strong>{kind==='deadline'?'Перенос срока':'Закрытие задачи'}</strong>{rules.routes[kind].map((s,i)=><label key={i}>Этап {i+1}<select disabled={!admin||busy} value={s} onChange={e=>setRules({...rules,routes:{...rules.routes,[kind]:rules.routes[kind].map((old,j)=>j===i?e.target.value:old)}} as Rules)}>{selectors.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}</div>)}<div className="settings-save">{admin?<button disabled={busy} className="button primary">Сохранить новую версию</button>:<p className="muted">Изменение настроек доступно администратору.</p>}</div></form><div><section className="panel integration-card"><h2>Подключения</h2><div><strong>Битрикс24</strong><Badge state="warning">Отключено</Badge><p>Исходные задачи импортированы из Excel. Изменения применяются к локальной копии. Реальный REST/event-адаптер не реализован.</p></div><div><strong>Telegram</strong><Badge state="warning">Личные чаты</Badge><p>Личный пилот настраивается в разделе «Рабочий бот». Подключение сотрудников и разделение их Telegram-аккаунтов ещё не настроены.</p></div><div><strong>Хранилище</strong><Badge state="completed">PostgreSQL</Badge><p>Задачи, история, версии правил и отчёты сохраняются на сервере.</p></div></section><section className="panel integration-card"><h2>О текущей версии</h2><p>Доступ к задачам и действиям проверяется сервером. Назначения руководителей пока тестовые: реальные роли и филиалы в Excel отсутствуют.</p><p>Проверки и отчёты доступны вручную и по расписанию. Расписание включает администратор в блоке выше. Праздники, отпуска и замещения ещё не учитываются.</p><p>Коды, плановые даты и сроки подзадач сверены с GAS. Исторические KPI нельзя восстановить из одного листа без истории завершений. Звонки и платные сервисы отсутствуют.</p></section></div></div>;
}
