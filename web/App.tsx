import {StaffOnboarding} from './StaffOnboarding.js';
import {BitrixArchiveStatus} from './BitrixArchiveStatus.js';
import {PilotReadiness} from './PilotReadiness.js';
import {TaskCardFields,TaskEditPanel} from './TaskCardSections.js';
import {DelegationInbox,OrgWorkspace} from './OrgWorkspace.js';
import {TaskDelegation} from './TaskDelegation.js';
import {CompanyReference} from './TaskComposeTools.js';
import {canUseOkb,Okb,WorkDesign,type ProcessDraft} from './WorkDesign.js';
import {BitrixActivity} from './BitrixActivity.js';
import {AccessDirectory,SystemHealth,moscowTimestamp} from './SystemHealth.js';
import {useRememberedFilter} from './remembered-filter.js';
import {Journal} from './Journal.js';
import {ApprovalWorkspace,DirectorBatch} from './ApprovalWorkspace.js';
import {ApprovalHierarchySettings} from './ApprovalHierarchySettings.js';
import {UndoAction} from './UndoAction.js';
import {ManagementProgress,ManagementPreference,Performance} from './Management.js';
import {formatPrice,priceBand,priceLabels,taskPrice} from '../shared/pricing.js';
import {ReminderInbox} from './ReminderInbox.js';
import {ManagerHome} from './ManagerHome.js';
import {MobileWorkspace} from './MobileWorkspace.js';
import {NotificationCenter,NotificationSettings,TelegramDeliverySettings} from './NotificationCenter.js';
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
import {BotWorkspace} from './BotWorkspace.js';
import {actionItems} from '../shared/actions.js';
import { lazy, Suspense, useEffect, useState, useRef, useSyncExternalStore, type ReactNode, type FormEvent } from 'react';
import { LayoutDashboard, ListTodo, GitPullRequest, ShieldCheck, BarChart3, Users, History, Settings2, Search, ArrowUpRight, ArrowRight, ChevronRight, Check, Clock3, X, Bell, Download, RefreshCw, Filter, MessageSquare, ChevronDown, PanelLeftClose, CircleHelp, CheckCheck, AlertCircle, Send, CalendarDays, ExternalLink, Copy, Pencil, Bookmark } from 'lucide-react';
import { businessDay, taskQueue, elapsedToday, plannedToday } from '../shared/queues.js';
import {hasCompanyOverview,defaultReportView,type ReportView} from '../shared/report-parameters.js';
import {summarize} from '../shared/analytics.js';
import {TeamTasks} from './TeamTasks.js';
import { Dashboard } from './Dashboard.js';
import {Appearance} from './Appearance.js';
import { ReviewActions,TaskEditor } from './TaskWorkflow.js';
import { History as TaskHistory } from './History.js';
import { Operations } from './Operations.js';
import { api, viewAs } from './api.js';
import type { Bootstrap, Task, User, TaskDetail, Rules, Approval, Event } from '../shared/types.js';
const Reports=lazy(()=>import('./Reports.js').then(module=>({default:module.Reports})));
const nav=[{id:'overview',label:'Главная',icon:LayoutDashboard},{id:'actions',label:'Нужно действие',icon:Bell},{id:'bot',label:'Рабочий бот',icon:MessageSquare},{id:'tasks',label:'Задачи',icon:ListTodo},{id:'approvals',label:'Согласования',icon:GitPullRequest},{id:'checks',label:'Качество задач',icon:ShieldCheck},{id:'reports',label:'Отчёты',icon:BarChart3},{id:'people',label:'Сотрудники',icon:Users},{id:'journal',label:'История действий',icon:History},{id:'delegations',label:'Мои поручения',icon:ListTodo},{id:'org',label:'Оргструктура',icon:Users},{id:'processes',label:'Бизнес-процессы',icon:GitPullRequest},{id:'okb',label:'ОКБ',icon:Users},{id:'settings',label:'Настройки',icon:Settings2}] as const;
const viewingEmployee=viewAs!==null;
const phone=window.matchMedia('(max-width: 760px)');
function watchPhone(change:()=>void){phone.addEventListener('change',change);return()=>phone.removeEventListener('change',change);}
const previewSections=new Set<Page>(['overview','actions','tasks','approvals','checks','reports','people','journal','delegations','notifications']);
const date=(v:string|null,full=false)=>v?new Date(v).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',...(full?{hour:'2-digit',minute:'2-digit'}:{})}):'Без срока';
const day=(v:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(v));
const initials=(name:string)=>name.split(' ').slice(0,2).map(s=>s[0]).join('');
const roles:Record<string,string>={director:'Директор',admin:'Администратор',sales_head:'Руководитель продаж',branch_manager:'Руководитель филиала',employee:'Менеджер'};
const stateLabels:Record<string,string>={canceled:'Отменено',pending:'На согласовании',approved:'Согласовано',rejected:'Отказано',stale:'Требует нового запроса',active:'В работе',review:'На приёмке',completed:'Завершена',waiting:'Ждём ответа',answered:'Ответ получен',escalated:'Эскалация',resolved:'Устранено'};
const managed=(u:User)=>u.role!=='employee';
const allowedRequest=(u:User,t:Task)=>u.id===t.assignee_id||u.id===t.creator_id||managed(u)&&(u.role!=='branch_manager'||(u.company_branch_access||u.branch_id===t.branch_id));
function Empty({children}: {children:ReactNode}){return <div className="empty"><CheckCheck size={28}/><h3>Здесь пока нет записей</h3><p>{children}</p></div>;}
function Badge({state,children}: {state:string;children?:ReactNode}) {return <span className={`badge ${state}`}><i/>{children||stateLabels[state]||state}</span>;}
function Avatar({user,small=false}: {user?:User;small?:boolean}){return <span className={`avatar ${small?'small':''} color-${(user?.id.length||0)%4}`}>{initials(user?.name||'—')}</span>;}
function Tabs({items,value,onChange}: {items:{id:string;label:string;count?:number}[];value:string;onChange:(id:string)=>void}) {return <div className="tabs" role="tablist">{items.map(item=><button role="tab" aria-selected={value===item.id} key={item.id} className={value===item.id?'selected':''} onClick={()=>onChange(item.id)}>{item.label}{item.count!==undefined&&<span>{item.count}</span>}</button>)}</div>;}
function Timeline({events,users}: {events:Event[];users:User[]}){return <div className="timeline">{events.map(e=><div className="timeline-row" key={e.id}><span className={`event-dot ${e.kind.includes('reject')?'red':''}`}/><div><strong>{e.message}</strong><p>{users.find(u=>u.id===e.actor_id)?.name||'Система'} · {date(e.created_at,true)}</p>{typeof e.data.comment==='string'&&e.data.comment&&<blockquote>{e.data.comment}</blockquote>}{e.kind==='deadline_changed'&&<p className="change-line">{date((e.data.before as Task)?.deadline,true)} <ArrowRight size={13}/> {date((e.data.after as Task)?.deadline,true)}</p>}</div></div>)}</div>;}
export function App(){
 const compact=useSyncExternalStore(watchPhone,()=>phone.matches);
 const [users,setUsers]=useState<User[]>([]),[data,setData]=useState<Bootstrap|null>(null),[requestedPage,setPage]=useState<Page>('overview'),[error,setError]=useState(''),[toast,setToast]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [filter,setFilter]=useRememberedFilter(data?.user.id,'App.filter','all'),[search,setSearch]=useState(''),[branch,setBranch]=useRememberedFilter(data?.user.id,'App.branch','all'),[owner,setOwner]=useRememberedFilter(data?.user.id,'App.owner','all'),[workDay,setWorkDay]=useState<string|null>(null),[priceFilter,setPriceFilter]=useRememberedFilter(data?.user.id,'App.priceFilter','all'),[linkedIds,setLinkedIds]=useState<string[]|null>(null),[reportOpen,setReportOpen]=useState<string|null>(null),[reportPdf,setReportPdf]=useState(false),[sort,setSort]=useRememberedFilter(data?.user.id,'App.sort','deadline'),[fromDate,setFromDate]=useRememberedFilter(data?.user.id,'App.fromDate',''),[toDate,setToDate]=useRememberedFilter(data?.user.id,'App.toDate',''),[tablePage,setTablePage]=useState(0),[approvalTab,setApprovalTab]=useState('pending');
 const [taskView,setTaskView]=useState<ReportView|null>(null),[reportView,setReportView]=useState<ReportView|null>(null);
 const page=data&&!canOpenWorkspacePage(data.user,requestedPage)&&!(requestedPage==='reports'&&reportOpen)?'overview':requestedPage;
 const [selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<TaskDetail|null>(null),[drawerTab,setDrawerTab]=useState('info'),[requestType,setRequestType]=useState<'deadline'|'completion'|null>(null),[mobileMenu,setMobileMenu]=useState(false);
 const [demo,setDemo]=useState(true),[processDraft,setProcessDraft]=useState<ProcessDraft|null>(null);
 const [editor,setEditor]=useState<{task:Task|null;copyOf?:Task;companyId?:string}|null>(null);
 const [okbCompany,setOkbCompany]=useState<string|null>(null);
 const refreshGeneration=useRef(0),detailGeneration=useRef(0),toastTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const lastNoticeCheck=useRef<{userId:string;at:string}|null>(null);
 const showToast=(message:string)=>{setToast(message);if(toastTimer.current)clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),5000);};
 async function refresh(){const generation=++refreshGeneration.current;const d=await api<Bootstrap>('/bootstrap');if(generation===refreshGeneration.current)setData(d);return d;}
 async function refreshDetail(id:string){
  const generation=detailGeneration.current;
  const next=await api<TaskDetail>('/tasks/'+encodeURIComponent(id));
  if(generation===detailGeneration.current)setDetail(next);
 }
 async function openTask(id:string,tab='info'){const generation=++detailGeneration.current;setSelected(id);setDrawerTab(tab);setDetail(null);setError('');window.history.replaceState(null,'',`#task=${encodeURIComponent(id)}`);try{const result=await api<TaskDetail>(`/tasks/${id}`);if(generation===detailGeneration.current)setDetail(result);}catch(e){if(generation===detailGeneration.current)setError((e as Error).message);}}
 function closeTask(){detailGeneration.current++;setSelected(null);setDetail(null);setRequestType(null);window.history.replaceState(null,'',window.location.pathname+window.location.search);}
 async function login(id:string){refreshGeneration.current++;setBusy(true);setError('');try{await api('/demo/login','POST',{userId:id});closeTask();setEditor(null);setTablePage(0);setSearch('');setLinkedIds(null);setWorkDay(null);setProcessDraft(null);setOkbCompany(null);await refresh();showToast('Пользователь переключён. Права доступа применены.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function act(path:string,body?:unknown,method='POST',message='Изменения сохранены',onSaved?:(id:string)=>void){
  if(viewingEmployee)return false;
  const generation=detailGeneration.current;
  setBusy(true);setError('');
  try{
   const result=await api<{id?:string;state?:string;count?:number}>(path,method,body);
   await refresh().catch(e=>setError(e.message));
   if(result?.id&&onSaved)onSaved(result.id);
   else if(selected&&generation===detailGeneration.current)await refreshDetail(selected).catch(e=>setError(e.message));
   showToast(result?.state==='stale'?'Задача изменилась. Создайте новый запрос.':typeof result?.count==='number'?`Обработано уведомлений: ${result.count}`:message);
   return true;
  }catch(e){setError((e as Error).message);return false;}
  finally{setBusy(false);}
 }
 useEffect(()=>{let live=true;(async()=>{try{if(viewingEmployee){setDemo(false);const d=await api<Bootstrap>('/bootstrap');if(live){setData(d);const task=new URLSearchParams(location.hash.slice(1)).get('task');if(task)void openTask(task);}return;}const mode=await api<{demo:boolean}>('/auth/mode');if(!live)return;setDemo(mode.demo);if(mode.demo){const list=await api<User[]>('/demo/users');if(!live)return;setUsers(list);try{const d=await api<Bootstrap>('/bootstrap');if(live)setData(d);}catch{await api('/demo/login','POST',{userId:'director'});const d=await api<Bootstrap>('/bootstrap');if(live)setData(d);}}else{try{await api('/auth/me');const d=await api<Bootstrap>('/bootstrap');if(live)setData(d);}catch{if(live)setData(null);}}const task=new URLSearchParams(window.location.hash.slice(1)).get('task');if(task&&live&&window.location.hash)void openTask(task);}catch(e){if(live)setError((e as Error).message);}finally{if(live)setLoading(false);}})();return()=>{live=false;};},[]);
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
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(editor)setEditor(null);else if(requestType)setRequestType(null);else closeTask();}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[requestType,editor]);
 function go(next:Page,taskFilter?:string,view?:ReportView){if((viewingEmployee&&!previewSections.has(next))||(data&&!canOpenWorkspacePage(data.user,next)))return;if(next!=='okb')setOkbCompany(null);if(next!=='processes')setProcessDraft(null);setTablePage(0);setPage(next);setMobileMenu(false);if(next==='tasks'&&(view||!taskFilter)){setTaskView(view??null);if(!taskFilter){setOwner('all');setFilter('all');setSearch('');setFromDate('');setToDate('');setBranch('all');setPriceFilter('all');setLinkedIds(null);setWorkDay(null);}}if(next==='reports'){setReportOpen(null);setReportPdf(false);setReportView(view??null);}if(next!=='tasks'){setLinkedIds(null);setWorkDay(null);}if(taskFilter){setSearch('');setFromDate('');setToDate('');setWorkDay(null);setLinkedIds(null);setPriceFilter('all');setFilter(taskFilter);setOwner('all');setBranch('all');}}
 const userById=(id:string)=>data?.users.find(u=>u.id===id);
 useEffect(()=>{if(!data||busy||editor||requestType)return;const timer=setInterval(()=>{if(document.visibilityState==='visible'){void refresh().catch(()=>{});if(selected)void refreshDetail(selected).catch(()=>{});}},60000);return()=>clearInterval(timer);},[Boolean(data),busy,editor,requestType,selected]);
 useEffect(()=>{if(data&&!data.rules.showPlanning&&filter==='planned_today')setFilter('all');},[data?.rules.showPlanning,filter]);
 const appliedLink=useRef('');
 useEffect(()=>{if(!data)return;const marker=data.user.id+':'+location.search;if(appliedLink.current===marker)return;appliedLink.current=marker;const q=new URLSearchParams(location.search);if(q.get('view')==='registrations'&&data.user.role==='admin'){setPage('settings');return;}if(q.get('view')==='approvals'&&canOpenWorkspacePage(data.user,'approvals')){setPage('approvals');return;}if(q.get('view')==='notifications'){setPage('notifications');return;}if(q.get('view')==='reports'){if(!q.get('report')&&!canOpenWorkspacePage(data.user,'reports'))return;setPage('reports');setReportOpen(q.get('report'));setReportPdf(q.get('format')==='pdf');return;}if(q.get('view')!=='tasks')return;setPage('tasks');setTaskView(q.get('scope')==='team'?'team':q.get('scope')==='mine'||q.get('owner')===data.user.id?'mine':hasCompanyOverview(data.user)?'company':q.get('owner')&&managed(data.user)?'team':null);setTablePage(0);setSearch('');setBranch('all');setFromDate('');setToDate('');setLinkedIds(null);setFilter(q.get('filter')||'all');setOwner(q.get('owner')||'all');setWorkDay(q.get('day'));if(['deadline','title','transfers','price_desc','work_priority'].includes(q.get('sort')||''))setSort(q.get('sort')!);setPriceFilter(q.get('price')||'all');if(q.get('task'))void openTask(q.get('task')!);const reportId=q.get('report');if(reportId)void api<import('../shared/types.js').Report>('/reports/'+encodeURIComponent(reportId)).then(r=>{const subset=q.get('subset'),s=r.summary,at=new Date(s?.to||r.created_at);const ids=subset==='expected'?s?.front.expectedIds:subset==='front_closed'?s?.front.closedIds:subset==='processed'?s?.activity.processedIds:subset==='closed'?s?.activity.closedIds:subset==='remaining'?s?.front.remainingIds:subset==='tomorrow'?s?.tomorrow.ids:subset==='late'?s?.lateIds:r.rows.filter(t=>!subset||subset==='all'||taskQueue(t,at)===subset).map(t=>t.id);setLinkedIds(ids||[]);setFilter('all');}).catch(e=>setError(e.message));},[data?.user.id]);
 const now=data?new Date(data.serverTime):new Date();
 const overdue=(t:Task)=>taskQueue(t,now)==='overdue';
 const taskState=(t:Task)=>t.status==='completed'?'completed':data?.approvals.some(a=>a.task_id===t.id&&a.state==='pending')?'pending':overdue(t)?'overdue':t.status;
 const filterTasks=(items:Task[],f=filter)=>items.filter(t=>f==='all'||f==='risk'&&t.customer_risk===true&&t.status!=='completed'||f.startsWith('day:')&&t.status==='active'&&!!t.deadline&&businessDay(t.deadline)===f.slice(4)||f==='planned_today'&&plannedToday(t,now)||f==='active'&&t.status!=='completed'||f==='overdue'&&overdue(t)||f==='today'&&taskQueue(t,now)==='today'||f==='upcoming'&&taskQueue(t,now)==='upcoming'||f==='no_deadline'&&taskQueue(t,now)==='no_deadline'||f==='completed'&&t.status==='completed'||f==='review'&&t.status==='review'||f==='waiting'&&data?.controls.some(c=>c.task_id===t.id&&['waiting','escalated'].includes(c.state))||f==='pending'&&data?.approvals.some(a=>a.task_id===t.id&&a.state==='pending'));
 function Table({tasks,compact=false}: {tasks:Task[];compact?:boolean}) {return tasks.length?<div className="table-scroll"><table><thead><tr><th>Задача</th><th>Ответственный</th><th>Цена · категория</th><th>Крайний срок</th><th>Состояние</th>{!compact&&<th>Переносы</th>}<th aria-label="Открыть"/></tr></thead><tbody>{(compact?tasks:tasks.slice(tablePage*50,tablePage*50+50)).map(t=><tr key={t.id}><td><button className="task-link" onClick={()=>void openTask(t.id)}><span className="task-id">#{t.id} <span>{t.code}</span></span><strong>{t.title}</strong></button></td><td><div className="person"><Avatar user={userById(t.assignee_id)} small/><div>{userById(t.assignee_id)?.name}<small>{t.branch_id}</small></div></div></td><td><strong>{formatPrice(t)}</strong><small>{priceLabels[priceBand(t)]}</small></td><td className={overdue(t)?'late-date':''}>{date(t.deadline,true)}{elapsedToday(t,now)&&<small className="red-text">Время истекло сегодня</small>}{overdue(t)&&<small>Просрочено {Math.max(1,Math.round((new Date(businessDay(now)).getTime()-new Date(businessDay(t.deadline!)).getTime())/86400000))} дн.</small>}</td><td><Badge state={taskState(t)}>{taskState(t)==='overdue'?'Просрочена':undefined}</Badge></td>{!compact&&<td className="mono">{t.transfer_count||'—'}</td>}<td><button className="icon-button row-arrow" aria-label={`Открыть задачу ${t.id}`} onClick={()=>void openTask(t.id)}><ChevronRight size={17}/></button></td></tr>)}</tbody></table></div>:<Empty>Задач с выбранными условиями нет. Попробуйте изменить фильтры.</Empty>;}
 if(loading)return <div className="boot" role="status" aria-live="polite"><CapMark loading/><h2>РУСПЭТ</h2><p>Загружаем рабочее пространство…</p></div>;
 if(!data&&viewingEmployee)return <div className="boot"><h2>Просмотр недоступен</h2><p role="alert">{error}</p><a className="button secondary" href="/">Перейти в панель</a></div>;
 if(!data&&!demo)return <Login onLogin={setData}/>;
 if(!data)return <div className="boot"><h2>Не удалось открыть систему</h2><p>{error}</p><button onClick={()=>location.reload()}>Попробовать снова</button></div>;
 const requestedView=new URLSearchParams(location.search).get('view');
 const mobilePath=location.pathname==='/mobile'||location.pathname==='/mobile/';
 if(!viewingEmployee&&(mobilePath||compact&&data.user.role==='employee'&&location.pathname==='/'&&!location.hash&&(!requestedView||requestedView==='notifications'))){
  return <MobileWorkspace key={data.user.id} user={data.user} refresh={refresh} unread={data.notifications.some(item=>!item.read_at)}/>;
 }
 const company=hasCompanyOverview(data.user),teamAllowed=managed(data.user);
 const currentScope=taskView==='company'&&!company?'mine':taskView==='team'&&!teamAllowed?'mine':taskView??defaultReportView(data.user);
 const members=new Set(data.teamIds);
 const scopedTasks=linkedIds?data.tasks.filter(t=>linkedIds.includes(t.id)):currentScope==='mine'?data.tasks.filter(t=>t.assignee_id===data.user.id):
  currentScope==='team'?data.tasks.filter(t=>members.has(t.assignee_id)):data.tasks;
 const scopedMetrics=summarize(scopedTasks,now);
 const teamDirectory=currentScope==='team'&&!linkedIds&&owner==='all'&&filter==='all'&&!workDay;
 const pendingTasks=new Set(data.approvals.filter(a=>a.state==='pending').map(a=>a.task_id));
 const visible=filterTasks(scopedTasks).filter(t=>(priceFilter==='all'||priceBand(t)===priceFilter)&&(branch==='all'||t.branch_id===branch)&&(currentScope==='mine'&&!linkedIds||owner==='all'||t.assignee_id===owner)&&(!fromDate||!!t.deadline&&businessDay(t.deadline)>=fromDate)&&(!toDate||!!t.deadline&&businessDay(t.deadline)<=toDate)&&`${t.title} ${t.id} ${userById(t.assignee_id)?.name}`.toLowerCase().includes(search.toLowerCase())).sort((a,b)=>sort==='price_desc'?(taskPrice(b)??-1)-(taskPrice(a)??-1):sort==='work_priority'?Number(!(a.deadline&&businessDay(a.deadline)<(workDay||businessDay(now))))-Number(!(b.deadline&&businessDay(b.deadline)<(workDay||businessDay(now))))||((taskPrice(b)??-1)-(taskPrice(a)??-1))||(a.deadline||'9999').localeCompare(b.deadline||'9999'):sort==='title'?a.title.localeCompare(b.title,'ru'):sort==='transfers'?b.transfer_count-a.transfer_count:(a.deadline||'9999').localeCompare(b.deadline||'9999'));
 const myActionCount=actionItems(data).filter(item=>item.mine).length;
 const pending=data.approvals.filter(a=>a.state==='pending'), mine=pending.filter(a=>a.route[a.current_step]?.userId===data.user.id), focus=data.tasks.filter(t=>overdue(t)).slice(0,5);
 const taskTabs=[{id:'all',label:'Все задачи',count:scopedTasks.length},{id:'today',label:'Срок сегодня',count:scopedMetrics.today},...(data.rules.showPlanning?[{id:'planned_today',label:'План на сегодня'}]:[]),{id:'overdue',label:'Просрочены ранее',count:scopedMetrics.overdue},{id:'review',label:'На приёмке',count:scopedMetrics.review},{id:'upcoming',label:'Предстоящие'},{id:'no_deadline',label:'Без срока'},{id:'pending',label:'На согласовании',count:scopedTasks.filter(task=>pendingTasks.has(task.id)).length},{id:'completed',label:'Завершены'}];
 const title=page==='notifications'?'Уведомления':nav.find(n=>n.id===page)?.label;
 return <div className="app">
  <aside className={mobileMenu?'sidebar mobile-open':'sidebar'}><a className="brand" href="#" onClick={e=>{e.preventDefault();go('overview');}}><CapMark/><span>РУСПЭТ<small>Контроль и согласование</small></span></a><div className="workspace"><span className="workspace-mark"><CapMark/></span><div>Рабочее пространство<small>{data.managerPreview?'Учебный стенд':'Данные из Excel'}</small></div><ChevronDown size={13}/></div><p className="nav-label">УПРАВЛЕНИЕ</p><nav>{nav.filter(n=>(!viewingEmployee||previewSections.has(n.id))&&canOpenWorkspacePage(data.user,n.id)).map(({id,label,icon:Icon},i)=><button key={id} className={`${page===id?'active':''} ${i===6?'nav-divider':''}`} onClick={()=>go(id)}><Icon size={18}/><span>{label}</span>{id==='actions'&&myActionCount>0&&<b>{myActionCount}</b>}{id==='approvals'&&pending.length>0&&<b>{pending.length}</b>}</button>)}{!viewingEmployee&&data.user.root_access&&<a className="owner-planner-link" href="/time"><CalendarDays size={18}/> Личный планер</a>}{!viewingEmployee&&<a className="owner-planner-link" href="/mobile"><MessageSquare size={18}/> Мобильная версия</a>}</nav><div className="sidebar-bottom"><div className="source-status"><span className="status-dot"/><div>Рабочее пространство</div></div><div className="sidebar-note">{data.managerPreview?'Вымышленные задачи и сотрудники.':'Задачи из «руспет.xlsx».'}<br/>ПЭТ-преформы · крышки · упаковка.</div>{!viewingEmployee&&<button className="help-link" onClick={()=>go('settings')}><CircleHelp size={16}/> Настройки <ArrowUpRight size={14}/></button>}</div></aside>
  <div className="workspace-main"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-toggle" aria-label="Меню" onClick={()=>setMobileMenu(!mobileMenu)}><PanelLeftClose size={19}/></button><span>Рабочее пространство</span><ChevronRight size={14}/><strong>{title}</strong></div><div className="topbar-right"><ThemeToggle/>{demo&&<span className="demo-label">ДЕМО</span>}<button className="icon-button notification-button" aria-label="Уведомления" onClick={()=>go('notifications')}><Bell size={19}/>{data.notifications.some(item=>!item.read_at)&&<i/>}</button><div className="user-switch"><Avatar user={data.user}/>{demo?<div><label htmlFor="persona">Демонстрационная роль</label><select id="persona" value={data.user.id} disabled={busy} onChange={e=>void login(e.target.value)}>{users.map(u=><option key={u.id} value={u.id}>{u.name} · {roles[u.role]}</option>)}</select></div>:<div><strong>{data.user.name}</strong><small>{data.user.root_access?'Владелец · root':roles[data.user.role]}</small></div>}{!demo&&!viewingEmployee&&<button className="text-button" onClick={async()=>{await api('/auth/logout','POST',{});setSearch('');setLinkedIds(null);setWorkDay(null);closeTask();setProcessDraft(null);setOkbCompany(null);setPage('overview');setData(null)}}>Выйти</button>}</div></div></header>
  <main>{viewingEmployee&&<div className="source-banner view-as-banner"><div><strong>Просмотр от имени {data.user.name}</strong><p>Данные и задачи доступны по роли сотрудника. Режим только для чтения.</p></div><a className="button secondary" href="/">В админскую панель</a></div>}<div className="page-heading"><div><div className="eyebrow">{page==='overview'?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',year:'numeric',weekday:'long'}).format(now):'РУСПЭТ / КОНТРОЛЬ ЗАДАЧ'}</div><h1>{page==='overview'?(company?'Обзор компании':'Главная'):title}</h1><p>{({org:'Руководители команд и временные замещения.',delegations:'Выданные поручения, сроки и приёмка.',processes:'Условия создания задач и расписания повторений.',okb:'Компании, контакты и состояние работы с ними.',actions:'Кто должен ответить, принять результат или исправить замечания.',bot:'Личные чаты и действия по задачам.',overview:'Задачи, решения и отклонения — в одном рабочем пространстве.',tasks:'Сроки, исполнители и полная история каждой задачи.',approvals:'Примите решение с учётом причины, плана и предыдущих изменений.',checks:'Формальные проверки качества постановки и исполнения задач.',reports:'Сохранённые снимки состояния. Часовой пояс — Москва.',people:'Нагрузка и состояние задач в вашей области доступа.',journal:'История действий, ответов и решений без перезаписи.',settings:'Правила контроля, маршруты и состояние подключений.',notifications:'Уведомления по задачам, проверкам и решениям.'} as Record<Page,string>)[page]}</p></div><div className="heading-actions"><button className="button secondary square" aria-label="Обновить данные" disabled={busy} onClick={()=>{setBusy(true);refresh().then(()=>showToast('Данные обновлены')).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}><RefreshCw size={16}/></button>{!viewingEmployee&&page==='tasks'&&<button className="button primary" disabled={busy} onClick={()=>setEditor({task:null})}>Создать задачу</button>}{!viewingEmployee&&managed(data.user)&&page!=='reports'&&<button className="button primary" disabled={busy} onClick={()=>void act('/checks/run',undefined,'POST','Проверка завершена. Нарушения и запросы обновлены.')} ><ShieldCheck size={17}/> Запустить проверку</button>}</div></div>
  {error&&<div className="alert error" role="alert"><AlertCircle size={18}/><span>{error}</span><button className="icon-button" aria-label="Скрыть ошибку" onClick={()=>setError('')}><X size={16}/></button></div>}
  {!viewingEmployee&&!selected&&<UndoAction refreshKey={data.user.id+data.serverTime} busy={busy} act={act}/>}
  {page==='actions'&&<ActionWorkspace data={data} open={openTask}/>}
  {page==='bot'&&<BotWorkspace key={data.user.id} user={data.user} users={data.users} refresh={refresh}/>}
  {page==='overview'&&<ManagerHome data={data} open={openTask} actions={()=>go('actions')} tasks={filter=>go('tasks',filter,'mine')}
   team={teamAllowed?()=>go('tasks','all','team'):undefined} reports={teamAllowed?()=>go('reports',undefined,'mine'):undefined}/>}
  {page==='overview'&&company&&<section aria-label="Аналитика компании"><div className="panel-heading company-overview-heading"><div><h2>Показатели компании</h2><p>Сроки, нагрузка и просрочки по исполнителям.</p></div><button className="button secondary" onClick={()=>go('reports',undefined,'company')}>Отчёты компании</button></div><Dashboard key={data.user.id} data={data} now={now} go={(f,id,price)=>{go('tasks',f,'company');setOwner(id||'all');if(price)setPriceFilter(price);}} open={id=>void openTask(id)}/></section>}
  {page==='overview'&&company&&<ManagementProgress readOnly={viewingEmployee} data={data} details={()=>go('people')}/>}
  {page==='overview'&&company&&data.source&&<div className="source-banner">Источник: {data.source.file_name} · {data.source.sheet_name} · {data.source.row_count} задач в выгрузке. {data.selection&&<>В рабочей выборке: {data.selection.included}. Исключено: {data.selection.checklist} с чек-листами и {data.selection.unfinishedAnalysis} на анализ невыполненных задач. </>}<details><summary>Свежесть данных</summary><dl className="freshness"><div><dt>Дата исходной выгрузки</dt><dd>В файле не указана</dd></div><div><dt>Импорт в систему</dt><dd>{moscowTimestamp(data.source.imported_at)}</dd></div><div><dt>Последнее изменение в доступных задачах</dt><dd>{moscowTimestamp(data.lastTaskChange)}</dd></div><div><dt>Расчёт показателей</dt><dd>{moscowTimestamp(data.serverTime)}</dd></div></dl></details></div>}
  {page==='tasks'&&<>{teamAllowed&&<div className="tabs" aria-label="Область задач">
   <button className={!linkedIds&&currentScope==='mine'?'selected':''} onClick={()=>go('tasks','all','mine')}>Мои задачи</button>
   <button className={!linkedIds&&currentScope==='team'?'selected':''} onClick={()=>go('tasks','all','team')}>Задачи команды</button>
   {company&&<button className={!linkedIds&&currentScope==='company'?'selected':''} onClick={()=>go('tasks','all','company')}>Вся компания</button>}
  </div>}{teamDirectory?<TeamTasks tasks={scopedTasks} users={data.users} now={now} onSelect={(id,f)=>{go('tasks',f,'team');setOwner(id);}}/>:<>{linkedIds&&<div className="source-banner">Выборка из сохранённого отчёта · показано текущее состояние доступных задач.<button className="text-button" onClick={()=>go('tasks','all')}>Сбросить выборку</button></div>}<Tabs value={filter} onChange={setFilter} items={taskTabs}/>{!taskTabs.some(t=>t.id===filter)&&<div className="active-filter">Выборка: {({active:'Активные',review:'Ожидают приёмки',waiting:'Ожидаем ответ исполнителя'} as Record<string,string>)[filter]||(filter.startsWith('day:')?'Крайний срок '+filter.slice(4):filter==='risk'?'Риск потери клиента':filter)}<button className="text-button" onClick={()=>setFilter('all')}>Сбросить</button></div>}<section className="panel task-panel"><div className="filters"><label className="search-input"><Search size={17}/><input aria-label="Поиск задач" placeholder="Название, номер или сотрудник" value={search} onChange={e=>setSearch(e.target.value)}/></label><select aria-label="Филиал" value={branch} onChange={e=>setBranch(e.target.value)}><option value="all">Все филиалы</option>{[...new Set(data.tasks.map(t=>t.branch_id))].map(b=><option key={b}>{b}</option>)}</select><select aria-label="Исполнитель" disabled={currentScope==='mine'&&!linkedIds} value={currentScope==='mine'&&!linkedIds?'all':owner} onChange={e=>setOwner(e.target.value)}><option value="all">{currentScope==='mine'&&!linkedIds?'Я исполнитель':'Все исполнители'}</option>{data.users.filter(u=>scopedTasks.some(t=>t.assignee_id===u.id)).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select><label className="date-filter">Крайний срок от<input aria-label="Крайний срок от" type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)}/></label><label className="date-filter">до<input aria-label="Крайний срок до" type="date" min={fromDate} value={toDate} onChange={e=>setToDate(e.target.value)}/></label><select aria-label="Категория цены" value={priceFilter} onChange={e=>{setPriceFilter(e.target.value);setTablePage(0)}}><option value="all">Любая цена</option>{Object.entries(priceLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><select aria-label="Сортировка" value={sort} onChange={e=>setSort(e.target.value)}><option value="deadline">По сроку</option><option value="price_desc">По цене: сначала дороже</option><option value="work_priority">Порядок работы: просрочки и цена</option><option value="title">По названию</option><option value="transfers">По переносам</option></select></div>{(search||currentScope!=='mine'&&owner!=='all'||branch!=='all'||fromDate||toDate||priceFilter!=='all'||workDay)&&<div className="active-filter"><span>{[search&&'Поиск: '+search,currentScope!=='mine'&&owner!=='all'&&userById(owner)?.name,branch!=='all'&&branch,fromDate&&'С '+fromDate,toDate&&'По '+toDate,priceFilter!=='all'&&priceLabels[priceFilter as keyof typeof priceLabels],workDay&&'На '+workDay].filter(Boolean).join(' · ')}</span><button className="text-button" onClick={()=>go('tasks','all')}>Сбросить фильтры</button></div>}<Table tasks={visible}/>{visible.length>50&&<div className="pagination"><button className="button secondary" disabled={tablePage===0} onClick={()=>setTablePage(p=>p-1)}>Назад</button><span>{tablePage+1} / {Math.ceil(visible.length/50)}</span><button className="button secondary" disabled={(tablePage+1)*50>=visible.length} onClick={()=>setTablePage(p=>p+1)}>Далее</button></div>}<div className="panel-footer"><span>Найдено {visible.length} из {scopedTasks.length}</span><span>Нажмите на задачу, чтобы открыть карточку</span></div></section></>}</>}
  {page==='approvals'&&data.user.role==='admin'&&!viewingEmployee&&<DirectorBatch stamp={data.serverTime}/>}
  {page==='approvals'&&<ApprovalWorkspace readOnly={viewingEmployee} data={data} render={a=><ApprovalCard a={a} data={data} busy={busy} act={act} openTask={openTask}/>}/>}
  {page==='checks'&&<QualityWorkspace key={data.user.id} data={data} open={(id,tab)=>void openTask(id,tab)} settings={viewingEmployee?undefined:()=>go('settings')}/>}
  {page==='reports'&&<Suspense fallback={<p className="panel section-loading" role="status">Загружаем отчёты…</p>}><Reports key={data.user.id+':'+(reportView??'default')} initialView={reportView??undefined} initialReport={reportOpen} downloadPdf={reportPdf} readOnly={viewingEmployee} data={data} refresh={refresh}/></Suspense>}
  {page==='people'&&managed(data.user)&&<Performance data={data} open={openTask}/>}
  {page==='journal'&&<Journal data={data} open={openTask}/>}
  {page==='notifications'&&<ReminderInbox readOnly={viewingEmployee} key={data.user.id} userId={data.user.id}/>}
  {page==='notifications'&&<NotificationCenter key={data.user.id} items={data.notifications} readOnly={viewingEmployee} open={openTask} refresh={refresh}/>}
  {page==='okb'&&canUseOkb(data.user)&&<Okb key={data.user.id} initialId={okbCompany} users={data.users} openTask={id=>{setOkbCompany(null);void openTask(id);}} createTask={companyId=>{setOkbCompany(null);setEditor({task:null,companyId});}}/>}
  {page==='org'&&['admin','director'].includes(data.user.role)&&<OrgWorkspace roles={roles}/>}
  {page==='delegations'&&managed(data.user)&&<DelegationInbox open={openTask}/>}
  {page==='processes'&&<WorkDesign key={data.user.id} user={data.user} users={data.users} draft={processDraft} open={openTask}/>}
  {page==='settings'&&<SettingsSections key={data.user.id} userId={data.user.id} initial={data.user.role==='admin'?'staff':'notices'} initialSelection={requestedView==='registrations'?'staff':undefined} items={[
   ...(data.user.role==='admin'?[{id:'staff',label:'Сотрудники',content:<><StaffOnboarding roles={roles}/><AccessDirectory roles={roles} currentUserId={data.user.id}/></>}]:[]),
   ...(managed(data.user)?[{id:'rules',label:'Правила и согласования',content:<>{data.user.role==='admin'&&<ApprovalHierarchySettings users={data.users}/>}<Settings key={data.rulesVersion} data={data} busy={busy} act={act}/></>}]:[]),
   {id:'notices',label:'Уведомления',content:<><NotificationSettings userId={data.user.id}/>{data.user.role==='admin'&&<TelegramDeliverySettings/>}{managed(data.user)&&<ManagementPreference/>}</>},
   {id:'appearance',label:'Оформление',content:<Appearance/>},
   ...(data.user.role==='admin'?[
    {id:'automation',label:'Автоматизация',content:<Operations showPlanning={!!data.rules.showPlanning} onChange={refresh}/>},
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
         {detail.editAccess.request?.state==='pending'?'Запрос отправлен':'Запросить редактирование'}
        </button>}
       {detail.approvalWatch?.canChange&&detail.task.status!=='completed'&&<button type="button" className="button secondary" aria-pressed={detail.approvalWatch.manual||detail.approvalWatch.byCode}
        disabled={busy||detail.approvalWatch.byCode} onClick={()=>void act('/tasks/'+encodeURIComponent(detail.task.id)+'/approval-watch',{enabled:!detail.approvalWatch?.manual},'PUT')}>
        <Bookmark size={15}/>{detail.approvalWatch.byCode?'Контроль по коду В':detail.approvalWatch.manual?'Снять с контроля':'Взять на контроль'}
       </button>}
       <button type="button" className="button secondary" disabled={busy} onClick={()=>setEditor({task:null,copyOf:detail.task})}><Copy size={15}/>Создать копию</button>
      </>}
      <button type="button" className="icon-button" aria-label="Скопировать ссылку" onClick={()=>void navigator.clipboard.writeText(location.href).then(()=>showToast('Ссылка скопирована')).catch(()=>setError('Не удалось скопировать ссылку. Скопируйте адрес страницы.'))}><ExternalLink size={17}/></button>
      <button type="button" autoFocus className="icon-button" aria-label="Закрыть карточку" onClick={closeTask}><X size={21}/></button>
     </div>
    </div>
    {detail?<><div className="drawer-heading">
     <Badge state={taskState(detail.task)}>{taskState(detail.task)==='overdue'?'Просрочена':undefined}</Badge>
     <h2>{detail.task.title}</h2>
     <p>{[detail.task.branch_id,detail.task.code,'Версия '+detail.task.version].filter(Boolean).join(' · ')}</p>
    </div>
    <Tabs value={drawerTab} onChange={setDrawerTab} items={[
     {id:'info',label:'Обзор'},{id:'result',label:'Результат',count:detail.submissions.length||undefined},
     {id:'fields',label:'Поля'},{id:'discussion',label:'Обсуждение',count:detail.comments.length||undefined},
     {id:'approvals',label:'Согласования',count:detail.approvals.length+(detail.editAccess.request?.state==='pending'?1:0)||undefined},
     {id:'links',label:'Связи и напоминания'},{id:'history',label:'История'}
    ]}/>
    <div className="drawer-body" key={drawerTab} role="tabpanel">
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
      <section className="task-card-section"><h3>Ответственные и срок</h3>
       <div className="task-facts">
        <div><span>Исполнитель</span><div className="person"><Avatar small user={userById(detail.task.assignee_id)}/><strong>{userById(detail.task.assignee_id)?.name}</strong></div></div>
        <div><span>Постановщик</span><strong>{userById(detail.task.creator_id)?.name}</strong></div>
        <div><span>Крайний срок</span><strong className={overdue(detail.task)?'red-text':''}>{date(detail.task.deadline,true)}{detail.task.deadline?' МСК':''}</strong></div>
        <div><span>Цена задачи</span><strong>{formatPrice(detail.task)}</strong><small>{priceLabels[priceBand(detail.task)]}</small></div>
       </div>
       <div className="task-card-buttons">
        {detail.approvals.some(a=>a.state==='pending')?<button type="button" className="button secondary" onClick={()=>setDrawerTab('approvals')}>Открыть согласование</button>:
         !viewingEmployee&&detail.task.status!=='completed'&&allowedRequest(data.user,detail.task)&&<button type="button" disabled={busy} className="button secondary" onClick={()=>setRequestType('deadline')}><CalendarDays size={15}/>Предложить новый срок</button>}
        {detail.task.status==='review'&&<button type="button" className="button primary" onClick={()=>setDrawerTab('result')}>К приёмке</button>}
        {!viewingEmployee&&detail.task.status==='active'&&allowedRequest(data.user,detail.task)&&<button type="button" className="button secondary" onClick={()=>setDrawerTab('result')}>Сдать результат</button>}
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
    {drawerTab==='fields'&&<TaskCardFields task={detail.task} showPlanning={!!data.rules.showPlanning} date={date}/>}
    {drawerTab==='links'&&<section className="task-card-section">
     {!viewingEmployee&&detail.task.company_id&&canUseOkb(data.user)&&<CompanyReference key={detail.task.company_id} id={detail.task.company_id} open={id=>{closeTask();go('okb');setOkbCompany(id);}}/>}
     <TaskDelegation readOnly={viewingEmployee} key={detail.task.id} task={detail.task} user={data.user} users={data.users} open={openTask}
      onCreated={()=>{void refreshDetail(detail.task.id).catch(e=>setError(e.message));void refresh().catch(()=>{});}}/>
     <TaskReminders readOnly={viewingEmployee} key={detail.task.id+data.user.id} task={detail.task} user={data.user} users={data.users}/>
    </section>}
    {drawerTab==='result'&&<>
     {detail.approvals.some(a=>a.type==='completion'&&a.state==='pending')&&<div className="task-card-buttons">
      <button type="button" className="button primary" onClick={()=>setDrawerTab('approvals')}>Открыть приёмку</button>
     </div>}
     {!viewingEmployee&&managed(data.user)&&data.user.id!==detail.task.assignee_id&&<p className="manager-action-note">Действие за исполнителя будет записано от вашего имени.</p>}
     {!viewingEmployee&&<ReviewActions key={detail.task.id+detail.task.version} task={detail.task} user={data.user} busy={busy} pending={detail.approvals.some(a=>a.state==='pending')} act={act}/>}
     {detail.submissions.length?<section className="submission-history">{detail.submissions.map(s=><article key={s.id}>
      <strong>{s.restored_from?'Приёмка восстановлена после отмены':s.automatic?'Автоматическая сдача после приёмки поручений':'Сдача №'+s.round} · {({review:'Ожидает приёмки',returned:'Возвращена',accepted:'Принята'})[s.state]}</strong>
      <small>{userById(s.author_id)?.name} · {date(s.submitted_at,true)}</small><p>{s.result}</p>
      {s.remark&&<blockquote><strong>{userById(s.reviewer_id||'')?.name}: </strong>{s.remark}</blockquote>}
     </article>)}</section>:<p className="muted">Результат пока не сдавали.</p>}
    </>}
  {drawerTab==='discussion'&&<>{!viewingEmployee&&data.user.role==='admin'&&<BitrixActivity key={selected} id={selected} kind="comment"/>}{!viewingEmployee&&detail.controls.filter(c=>['waiting','escalated'].includes(c.state)&&(data.user.id===c.assignee_id||data.user.role==='admin')).map(c=><ExplanationForm key={c.id} min={data.rules.responseMinLength} busy={busy} submit={body=>act(`/controls/${c.id}/answer`,body)}/>)}{detail.comments.map(c=><div className="comment" key={c.id}><Avatar small user={userById(c.author_id)}/><div><strong>{userById(c.author_id)?.name}<small>{date(c.created_at,true)}</small></strong><p>{c.body}</p></div></div>)}{!detail.comments.length&&<p className="muted">Комментариев пока нет.</p>}{!viewingEmployee&&<form className="comment-form" onSubmit={async e=>{e.preventDefault();const form=e.currentTarget;const f=new FormData(form),body=String(f.get('body')),approvalId=String(f.get('approvalId')||'')||undefined;if(await act(`/tasks/${selected}/comments`,{body,approvalId}))form.reset();}}><label>К чему относится сообщение<select name="approvalId"><option value="">К задаче в целом</option>{detail.approvals.filter(a=>!a.canceled_at).map(a=><option key={a.id} value={a.id}>{a.type==='deadline'?'Перенос':'Закрытие'} от {date(a.created_at,true)}</option>)}</select></label><label>Комментарий<textarea name="body" required maxLength={4000} placeholder="Добавьте уточнение или результат работы…"/></label><button className="button primary" disabled={busy}><Send size={15}/>Отправить</button></form>}</>}
  {drawerTab==='history'&&<>{!viewingEmployee&&<UndoAction taskId={selected} refreshKey={data.user.id+data.serverTime} busy={busy} act={act}/>}<TaskHistory showPlanning={!!data.rules.showPlanning} events={detail.events} users={data.users}/>{!viewingEmployee&&data.user.role==='admin'&&<BitrixActivity key={selected} id={selected} kind="history"/>}{demo&&!viewingEmployee&&data.user.role==='admin'&&<div className="demo-action"><p>Проверка защиты от устаревшего решения</p><button className="text-button" disabled={busy} onClick={()=>void act('/tasks/'+selected+'/mock-change',{expectedVersion:detail.task.version})}>Изменить описание в mock-источнике <ArrowUpRight size={14}/></button></div>}</>}
  {drawerTab==='approvals'&&<>{!viewingEmployee&&<TaskEditPanel key={selected} task={detail.task} access={detail.editAccess} users={data.users} busy={busy} act={act}/>}<div className='task-card-approvals'>{detail.approvals.map(a=><div key={a.id}><ApprovalCard a={a} data={data} busy={busy} act={act} openTask={openTask} inDrawer/>{detail.decisions.filter(d=>d.approval_id===a.id).map(d=><div className="decision-record" key={d.id}><Check size={14}/><div>{userById(d.actor_id)?.name} · {({approve:'Согласовал',reject:'Отказал',later:'Вернётся позже',clarify:'Запросил уточнение'} as Record<string,string>)[d.decision]}<small>{d.retracted?'Отменено · ':''}{date(d.created_at,true)}{d.comment&&` · ${d.comment}`}</small></div></div>)}</div>)}{!detail.approvals.length&&<Empty>Запросить перенос крайнего срока можно в обзоре.</Empty>}</div></>}
    </div></>:<div className="empty">Загружаем карточку…{error&&<p role="alert">{error}</p>}</div>}</div></div>}
  {requestType&&detail&&<RequestModal type={requestType} task={detail.task} min={data.rules.responseMinLength} busy={busy} error={error} close={()=>setRequestType(null)} submit={async body=>{if(await act(`/tasks/${detail.task.id}/approvals`,body)){setRequestType(null);setDrawerTab('approvals');}}}/>}
  {editor&&<TaskEditor key={editor.task?.id||editor.copyOf?.id||editor.companyId||'new'} task={editor.task} copyOf={editor.copyOf} companyId={editor.companyId} canLink={canUseOkb(data.user)} availableTasks={data.tasks} showPlanning={!!data.rules.showPlanning} users={data.users} user={data.user} busy={busy} saveError={error} save={(path,body,method,message)=>act(path,body,method,message,editor.copyOf?id=>void openTask(id):undefined)} close={()=>setEditor(null)} onConditional={canUseOkb(data.user)?draft=>{setProcessDraft(draft);setEditor(null);go('processes');}:undefined}/>}
  {toast&&<div className="toast" role="status"><CheckCheck size={18}/>{toast}</div>}
 </div>;
}
type Act=(path:string,body?:unknown,method?:string,message?:string)=>Promise<boolean>;
function ApprovalCard({a,data,busy,act,openTask,inDrawer=false}: {a:Approval;data:Bootstrap;busy:boolean;act:Act;openTask:(id:string,tab?:string)=>Promise<void>;inDrawer?:boolean}) {
 const [comment,setComment]=useState(''),[thread,setThread]=useState('');
 const [answer,setAnswer]=useState('');
 const task=data.tasks.find(t=>t.id===a.task_id);
 const actor=data.users.find(u=>u.id===a.route[a.current_step]?.userId);
 const waiting=!!a.clarification_requested_at&&!a.clarification_answered_at;
 const resultReview=a.type==='completion'&&task?.status==='review';
 const canDecide=a.state==='pending'&&actor?.id===data.user.id&&!waiting;
 const canAnswer=a.state==='pending'&&waiting&&a.requester_id===data.user.id;
 return <section className={`panel approval-card ${inDrawer?'in-drawer':''}`}>
  <div className="approval-header"><div><span className="eyebrow">{a.type==='deadline'?'ПЕРЕНОС КРАЙНЕГО СРОКА':'ЗАКРЫТИЕ ЗАДАЧИ'} · #{a.task_id}</span>{!inDrawer&&<button className="approval-title" onClick={()=>void openTask(a.task_id,'approvals')}>{task?.title}<ArrowUpRight size={16}/></button>}</div><Badge state={a.canceled_at?'canceled':a.state}/></div>
  {a.type==='deadline'&&<div className="deadline-change"><div><span>Текущий крайний срок</span><strong>{date(task?.deadline||null,true)}</strong></div><ArrowRight size={20}/><div><span>Предложенный крайний срок</span><strong>{date(a.proposed_deadline,true)}</strong></div><small>МСК</small></div>}
  <div className="approval-context"><div><span>Причина</span><p>{a.reason}</p></div><div><span>План выполнения / результат</span><p>{a.plan}</p></div></div>
  <div className="route-stage"><strong>Этап {a.current_step+1} из {a.route.length}: {a.route[a.current_step]?.label}</strong><span>{waiting?'Ждём уточнение от автора запроса':a.state==='pending'?`Решение за: ${actor?.name||'не назначен'}`:a.canceled_at?'Отменено':stateLabels[a.state]}</span></div>
  <div className="route">{a.route.map((s,i)=><div key={i} className={i<a.current_step||a.state==='approved'?'done':i===a.current_step?'current':''}><span>{i<a.current_step||a.state==='approved'?<Check size={13}/>:i+1}</span><div><strong>{s.label}</strong><small>{data.users.find(u=>u.id===s.userId)?.name}</small></div>{i<a.route.length-1&&<ChevronRight size={14}/>}</div>)}</div>
  {a.clarification_question&&<div className="clarification-thread"><strong>Уточнение согласующего</strong><p>{a.clarification_question}</p>{a.clarification_answer&&<><strong>Ответ автора запроса</strong><p>{a.clarification_answer}</p></>}</div>}
  {a.deferred_until&&a.state==='pending'&&<p className="inline-note"><Clock3 size={14}/> Решение отложено до {date(a.deferred_until,true)} МСК</p>}
  {a.state==='stale'&&!a.canceled_at&&<p className="inline-note red-text">Задача изменилась. Нужен новый запрос с актуальными данными.</p>}
  {!viewingEmployee&&canAnswer&&<div className="decision-form"><textarea aria-label="Ответ на уточнение" placeholder="Ответьте на вопрос согласующего…" value={answer} onChange={e=>setAnswer(e.target.value)} maxLength={4000}/><button className="button primary" disabled={busy||answer.trim().length<5} onClick={()=>void act(`/approvals/${a.id}/clarification`,{answer})}>Отправить ответ</button></div>}
  {!viewingEmployee&&canDecide&&<div className="decision-form"><input aria-label="Комментарий или вопрос" placeholder={resultReview?"Комментарий при возврате обязателен":"Комментарий к решению или вопрос · минимум 5 символов"} maxLength={4000} value={comment} onChange={e=>setComment(e.target.value)}/><div><button className="button primary" disabled={busy||!resultReview&&comment.trim().length<5} onClick={()=>void act(`/approvals/${a.id}/decision`,{decision:'approve',comment,expectedRevision:a.action_revision,expectedStep:a.current_step})}><Check size={16}/>{resultReview?"Принять результат":"Согласовать"}</button><button className="button reject" disabled={busy||comment.trim().length<5} onClick={()=>void act(`/approvals/${a.id}/decision`,{decision:'reject',comment,expectedRevision:a.action_revision,expectedStep:a.current_step})}>{resultReview?"Вернуть с замечаниями":"Отклонить запрос"}</button><button className="button secondary" disabled={busy||comment.trim().length<5} onClick={()=>void act(`/approvals/${a.id}/decision`,{decision:'clarify',comment,expectedRevision:a.action_revision,expectedStep:a.current_step})}>Уточнить</button><button className="text-button" disabled={busy} onClick={()=>void act(`/approvals/${a.id}/decision`,{decision:'later',comment,expectedRevision:a.action_revision,expectedStep:a.current_step,remindMinutes:60})}><Clock3 size={15}/>Напомнить через час</button></div></div>}
  {!canDecide&&a.state==='pending'&&!canAnswer&&<p className="inline-note">{waiting?`Ожидаем ответ от ${data.users.find(u=>u.id===a.requester_id)?.name||'автора запроса'}.`:`Сейчас решение принимает ${actor?.name||'согласующий'}.`}</p>}
 <details className="approval-discussion"><summary>Обсуждение запроса · {(data.approvalComments||[]).filter(c=>c.approval_id===a.id).length}</summary>{(data.approvalComments||[]).filter(c=>c.approval_id===a.id).map(c=><article className="comment" key={c.id}><div><strong>{data.users.find(u=>u.id===c.author_id)?.name}<small>{date(c.created_at,true)}</small></strong><p>{c.body}</p></div></article>)}{!viewingEmployee&&<><label>Сообщение по этому запросу<textarea maxLength={4000} value={thread} onChange={e=>setThread(e.target.value)} placeholder="Уточнение, ответ или ссылка на результат…"/></label><button className="button secondary" disabled={busy||!thread.trim()} onClick={async()=>{if(await act(`/tasks/${a.task_id}/comments`,{body:thread,approvalId:a.id}))setThread('')}}>Отправить сообщение</button></>}</details>
 </section>;
}
function ExplanationForm({min,busy,submit}: {min:number;busy:boolean;submit:(body:unknown)=>Promise<boolean>}){return <form className="explanation-form" onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);await submit({reason:f.get('reason'),progress:f.get('progress'),plan:f.get('plan')});}}><h3>Ответ по результатам проверки</h3><p>Каждое поле — минимум {min} символов. Это проверка полноты, содержание оценивает руководитель.</p>{[{id:'reason',label:'Что помешало выполнить задачу?'},{id:'progress',label:'Что уже сделано?'},{id:'plan',label:'Что будете делать дальше?'}].map(f=><label key={f.id}>{f.label}<textarea name={f.id} required minLength={min} maxLength={4000}/></label>)}<button disabled={busy} className="button primary">Сохранить объяснение</button></form>;}
function RequestModal({type,task,min,busy,error,close,submit}: {type:'deadline'|'completion';task:Task;min:number;busy:boolean;error:string;close:()=>void;submit:(body:unknown)=>Promise<void>}){return <div className="modal-backdrop"><form className="modal" role="dialog" aria-modal="true" aria-label="Новый запрос" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void submit({type,reason:f.get('reason'),plan:f.get('plan'),expectedVersion:task.version,...(type==='deadline'?{proposedDeadline:new Date(String(f.get('deadline'))+':00+03:00').toISOString()}:{})});}}><div className="panel-heading"><h2>{type==='deadline'?'Запросить перенос срока':'Запросить закрытие'}</h2><button type="button" className="icon-button" aria-label="Закрыть запрос" onClick={close}><X size={20}/></button></div><p>#{task.id} · {task.title}</p>{error&&<div className="alert error" role="alert">{error}</div>}{type==='deadline'&&<label>Новый срок · Москва (UTC+3)<input autoFocus name="deadline" type="datetime-local" required/></label>}<label>Причина запроса<textarea autoFocus={type==='completion'} name="reason" required minLength={min} maxLength={4000} placeholder="Что изменилось и почему требуется решение…"/></label><label>{type==='deadline'?'План выполнения к новому сроку':'Результат выполненной работы'}<textarea name="plan" required minLength={min} maxLength={4000}/></label><p className="muted">Крайний срок изменится только после всех этапов согласования.</p><div className="drawer-actions"><button type="button" className="button secondary" onClick={close}>Отмена</button><button disabled={busy} className="button primary">Отправить на согласование</button></div></form></div>;}
function Settings({data,busy,act}: {data:Bootstrap;busy:boolean;act:Act}){
 const [rules,setRules]=useState<Rules>(data.rules);const admin=data.user.role==='admin';const selectors=[{id:'branchManager',name:'Руководитель филиала'},{id:'salesHead',name:'Руководитель продаж'},{id:'director',name:'Директор'},{id:'creator',name:'Постановщик'}];
 return <div className="settings-grid"><form className="panel settings-form" onSubmit={e=>{e.preventDefault();void act('/rules',{rules,expectedVersion:data.rulesVersion},'PUT');}}><div className="panel-heading"><div><h2>Правила контроля</h2><p>Изменения сохраняются отдельной версией</p></div><Badge state="active">v{data.rulesVersion}</Badge></div><label className="toggle-row"><span><strong>Показывать планирование</strong><small>Плановые даты, нагрузка и проверки планирования. Данные сохраняются при выключении.</small></span><input type="checkbox" checked={!!rules.showPlanning} disabled={!admin||busy} onChange={e=>setRules({...rules,showPlanning:e.target.checked})}/></label>{([{key:'overdue',title:'Просроченный крайний срок',desc:'Незавершённые задачи, срок которых уже прошёл.'},{key:'missingDeadline',title:'Отсутствие крайнего срока',desc:'Задачи без даты завершения.'},{key:'plannedOverdue',title:'Нарушение планового срока',desc:'Плановый срок прошёл, крайний ещё не наступил.'},{key:'requiredFields',title:'Обязательные признаки задачи',desc:'Важность и риск потери клиента должны быть заполнены.'},{key:'planning',title:'Качество плана и подзадачи',desc:'Полнота дат, длительность до 6 часов и соответствие срокам родителя.'},{key:'code',title:'Буквенный код · правило GAS',desc:'Формат [РЕ][ЗПОВ][БМ]*; старые коды с # разрешены. Личные задачи исключены.'}] as const).filter(r=>rules.showPlanning||!['plannedOverdue','planning'].includes(r.key)).map(r=><label className="toggle-row" key={r.key}><span><strong>{r.title}</strong><small>{r.desc}</small></span><input type="checkbox" checked={rules[r.key]??false} disabled={!admin||busy} onChange={e=>setRules({...rules,[r.key]:e.target.checked})}/></label>)}<WrittenRules value={rules.writtenRules||[]} disabled={!admin||busy} onChange={writtenRules=>setRules({...rules,writtenRules})}/><div className="numeric-settings">{[{id:'responseMinLength',label:'Минимум символов в поле ответа',min:5,max:200},{id:'reminderMinutes',label:'Интервал напоминаний, мин.',min:1,max:1440},{id:'maxReminders',label:'Напоминаний до эскалации',min:0,max:10}].map(n=><label key={n.id}>{n.label}<input type="number" required min={n.min} max={n.max} value={rules[n.id as 'responseMinLength']} disabled={!admin||busy} onChange={e=>setRules({...rules,[n.id]:Number(e.target.value)})}/></label>)}</div><h3>Маршруты согласования</h3><p className="muted">Демонстрационные маршруты. Уже созданные запросы сохраняют свою версию.</p>{(['deadline','completion'] as const).map(kind=><div className="route-editor" key={kind}><strong>{kind==='deadline'?'Перенос срока':'Закрытие задачи'}</strong>{rules.routes[kind].map((s,i)=><label key={i}>Этап {i+1}<select disabled={!admin||busy} value={s} onChange={e=>setRules({...rules,routes:{...rules.routes,[kind]:rules.routes[kind].map((old,j)=>j===i?e.target.value:old)}} as Rules)}>{selectors.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}</div>)}<div className="settings-save">{admin?<button disabled={busy} className="button primary">Сохранить новую версию</button>:<p className="muted">Изменение настроек доступно администратору.</p>}</div></form><div><section className="panel integration-card"><h2>Подключения</h2><div><strong>Битрикс24</strong><Badge state="warning">Отключено</Badge><p>Исходные задачи импортированы из Excel. Изменения применяются к локальной копии. Реальный REST/event-адаптер не реализован.</p></div><div><strong>Telegram</strong><Badge state="warning">Личные чаты</Badge><p>Личный пилот настраивается в разделе «Рабочий бот». Подключение сотрудников и разделение их Telegram-аккаунтов ещё не настроены.</p></div><div><strong>Хранилище</strong><Badge state="completed">PostgreSQL</Badge><p>Задачи, история, версии правил и отчёты сохраняются на сервере.</p></div></section><section className="panel integration-card"><h2>О текущей версии</h2><p>Доступ к задачам и действиям проверяется сервером. Назначения руководителей пока тестовые: реальные роли и филиалы в Excel отсутствуют.</p><p>Проверки и отчёты доступны вручную и по расписанию. Расписание включает администратор в блоке выше. Праздники, отпуска и замещения ещё не учитываются.</p><p>Коды, плановые даты и сроки подзадач сверены с GAS. Исторические KPI нельзя восстановить из одного листа без истории завершений. Звонки и платные сервисы отсутствуют.</p></section></div></div>;
}
