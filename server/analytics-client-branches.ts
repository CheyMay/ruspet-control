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
 const unresolved=tasks.filter(task=>task.branch_id===unassignedBranch||!task.branch_id);
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
  for(const task of clients){
   const known=new Set((task.client_refs??[]).map(client=>byId.get(client.id)??''));
   const branches=known.size?known:byName.get(nameKey(importedTaskClient(task.source_fields?.['Компания'])));
   if(branches?.size===1){
    const branch=[...branches][0];
    if(branch)result.set(task.id,branch);
   }
  }
 }catch{
  // Missing or ambiguous client data stays in the unassigned group.
 }
 return result;
}
