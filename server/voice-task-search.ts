import type {Db} from './db.js';
import {canManage,canRequest} from './domain.js';
import {okbConfigured,okbPool} from './okb.js';
import {visibleTasks} from './service.js';
import {canReview} from '../shared/actions.js';
import type {Approval,Task,User} from '../shared/types.js';
import type {VoiceKind} from './voice-intent.js';

type Candidate={task:Task;company:string;score:number;pending:boolean};
const legalWords=new Set(['ооо','оао','пао','зао','ао','ип','llc','ltd']);
const words=(value:string)=>(value.normalize('NFKC').toLowerCase().replaceAll('ё','е').match(/[\p{L}\p{N}]+/gu)??[])
 .map(word=>word==='pet'||word==='пэт'?'пет':word);
const nameWords=(value:string)=>words(value).filter(word=>!legalWords.has(word));
const stem=(word:string)=>word.length>=4?word.replace(/(?:ого|ему|ому|ыми|ами|ями|ая|яя|ое|ее|ый|ий|ой|ые|ие|ом|ем|а|я|у|ю|е|ы|и)$/u,''):word;

function typo(a:string,b:string){
 if(Math.min(a.length,b.length)<4||Math.abs(a.length-b.length)>1)return false;
 if(a.length>b.length)return typo(b,a);
 let index=0;while(index<a.length&&a[index]===b[index])index++;
 return a.length===b.length?
  a.slice(index+1)===b.slice(index+1)||a[index]===b[index+1]&&a[index+1]===b[index]&&a.slice(index+2)===b.slice(index+2):
  a.slice(index)===b.slice(index+1);
}

function containsPhrase(haystack:string[],needle:string[],equal:(a:string,b:string)=>boolean){
 return haystack.some((_,index)=>needle.length<=haystack.length-index&&needle.every((word,offset)=>equal(word,haystack[index+offset])));
}
const sameWord=(a:string,b:string)=>a===b;
const sameStem=(a:string,b:string)=>stem(a)===stem(b);

function companyScore(name:string,query:string[]){
 const tokens=nameWords(name);
 if(!tokens.length)return 0;
 if(tokens.join('')===query.join(''))return 100;
 if(tokens.length===query.length&&containsPhrase(tokens,query,sameStem))return 95;
 if(containsPhrase(tokens,query,sameWord))return 90;
 if(containsPhrase(tokens,query,sameStem))return 85;
 if(containsPhrase(tokens,query,(a,b)=>sameStem(a,b)||typo(a,b)))return 70;
 const joined=query.join('');
 return joined.length>=4&&tokens.join('').includes(joined)?65:0;
}
function applicable(actor:User,task:Task,kind:VoiceKind,pending?:Approval){
 if(kind==='deadline')return !pending&&task.status==='active'&&canRequest(actor,task);
 if(kind==='submit')return !pending&&(task.status==='active'&&canRequest(actor,task)||task.status==='review'&&canReview(actor,task));
 if(kind==='accept'||kind==='return')return !pending&&task.status==='review'&&canReview(actor,task);
 if(kind==='clarification')return !!pending?.clarification_requested_at&&!pending.clarification_answered_at&&pending.requester_id===actor.id;
 if(kind==='approve'||kind==='reject'||kind==='clarify')return !!pending&&
  (!pending.clarification_requested_at||!!pending.clarification_answered_at)&&pending.route[pending.current_step]?.userId===actor.id;
 if(kind==='delegate')return canManage(actor)&&task.status==='active';
 if(kind==='reminder'||kind==='reminder_once'||kind.startsWith('edit_'))return task.status!=='completed';
 return true;
}

export async function findVoiceTasks(actor:User,value:string,kind:VoiceKind,db:Db):Promise<Candidate[]>{
 const search=value.trim().replace(/^#\s*/u,'');
 const accessible=await visibleTasks(actor,db);
 const pending=(await db.query<Approval>("SELECT * FROM approvals WHERE state='pending' AND task_id=ANY($1)",[accessible.map(task=>task.id)])).rows;
 const byTask=new Map(pending.map(approval=>[approval.task_id,approval]));
 const tasks=accessible.filter(task=>applicable(actor,task,kind,byTask.get(task.id)));
 const exact=tasks.find(task=>task.id.toLowerCase()===search.toLowerCase());
 if(exact)return [{task:exact,company:'',score:100,pending:byTask.has(exact.id)}];
 const query=nameWords(search.replace(/^(?:(?:по\s+)?(?:клиент[ауе]?|компани[яию])\s+)+/iu,''));
 if(!query.length||query.join('').length<2||/^\d+$/u.test(search)&&![10,12].includes(search.length))return [];
 const ids=[...new Set(tasks.flatMap(task=>task.company_id?[task.company_id]:[]))];
 const companies=new Map<string,{name:string;tax_id:string|null}>();
 if(ids.length&&okbConfigured()){
  const result=await okbPool().query<{id:string;name:string;tax_id:string|null}>('SELECT id,name,tax_id FROM companies WHERE id=ANY($1::uuid[])',[ids]).catch(()=>null);
  for(const row of result?.rows??[])companies.set(row.id,row);
 }
 const rows=tasks.flatMap(task=>{
  const linked=task.company_id?companies.get(task.company_id):undefined;
  const imported=typeof task.source_fields?.['Компания']==='string'?task.source_fields['Компания']:'';
  const title=words(task.title);
  const companyWords=nameWords(linked?.name??imported);
  const contextual=companyWords.length>0&&containsPhrase(query,companyWords,sameStem)&&query.every(word=>
   companyWords.some(name=>sameStem(name,word))||title.some(part=>sameStem(part,word)));
  const score=Math.max(linked?.tax_id===search?100:0,companyScore(linked?.name??'',query),companyScore(imported,query),
   contextual?96:0,containsPhrase(title,query,sameWord)?80:containsPhrase(title,query,sameStem)?75:0);
  return score?[{task,company:linked?.name||imported,score,pending:byTask.has(task.id)}]:[];
 });
 return rows.sort((a,b)=>b.score-a.score||Number(a.task.status==='completed')-Number(b.task.status==='completed')||
  Number(b.task.assignee_id===actor.id)-Number(a.task.assignee_id===actor.id)||
  (a.task.deadline??'9999').localeCompare(b.task.deadline??'9999')||a.task.id.localeCompare(b.task.id));
}
