import type {Db} from './db.js';
import type {Task,User} from '../shared/types.js';
import type {AnalyticsAccess,AnalyticsGroup} from '../shared/team-analytics.js';
import {branchCovers,unassignedBranch} from '../shared/branches.js';
import {isSalesManager} from '../shared/personal-calendar.js';
import {exclusionReason} from '../shared/task-selection.js';
import {assert} from './domain.js';

type Person=User&{manager_id:string|null;departments:string[]};
const leader=(u:User)=>/руководител|директор|начальник/iu.test(u.position);
const salesDepartments=new Set(['преформа','aquas','аналитики','продажи','! рук филиала']);
const salesBranches=['Крым','Краснодар','AQUAS','Головной офис / Продажи'];
const salesUnit=(branch:string)=>salesBranches.includes(branch);
const salesPerson=(u:Person)=>u.role==='sales_head'||isSalesManager(u)||
 u.departments.some(value=>salesDepartments.has(value.toLocaleLowerCase('ru-RU').trim()));

export async function analyticsAccess(user:User,db:Db):Promise<AnalyticsAccess|null>{
 if(user.role==='director'||user.root_access)return 'company';
 if(user.sales_analytics_access||user.role==='sales_head')return 'sales';
 if(user.role==='branch_manager')return 'team';
 if(!leader(user))return null;
 const hasTeam=(await db.query('SELECT 1 FROM org_reporting WHERE manager_id=$1 LIMIT 1',[user.id])).rowCount;
 return hasTeam?'team':null;
}

export async function loadAnalyticsScope(user:User,db:Db){
 const access=await analyticsAccess(user,db);
 assert(access,403,'Аналитика доступна руководителям в пределах их зоны ответственности.');
 const people=(await db.query<Person>(`SELECT u.*,r.manager_id,
  ARRAY(SELECT DISTINCT s.department FROM staff_directory s WHERE s.user_id=u.id AND s.enabled) departments
  FROM users u LEFT JOIN org_reporting r ON r.employee_id=u.id`)).rows;
 const byId=new Map(people.map(person=>[person.id,person]));
 const reports=new Map<string,Person[]>();
 for(const p of people){
  if(p.manager_id)reports.set(p.manager_id,[...(reports.get(p.manager_id)??[]),p]);
 }
 const immediate=new Map<string,Person>();
 for(const direct of reports.get(user.id)??[]){
  const remaining=[direct];
  while(remaining.length){
   const p=remaining.pop()!;
   if(p.id===user.id||immediate.has(p.id))continue;
   immediate.set(p.id,direct);
   remaining.push(...reports.get(p.id)??[]);
  }
 }
 const sales=new Set(people.filter(salesPerson).map(p=>p.id));
 const salesLead=access==='team'&&sales.has(user.id)&&salesUnit(user.branch_id);
 const leadershipByBranch=new Map<string,Person>();
 for(const p of people.filter(p=>sales.has(p.id)&&salesUnit(p.branch_id)&&leader(p))){
  const existing=leadershipByBranch.get(p.branch_id);
  if(!existing||(reports.get(p.id)?.length??0)>(reports.get(existing.id)?.length??0))leadershipByBranch.set(p.branch_id,p);
 }
 for(const branch of salesBranches){
  if(leadershipByBranch.has(branch))continue;
  const managers=new Set(people.filter(p=>p.branch_id===branch&&sales.has(p.id)&&p.manager_id).map(p=>p.manager_id!));
  if(managers.size!==1)continue;
  const manager=byId.get([...managers][0]);
  if(manager&&!manager.root_access&&(manager.role==='director'||manager.role==='sales_head'))leadershipByBranch.set(branch,manager);
 }
 const directBranches=new Set([user.branch_id]);
 if(salesLead)for(const p of immediate.values())if(sales.has(p.id)&&salesUnit(p.branch_id))directBranches.add(p.branch_id);
 const companyTask=(t:Task)=>!byId.get(t.assignee_id)?.root_access&&t.branch_id!=='Учебный доступ';
 const visible=(t:Task)=>{
  if(exclusionReason(t)||!companyTask(t))return false;
  if(access==='company')return true;
  if(access==='sales')return sales.has(t.assignee_id)&&!(/\/\s*Склад(?:\s|$)/iu.test(t.branch_id));
  if(t.assignee_id===user.id)return true;
  const assignee=byId.get(t.assignee_id);
  if(salesLead&&assignee&&sales.has(assignee.id)){
   if(salesUnit(t.branch_id))return directBranches.has(t.branch_id)&&(immediate.has(assignee.id)||assignee.branch_id===unassignedBranch||
    immediate.size===0&&assignee.branch_id===t.branch_id);
   if(assignee.branch_id===unassignedBranch)return false;
  }
  if(immediate.has(t.assignee_id))return true;
  return immediate.size===0&&user.role==='branch_manager'&&!!assignee&&
   branchCovers(user.branch_id,assignee.branch_id)&&branchCovers(user.branch_id,t.branch_id);
 };
 function path(t:Task):AnalyticsGroup[]{
  const p=byId.get(t.assignee_id);
  const employee={key:'person:'+t.assignee_id,label:p?.name??'Сотрудник',caption:p?.position};
  if(access==='team'){
   const first=immediate.get(t.assignee_id);
   return first&&first.id!==t.assignee_id?[{key:'team:'+first.id,label:'Команда · '+first.name,caption:first.position},employee]:[employee];
  }
  if(sales.has(t.assignee_id)&&!(/\/\s*Склад(?:\s|$)/iu.test(t.branch_id))){
   const branch=salesUnit(t.branch_id)?t.branch_id:t.branch_id===unassignedBranch&&p&&salesUnit(p.branch_id)?p.branch_id:'На сверку';
   const head=leadershipByBranch.get(branch);
   const group={key:'branch:'+branch,label:branch,caption:head?'Руководитель · '+head.name:undefined};
   return access==='sales'?[group,employee]:[{key:'department:Продажи',label:'Продажи'},group,employee];
  }
  const branch=t.branch_id!==unassignedBranch?t.branch_id:p?.branch_id??unassignedBranch;
  const [department]=branch.split(' / ');
  return [{key:'department:'+department,label:department===unassignedBranch?'Подразделение на сверку':department},employee];
 }
 return {access,label:access==='company'?'Вся компания':access==='sales'?'Продажи':'Моя команда',visible,path,byId};
}

export type AnalyticsScope=Awaited<ReturnType<typeof loadAnalyticsScope>>;
