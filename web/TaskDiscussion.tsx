import {useEffect,useState,type ReactNode} from 'react';
import {api} from './api.js';
import type {BitrixDiscussion,Comment,User} from '../shared/types.js';

const messageTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'});
const dateOnly=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'medium'});
const dateAndTime=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'medium',timeStyle:'short'});

function messageLink(value:string,origin:string|null){
 const target=value.trim();
 if(!/^https?:\/\//i.test(target)&&!(origin&&/^\/(?!\/)/.test(target)))return null;
 try{
  const url=new URL(target,origin??undefined);
  return /^https?:$/.test(url.protocol)&&!url.username&&!url.password?url.href:null;
 }catch{return null;}
}

const inlineTags={B:'strong',I:'em',U:'u',S:'s',QUOTE:'q'} as const;
const bitrixTags=/\[(USER|URL|B|I|U|S|QUOTE)(?:=([^\]\r\n]+))?\]([\s\S]*?)\[\/\1\]|\[(BR|TIMESTAMP)(?:=([^\]\r\n]+))?\]/gi;

function bitrixText(body:string,origin:string|null,depth=0):ReactNode{
 if(depth>=4)return body;
 const parts:ReactNode[]=[];
 let offset=0;
 for(const match of body.matchAll(bitrixTags)){
  const index=match.index??0;
  parts.push(body.slice(offset,index));
  offset=index+match[0].length;
  const tag=(match[1]||match[4]).toUpperCase();
  if(tag==='BR'){parts.push(<br key={index}/>);continue;}
  if(tag==='TIMESTAMP'){
   const [,seconds,format]=match[5]?.match(/^(-?\d+)(?:\s+FORMAT=([A-Z_]+))?/i)??[];
   const stamp=new Date(Number(seconds)*1000);
   parts.push(Number.isFinite(stamp.getTime())?(format?.toUpperCase()==='SHORT_DATE_FORMAT'?dateOnly:dateAndTime).format(stamp):match[0]);
   continue;
  }
  const value=bitrixText(match[3],origin,depth+1);
  if(tag==='URL'){
   const href=messageLink(match[2]??match[3],origin);
   parts.push(href?<a key={index} href={href} target="_blank" rel="noreferrer">{value}</a>:<span key={index}>{value}</span>);
  }else if(tag==='USER')parts.push(<span className="discussion-mention" key={index}>{value}</span>);
  else{
   const Tag=inlineTags[tag as keyof typeof inlineTags];
   parts.push(<Tag key={index}>{value}</Tag>);
  }
 }
 return [...parts,body.slice(offset)];
}

export function TaskDiscussion({id,comments,users}:{id:string;comments:Comment[];users:User[]}){
 const [bitrix,setBitrix]=useState<BitrixDiscussion|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>;
  async function load(){
   let delay=30000;
   try{
    const result=await api<BitrixDiscussion>('/tasks/'+encodeURIComponent(id)+'/discussion','GET',undefined,{timeout:10000});
    if(!active)return;
    setBitrix(result);setError(false);
    if(result.state==='pending')delay=4000;
   }catch{if(active)setError(true);}
   if(active)timer=setTimeout(load,delay);
  }
  void load();
  return()=>{active=false;clearTimeout(timer);};
 },[id,retry]);

 const people=new Map(users.map(user=>[user.id,user.name]));
 const messages=[...comments.map(comment=>({key:'local:'+comment.id,author:people.get(comment.author_id)||'Сотрудник РУСПЭТ',
  at:comment.created_at,body:comment.body,source:comment.approval_id?'Согласование':'РУСПЭТ'})),
  ...(bitrix?.messages??[]).map(message=>({key:'bitrix:'+message.external_id,author:message.author,at:message.occurred_at,body:message.body,source:'Битрикс24'}))]
  .sort((a,b)=>a.at.localeCompare(b.at)||a.key.localeCompare(b.key,'ru',{numeric:true}));
 const status=error?'Не удалось загрузить обсуждение из Битрикс24.':!bitrix?'Загружаем обсуждение из Битрикс24…':
  bitrix.state==='pending'?'Синхронизируем сообщения из Битрикс24…':bitrix.state==='unavailable'?'Обсуждение из Битрикс24 временно недоступно.':'';
 return <section className="task-discussion" aria-label="Сообщения по задаче">
  {status&&<p className="discussion-status muted" role="status">{status} {error&&<button type="button" className="text-button" onClick={()=>setRetry(n=>n+1)}>Повторить</button>}</p>}
  {messages.length?<ol className="discussion-messages">{messages.map(message=>{
   const external=message.source==='Битрикс24';
   const initials=message.author.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
   return <li className="discussion-message" key={message.key}>
    <span aria-hidden="true" className={'discussion-avatar'+(external?' bitrix':'')}>{initials}</span>
    <div className="discussion-note"><div className="discussion-meta"><strong>{message.author}</strong><span className="discussion-source">{message.source}</span>
     <time dateTime={message.at} title="Московское время">{messageTime.format(new Date(message.at))}</time></div>
     <p className="discussion-text">{message.body.trim()?external?bitrixText(message.body,bitrix?.origin??null):message.body:<span className="muted">Сообщение без текста</span>}</p>
    </div>
   </li>;
  })}</ol>:!status&&<p className="muted">Сообщений пока нет.</p>}
 </section>;
}
