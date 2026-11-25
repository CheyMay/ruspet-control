import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {api} from './api.js';
import {discussionMessages} from '../shared/task-discussion.js';
import type {BitrixDiscussion,BitrixResults,BitrixResult,Comment,User} from '../shared/types.js';

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

function useBitrixContent<T extends {state:BitrixResults['state'];results?:BitrixResults}>(id:string,section:'discussion'|'results',focus?:string){
 const [content,setContent]=useState<T|null>(null),[error,setError]=useState(false),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let active=true,timer:ReturnType<typeof setTimeout>;
  async function load(){
   let delay=30000;
   try{
    const suffix=focus?'?focus='+encodeURIComponent(focus):'';
    const result=await api<T>('/tasks/'+encodeURIComponent(id)+'/'+section+suffix,'GET',undefined,{timeout:10000});
    if(!active)return;
    setContent(result);setError(false);
    if(result.state==='pending'||result.results?.state==='pending')delay=4000;
   }catch{if(active)setError(true);}
   if(active)timer=setTimeout(load,delay);
  }
  void load();
  return()=>{active=false;clearTimeout(timer);};
 },[id,section,focus,retry]);
 return {content,error,reload:()=>setRetry(n=>n+1)};
}

function ResultFiles({files}:{files:BitrixResult['files']}){
 return files.length>0&&<ul className="result-files" aria-label="Вложения из Битрикс24">
  {files.map(file=><li key={file.id}>{file.name??'Файл '+file.id}</li>)}
 </ul>;
}

export function TaskResults({id,linked,hasLocal}:{id:string;linked:boolean;hasLocal:boolean}){
 return linked?<ImportedResults id={id} hasLocal={hasLocal}/>:!hasLocal&&<p className="muted">Результат пока не сдавали.</p>;
}

function ImportedResults({id,hasLocal}:{id:string;hasLocal:boolean}){
 const {content,error,reload}=useBitrixContent<BitrixResults>(id,'results');
 const status=error||content?.state==='unavailable'?'Результаты из Битрикс24 временно недоступны.':
  !content||content.state==='pending'?'Загружаем результат из Битрикс24…':'';
 return <>
  {status&&<p className="discussion-status muted" role="status">{status} {error&&<button type="button" className="text-button" onClick={reload}>Повторить</button>}</p>}
  {!!content?.items.length&&<section className="submission-history" aria-label="Результаты из Битрикс24">
   {content.items.map(result=><article key={result.external_id}>
    <strong>Результат · Битрикс24</strong>
    <small>{result.author}{result.occurred_at?' · '+dateAndTime.format(new Date(result.occurred_at))+' МСК':''}</small>
    {result.body&&<p className="discussion-text">{bitrixText(result.body,content.origin)}</p>}
    <ResultFiles files={result.files}/>
   </article>)}
  </section>}
  {!hasLocal&&!status&&!content?.items.length&&<p className="muted">Результат пока не сдавали.</p>}
 </>;
}

export function TaskDiscussion({id,comments,users,focus}:{id:string;comments:Comment[];users:User[];focus?:string}){
 const externalId=/^bitrix:([1-9]\d{0,17})$/.exec(focus??'')?.[1];
 const {content:bitrix,error,reload}=useBitrixContent<BitrixDiscussion>(id,'discussion',externalId);
 const thread=useRef<HTMLDivElement>(null),pin=useRef(true),[showLatest,setShowLatest]=useState(false);
 const target=useRef<HTMLLIElement>(null),shownFocus=useRef<string|undefined>(undefined);
 const matchingResult=externalId?bitrix?.results?.items.find(result=>String(result.comment_id)===externalId):undefined;
 const focusKey=matchingResult?'result:'+matchingResult.external_id:focus;
 function scrollToLatest(){
  const node=thread.current;
  if(node)node.scrollTop=node.scrollHeight;
  pin.current=true;
  setShowLatest(false);
 }
 useLayoutEffect(()=>{
  if(focusKey&&focusKey!==shownFocus.current&&thread.current&&target.current){
   const {current:node}=thread;
   node.scrollTop+=target.current.getBoundingClientRect().top-node.getBoundingClientRect().top-12;
   pin.current=false;shownFocus.current=focusKey;
   setShowLatest(node.scrollHeight-node.scrollTop-node.clientHeight>=48);
   return;
  }
  if(focusKey&&shownFocus.current!==focusKey)return;
  if(pin.current)scrollToLatest();
 },[comments,bitrix,focusKey]);
 const people=new Map(users.map(user=>[user.id,user.name]));
 const messages=discussionMessages(comments,id=>people.get(id)||'Сотрудник РУСПЭТ',bitrix);
 const status=error?'Не удалось загрузить обсуждение из Битрикс24.':!bitrix?'Загружаем обсуждение из Битрикс24…':
  bitrix.state==='pending'?'Синхронизируем сообщения из Битрикс24…':bitrix.state==='unavailable'?'Обсуждение из Битрикс24 временно недоступно.':'';
 return <section className="task-discussion" aria-label="Сообщения по задаче">
  {status&&<p className="discussion-status muted" role="status">{status} {error&&<button type="button" className="text-button" onClick={reload}>Повторить</button>}</p>}
  {messages.length?<div className="discussion-thread" ref={thread} tabIndex={0} role="region" aria-label="Лента обсуждения"
   onScroll={event=>{
    const node=event.currentTarget;
    pin.current=node.scrollHeight-node.scrollTop-node.clientHeight<48;
    setShowLatest(!pin.current);
   }}>
   <ol className="discussion-messages">{messages.map(message=>{
    const external=message.source.includes('Битрикс24');
    const initials=message.author.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
    return <li className="discussion-message" key={message.key} ref={message.key===focusKey?target:undefined} data-search-hit={message.key===focusKey||undefined}>
     <span aria-hidden="true" className={'discussion-avatar'+(external?' bitrix':'')}>{initials}</span>
     <div className="discussion-note"><div className="discussion-meta"><strong>{message.author}</strong><span className="discussion-source">{message.source}</span>
      {message.at&&<time dateTime={message.at} title="Московское время">{messageTime.format(new Date(message.at))}</time>}</div>
      {message.body.trim()?<p className="discussion-text">{external?bitrixText(message.body,bitrix?.origin??bitrix?.results?.origin??null):message.body}</p>:
       !message.files?.length&&<p className="discussion-text muted">Сообщение без текста</p>}
      {message.files&&<ResultFiles files={message.files}/>}
     </div>
    </li>;
   })}</ol>
  </div>:!status&&<p className="muted">Сообщений пока нет.</p>}
  {showLatest&&<button type="button" className="text-button discussion-latest" onClick={scrollToLatest}>К последним сообщениям ↓</button>}
 </section>;
}
