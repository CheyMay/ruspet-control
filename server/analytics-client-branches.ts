import type {Task} from '../shared/types.js';
import {okbConfigured,okbPool} from './okb.js';
import {unassignedBranch} from '../shared/branches.js';
import {withTaskClients,importedTaskClient} from './task-clients.js';
import type {Db} from './db.js';

const nameKey=(name:string)=>name.toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function salesBranch(value:string|null){
 if(/крым|севастопол/iu.test(value??''))return 'Крым';
 if(/краснодар/iu.test(value??''))return 'Краснодар';
 return null;
}

export async function analyticsClientBranches(tasks:Task[],db:Db){
 const result=new Map<string,string>();
 const unresolved=tasks.filter(task=>!task.branch_id||[unassignedBranch,'Крым','Краснодар'].includes(task.branch_id));
 if(!okbConfigured()||!unresolved.length)return result;
 try{
  const clients=await withTaskClients(unresolved,db);
  const {rows}=await okbPool().query<{id:string;name:string;name1c:string|null;branch:string|null;region:string|null}>(`SELECT
   id,name,xlsx_source->>'name1c' AS name1c,xlsx_source->>'branch' AS branch,
   coalesce(nullif(xlsx_source->>'region',''),legal_address) AS region
   FROM companies WHERE bitrix_deleted_at IS NULL`);
  const byId=new Map<string,string>(),byName=new Map<string,Set<string>>();
  for(const client of rows){
   const branch=salesBranch(client.branch)??(!client.branch?.trim()?salesBranch(client.region):null);
   if(branch)byId.set(client.id,branch);
   for(const key of new Set([client.name,client.name1c].filter((name):name is string=>!!name).map(nameKey))){
    if(!key)continue;
    const matches=byName.get(key)??new Set<string>();
    matches.add(branch??'');byName.set(key,matches);
   }
  }
  const aliases=new Map<string,string[]>();
  for(const key of byName.keys()){
   if(key.length<6||!/\p{L}/u.test(key))continue;
   const token=key.split(' ')[0];
   const names=aliases.get(token)??[];
   names.push(key);aliases.set(token,names);
  }
  for(const task of clients){
   const sourceBranch=salesBranch(importedTaskClient(task.source_fields?.['Филиал']));
   if(sourceBranch){result.set(task.id,sourceBranch);continue;}
   const linked=task.client_refs??[];
   const imported=nameKey(importedTaskClient(task.source_fields?.['Компания']));
   let branches=linked.length?new Set(linked.map(client=>byId.get(client.id)??'')):byName.get(imported);
   if(!branches&&!linked.length&&!imported){
    const title=nameKey(task.title),padded=' '+title+' ';
    const matches=[...new Set(title.split(' '))].flatMap(token=>aliases.get(token)??[])
     .filter(name=>padded.includes(' '+name+' '));
    const longest=Math.max(0,...matches.map(name=>name.length));
    branches=new Set(matches.filter(name=>name.length===longest).flatMap(name=>[...byName.get(name)??[]]));
   }
   const confirmed=[...branches??[]].filter(Boolean);
   if(confirmed.length===1&&branches?.size===1)result.set(task.id,confirmed[0]);
   if(confirmed.length>1)result.set(task.id,'На сверку');
  }
 }catch{
  // Missing or ambiguous client data stays in the unassigned group.
 }
 return result;
}
