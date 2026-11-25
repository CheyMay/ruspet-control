import {z} from 'zod';
import {branchCovers} from '../shared/branches.js';
import {businessDay} from '../shared/queues.js';
import {reportKindLabels} from '../shared/report-parameters.js';
import {taskNumber} from '../shared/task-number.js';
import type {Task,User} from '../shared/types.js';
import {normalizeSearch,searchKinds,searchRank,searchTerms,type SearchFilters,type SearchHit,type SearchResponse} from '../shared/workspace-search.js';
import {transaction,type Db} from './db.js';
import {globalAccess} from './domain.js';
import {listCompanies,okbConfigured} from './okb.js';
import {reportScopes} from './reports-v5.js';
import {visibleTasks} from './service.js';

export const workspaceSearchInput=z.object({
 q:z.string().trim().min(2).max(160),
 kind:z.enum(searchKinds).optional(),
 branch:z.string().trim().min(1).max(150).optional(),
 owner:z.string().trim().min(1).max(100).optional(),
 from:z.iso.date().optional(),to:z.iso.date().optional(),
}).refine(input=>!input.from||!input.to||input.from<=input.to,{message:'Начало периода позже окончания.'});

const maxPerKind=8;
function excerpt(value:string,terms:string[]){
 const clean=value.replace(/\[\/?(?:USER|URL|B|I|U|S|QUOTE|BR|TIMESTAMP)(?:=[^\]]*)?\]/gi,' ').replace(/\s+/gu,' ').trim();
 if(!clean)return undefined;
 const text=normalizeSearch(clean);
 const matches=terms.map(term=>text.indexOf(term)).filter(at=>at>=0);
 const start=Math.max(0,(matches.length?Math.min(...matches):0)-30);
 const end=Math.min(clean.length,start+160);
 return (start?'… ':'')+clean.slice(start,end).trim()+(end<clean.length?'…':'');
}

const inPeriod=(at:string,filter:SearchFilters)=> {
 const day=businessDay(at);
 return (!filter.from||day>=filter.from)&&(!filter.to||day<=filter.to);
};

function ranked<T>(rows:T[],score:(row:T)=>number){
 return rows.map(row=>({row,score:score(row)})).filter(item=>item.score>0)
  .sort((a,b)=>b.score-a.score).slice(0,maxPerKind).map(item=>item.row);
}

async function commentHits(db:Db,tasks:Task[],terms:string[],filter:SearchFilters):Promise<SearchHit[]>{
 if(!tasks.length)return [];
 const byId=new Map(tasks.map(task=>[task.id,task]));
 const rows=(await db.query<{key:string;task_id:string;author:string;body:string;at:string}>(`
  WITH messages AS (
   SELECT 'local:'||c.id::text AS key,c.task_id,u.name AS author,c.body,c.created_at AS at
   FROM comments c JOIN users u ON u.id=c.author_id
   WHERE c.task_id=ANY($1::text[]) AND c.withdrawn_at IS NULL
   UNION ALL
   SELECT 'bitrix:'||a.external_id,a.task_id,a.author,a.body,a.occurred_at
   FROM bitrix_task_activity a
   WHERE a.task_id=ANY($1::text[]) AND a.kind='comment'
   AND NOT EXISTS(SELECT 1 FROM bitrix_operations o WHERE o.task_id=a.task_id AND o.payload->>'kind'='comment'
    AND position('[ruspet:'||o.event_id::text||']' IN a.body)>0)
  )
  SELECT * FROM messages WHERE NOT EXISTS (
   SELECT 1 FROM unnest($2::text[]) AS term WHERE strpos(replace(staff_normalized_label(body),'ё','е'),term)=0
  )
  AND ($3::date IS NULL OR (at AT TIME ZONE 'Europe/Moscow')::date>=$3)
  AND ($4::date IS NULL OR (at AT TIME ZONE 'Europe/Moscow')::date<=$4)
  ORDER BY at DESC NULLS LAST,key LIMIT $5`,
 [tasks.map(task=>task.id),terms,filter.from??null,filter.to??null,maxPerKind])).rows;
 return rows.flatMap(row=>{
  const task=byId.get(row.task_id);
  return task?[{kind:'comment' as const,id:row.key,title:task.title,subtitle:['#'+taskNumber(task),row.author].filter(Boolean).join(' · '),
   excerpt:excerpt(row.body,terms),taskId:task.id}]:[];
 });
}

