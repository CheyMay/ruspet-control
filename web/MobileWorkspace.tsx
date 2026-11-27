import {ArrowUpRight,Bell,BookOpen,CalendarDays,ChartNoAxesCombined,ArrowLeft,Search,Users} from 'lucide-react';
import {useState,type ReactNode} from 'react';
import type {Notification,User} from '../shared/types.js';
import type {AnalyticsAccess} from '../shared/team-analytics.js';
import {canOpenWorkspacePage} from '../shared/workspace-access.js';
import {BotConversation} from './BotConversation.js';
import {CapMark} from './CapMark.js';
import {NotificationCenter,NotificationSettings} from './NotificationCenter.js';
import {AccountSettings} from './AccountSettings.js';
import {ReminderInbox} from './ReminderInbox.js';
import {PersonalCalendar} from './PersonalCalendar.js';
import {WorkspaceGuide,WorkspaceTour} from './WorkspaceGuide.js';
import type {TourStep} from './WorkspaceTraining.js';

export function MobileWorkspace({user,refresh,items,unread,connectionNotice,calendarRefresh,analytics,onSearch}:{user:User;refresh:()=>Promise<unknown>;items:Notification[];unread:boolean;connectionNotice?:ReactNode;calendarRefresh:string;analytics?:AnalyticsAccess|null;onSearch:()=>void}){
 const [screen,setScreen]=useState(()=>{const view=new URLSearchParams(location.search).get('view');return view==='notifications'||view==='calendar'||view==='guide'||view==='account'?view:'bot';});
 const [tour,setTour]=useState<{steps:TourStep[];index:number}|null>(null);
 const [reminders,setReminders]=useState(false);
 const notices=screen==='notifications',calendar=screen==='calendar',guide=screen==='guide',account=screen==='account';
 const lesson=tour?.steps[tour.index].id;
 function showTour(steps:TourStep[],index:number){setScreen(steps[index].page==='calendar'?'calendar':'bot');setTour({steps,index});}
 const openTask=(id:string)=>location.assign('/?'+new URLSearchParams({view:'tasks',full:'1',task:id}));
 return <main className="mobile-workspace">
  <header className="mobile-workspace-header">
   <div className="mobile-workspace-name">{(calendar||guide||notices||account)&&<a href="/mobile" className="icon-button mobile-menu-link" aria-label="К рабочему боту"><ArrowLeft size={20}/></a>}<CapMark/><div><strong>РУСПЭТ</strong><small>{user.name}</small></div></div>
   <div className="mobile-workspace-links">
    <button type="button" className="icon-button" aria-label="Команды и поиск" onClick={onSearch}><Search size={18}/></button>
    {!guide&&<a href="/?view=okb&full=1" className="icon-button" aria-label="Клиенты"><Users size={18}/></a>}
    {!guide&&analytics&&<a href="/?view=analytics" className="icon-button mobile-analytics-link" aria-label="Аналитика"><ChartNoAxesCombined size={18}/></a>}
    {!calendar&&<a href={user.root_access?'/time':'/mobile?view=calendar'} className="icon-button" aria-label="Мой календарь"><CalendarDays size={18}/></a>}
    <a href="/mobile?view=notifications" className="icon-button notification-button" aria-label="Уведомления"><Bell size={18}/>{unread&&<i/>}</a>
    <a href="/mobile?view=guide" className="button secondary guide-entry" aria-current={guide?'page':undefined}><BookOpen size={16}/> Гайд</a>
    <a href="/?view=full" className="text-button mobile-full-link" aria-label="Полная версия"><span>Полная версия</span> <ArrowUpRight size={14}/></a>
   </div>
  </header>
  {connectionNotice}
  {account?<AccountSettings user={user}/>:guide?<WorkspaceGuide user={user} enabled={page=>canOpenWorkspacePage(user,page,analytics)} launch={steps=>showTour(steps,0)} salesOverview={analytics==='sales'} mobile/>:
   calendar&&!user.root_access?<PersonalCalendar refreshKey={calendarRefresh}/>:notices?<>
   <div className="tabs mobile-notice-tabs" aria-label="Раздел уведомлений">
    <button type="button" className={!reminders?'selected':''} aria-pressed={!reminders} onClick={()=>setReminders(false)}>Лента</button>
    <button type="button" className={reminders?'selected':''} aria-pressed={reminders} onClick={()=>setReminders(true)}>Напоминания</button>
   </div>
   {reminders?<ReminderInbox userId={user.id} open={openTask} onChange={refresh}/>:
    <NotificationCenter userId={user.id} items={items} readOnly={false} refresh={refresh} open={openTask}/>}
   <details className="mobile-device-notifications"><summary>Настройки каналов</summary><NotificationSettings userId={user.id}/></details>
   <a className="button secondary" href="/mobile?view=account">Вход и пароль</a>
  </>:<BotConversation mobile initial={lesson==='phoneDecision'?'inbox':'home'} refresh={refresh}/>}
  {tour&&<WorkspaceTour steps={tour.steps} index={tour.index} change={index=>showTour(tour.steps,index)} end={()=>{setTour(null);setScreen('guide');window.scrollTo(0,0);}}/>}
 </main>;
}
