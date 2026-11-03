import {Fragment,type ReactNode} from 'react';
export function BotText({text,html=false}:{text:string;html?:boolean}){
 if(!html)return <>{text}</>;
 const tree=new DOMParser().parseFromString(text,'text/html');
 const render=(node:Node,key:number):ReactNode=>{
  if(node.nodeType===Node.TEXT_NODE)return node.textContent;
  if(node instanceof Element&&node.tagName==='A'){
   const href=node.getAttribute('href')||'';
   if(/^https?:\/\//i.test(href))return <a key={key} className="text-button" href={href} target="_blank" rel="noreferrer">{node.textContent}</a>;
  }
  return <Fragment key={key}>{node.textContent}</Fragment>;
 };
 return <>{Array.from(tree.body.childNodes).map(render)}</>;
}
