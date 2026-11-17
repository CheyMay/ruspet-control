import type {ManagementNotice} from './types.js';
import type {ReportView} from './report-parameters.js';
export type ReportLink={text:string;url:string};
export function workdayReports(notice?:ManagementNotice|null){
 const reports:{id:string;label:string;view:ReportView}[]=[];
 if(notice?.kind==='workday'){
  if(notice.planReportId)reports.push({id:notice.planReportId,label:'План на следующий рабочий день',view:'mine'});
  if(notice.creatorReportId)reports.push({id:notice.creatorReportId,label:'Отчёт по поставленным задачам',view:'created'});
 }
 return reports;
}
export function taskLink(origin:string,params:{filter?:string;owner?:string;price?:string;report?:string;subset?:string;day?:string;task?:string;sort?:string}){
 const url=new URL(origin);url.search='';url.hash='';url.searchParams.set('view','tasks');for(const [key,value] of Object.entries(params))if(value)url.searchParams.set(key,value);return url.toString();
}
export function reportLink(origin:string,id:string,pdf=false){const url=new URL(origin);url.search='';url.hash='';url.searchParams.set('view','reports');url.searchParams.set('report',id);if(pdf)url.searchParams.set('format','pdf');return url.toString();}
export const escapeHtml=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function linkedText(text:string,links:ReportLink[]){let html=escapeHtml(text);for(const link of links)html=html.replace(escapeHtml(link.text),`<a href="${escapeHtml(link.url)}">${escapeHtml(link.text)}</a>`);return html;}
