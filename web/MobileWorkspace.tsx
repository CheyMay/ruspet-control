import {ArrowUpRight} from 'lucide-react';
import type {User} from '../shared/types.js';
import {BotConversation} from './BotConversation.js';
import {CapMark} from './CapMark.js';

export function MobileWorkspace({user,refresh}:{user:User;refresh:()=>Promise<unknown>}){
 const notices=new URLSearchParams(location.search).get('view')==='notifications';
 return <main className="mobile-workspace">
  <header className="mobile-workspace-header">
   <div className="mobile-workspace-name"><CapMark/><div><strong>РУСПЭТ</strong><small>{user.name}</small></div></div>
   <a href="/?view=full" className="text-button">Полная версия <ArrowUpRight size={14}/></a>
  </header>
  <BotConversation mobile initial={notices?'notices':'home'} refresh={refresh}/>
 </main>;
}
