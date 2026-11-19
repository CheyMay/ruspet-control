import {ArrowUpRight,Bell,CalendarDays,ChartNoAxesCombined,ArrowLeft} from 'lucide-react';
import type {ReactNode} from 'react';
import type {User} from '../shared/types.js';
import {BotConversation} from './BotConversation.js';
import {CapMark} from './CapMark.js';
import {DeviceNotifications} from './DeviceNotifications.js';
import {PersonalCalendar} from './PersonalCalendar.js';

export function MobileWorkspace({user,refresh,unread,connectionNotice,calendarRefresh,analytics}:{user:User;refresh:()=>Promise<unknown>;unread:boolean;connectionNotice?:ReactNode;calendarRefresh:string;analytics?:boolean}){
 const notices=new URLSearchParams(location.search).get('view')==='notifications';
 const calendar=new URLSearchParams(location.search).get('view')==='calendar';
 return <main className="mobile-workspace">
  <header className="mobile-workspace-header">
   <div className="mobile-workspace-name">{calendar&&<a href="/mobile" className="icon-button mobile-menu-link" aria-label="К рабочему боту"><ArrowLeft size={20}/></a>}<CapMark/><div><strong>РУСПЭТ</strong><small>{user.name}</small></div></div>
   <div className="mobile-workspace-links">
    {analytics&&<a href="/?view=analytics" className="icon-button" aria-label="Аналитика"><ChartNoAxesCombined size={18}/></a>}
    {!calendar&&<a href={user.root_access?'/time':'/mobile?view=calendar'} className="icon-button" aria-label="Мой календарь"><CalendarDays size={18}/></a>}
    <a href="/mobile?view=notifications" className="icon-button notification-button" aria-label="Уведомления"><Bell size={18}/>{unread&&<i/>}</a>
    <a href="/?view=full" className="text-button">Полная версия <ArrowUpRight size={14}/></a>
   </div>
  </header>
  {connectionNotice}
  {calendar&&!user.root_access?<PersonalCalendar refreshKey={calendarRefresh}/>:<>
   {notices&&<details className="mobile-device-notifications"><summary>Установка приложения и push-уведомления</summary><DeviceNotifications install userId={user.id}/></details>}
   <BotConversation mobile initial={notices?'notices':'home'} refresh={refresh}/>
  </>}
 </main>;
}