export async function workspaceSearch(actor:User,input:z.infer<typeof workspaceSearchInput>,preview=false):Promise<SearchResponse>{
 const terms=searchTerms(input.q);
 if(terms.join('').length<2)return {hits:[]};
 const wants=(kind:SearchHit['kind'])=>!input.kind||input.kind===kind;
 const local=await transaction(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const hits:SearchHit[]=[];
  const tasks=wants('task')||wants('comment')||wants('person')?await visibleTasks(actor,db):[];
  const scoped=tasks.filter(task=>(!input.owner||task.assignee_id===input.owner)&&
   (!input.branch||branchCovers(input.branch,task.branch_id)||input.branch===task.branch_id));
  const exact=normalizeSearch(input.q.replace(/^#\s*/u,''));
  if(wants('task')){
   const selected=ranked(scoped.filter(task=>inPeriod(task.created_at,input)),task=>
    [taskNumber(task),task.id].some(id=>normalizeSearch(id)===exact)?1000:
     searchRank(terms,task.title,task.description,taskNumber(task)));
   hits.push(...selected.map(task=>({kind:'task' as const,id:task.id,title:task.title,
    subtitle:['#'+taskNumber(task),task.branch_id].filter(Boolean).join(' · '),excerpt:excerpt(task.description,terms)})));
  }
  if(wants('person')&&!input.from&&!input.to){
   const related=new Set(tasks.flatMap(task=>[task.assignee_id,task.creator_id]));
   const people=(await db.query<Pick<User,'id'|'name'|'branch_id'|'position'>>(`SELECT id,name,branch_id,position FROM users u
    WHERE NOT root_access AND (NOT EXISTS(SELECT 1 FROM staff_directory s WHERE s.user_id=u.id)
     OR EXISTS(SELECT 1 FROM staff_directory s WHERE s.user_id=u.id AND s.enabled)) ORDER BY name,id`)).rows;
   const allowed=people.filter(person=>(globalAccess(actor)||branchCovers(actor.branch_id,person.branch_id)||person.id===actor.id||related.has(person.id))&&
    (!input.owner||input.owner===person.id)&&(!input.branch||branchCovers(input.branch,person.branch_id)||input.branch===person.branch_id));
   hits.push(...ranked(allowed,person=>searchRank(terms,person.name,person.position)).map(person=>({kind:'person' as const,id:person.id,
    title:person.name,subtitle:[person.position,person.branch_id].filter(Boolean).join(' · ')})));
  }
  if(wants('comment'))hits.push(...await commentHits(db,scoped,terms,input));
  if(wants('report')&&!input.branch&&!input.owner){
   const rows=(await db.query<{id:string;kind:string;day:string;created_at:string}>(`SELECT id,kind,day,created_at FROM reports
    WHERE scope=ANY($1::text[]) AND ($2::date IS NULL OR day>=$2) AND ($3::date IS NULL OR day<=$3)
    ORDER BY created_at DESC,id LIMIT 250`,[reportScopes(actor),input.from??null,input.to??null])).rows;
   const title=(row:typeof rows[number])=>reportKindLabels[row.kind]??'Отчёт';
   hits.push(...ranked(rows,row=>searchRank(terms,title(row),row.day+' '+row.day.split('-').reverse().join('.')))
    .map(row=>({kind:'report' as const,id:row.id,title:title(row),subtitle:row.day.split('-').reverse().join('.')})));
  }
  return hits;
 });
 if(!preview&&wants('company')&&!input.branch&&!input.from&&!input.to&&okbConfigured()){
  try{
   const rows=await listCompanies(actor,input.q);
   local.push(...rows.filter(row=>!input.owner||row.manager_id===input.owner).slice(0,maxPerKind)
    .map(row=>({kind:'company' as const,id:row.id,title:row.name,subtitle:row.tax_id?'ИНН '+row.tax_id:undefined})));
  }catch{return {hits:local,companiesUnavailable:true};}
 }
 return {hits:local};
}
