self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));

self.addEventListener('push',event=>{
 let message={};
 try{message=event.data?.json()??{};}catch{}
 const body=typeof message.body==='string'?message.body:'Откройте рабочие уведомления.';
 const tag=['ruspet-assignments','ruspet-staff-review','ruspet-push-test','ruspet-management'].includes(message.tag)?message.tag:'ruspet-deadlines';
 event.waitUntil(Promise.all([
  self.registration.showNotification('РУСПЭТ',{body,tag,renotify:true,icon:'/app-icon-192.png'}),
  self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
   for(const client of clients)client.postMessage({type:'ruspet-task-notice'});
  })
 ]));
});

self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const url=new URL(event.notification.tag==='ruspet-staff-review'?'/?view=registrations':'/mobile?view=notifications',self.location.origin);
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const existing=clients.find(client=>client.url===url.href);
  if(existing)await existing.focus();
  else await self.clients.openWindow(url.href);
 })());
});
