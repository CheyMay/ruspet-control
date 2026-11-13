import {ArrowUpRight,Bell,Menu} from 'lucide-react';
import type {User} from '../shared/types.js';
import {BotConversation} from './BotConversation.js';
import {CapMark} from './CapMark.js';
import {DeviceNotifications} from './DeviceNotifications.js';

export function MobileWorkspace({user,refresh,unread}:{user:User;refresh:()=>Promise<unknown>;unread:boolean}){
 const notices=new URLSearchParams(location.search).get('view')==='notifications';
 return <main className="mobile-workspace">
  <header className="mobile-workspace-header">
   <div className="mobile-workspace-name"><a href="/mobile" className="icon-button mobile-menu-link" aria-label="Меню"><Menu size={20}/></a><CapMark/><div><strong>РУСПЭТ</strong><small>{user.name}</small></div></div>
   <div className="mobile-workspace-links">
    <a href="/mobile?view=notifications" className="icon-button notification-button" aria-label="Уведомления"><Bell size={18}/>{unread&&<i/>}</a>
    <a href="/?view=full" className="text-button">Полная версия <ArrowUpRight size={14}/></a>
   </div>
  </header>
  <details className="mobile-device-notifications" open={notices||undefined}><summary>Установить приложение и включить push</summary><DeviceNotifications install userId={user.id}/></details>
  <BotConversation mobile initial={notices?'notices':'home'} refresh={refresh}/>
 </main>;
}
