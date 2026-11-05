import {assert} from './domain.js';
import type {BitrixMethod} from './bitrix-rest.js';
export type ArchiveCall={method:BitrixMethod;params:object;path?:string;mode:'keyset'|'offset'|'all'|'messages'|'fields';idKey?:string};
export const initialResources=['task_fields','company_fields','contact_fields','deal_fields','lead_fields','crm_requisite_fields','crm_requisite_bank_fields','crm_address_fields','users','departments','projects','tasks','company','contact','deal','lead','crm_status','crm_types','crm_requisite','crm_requisite_bank','crm_address'] as const;
export const taskParts=['task_history','task_results','task_checklist','task_time','task_comments'] as const;
export function archiveCall(resource:string,id:string,cursor:Record<string,any>,selection:string[]=[]):ArchiveCall{
 const after=String(cursor.after||'0'),start=Number(cursor.start||0);
 assert(/^\d+$/.test(after)&&Number.isSafeInteger(start)&&start>=0,400,'Некорректный курсор загрузки.');
 const select=['*','UF_*',...selection],taskSelect=['*',...selection,'UF_CRM_TASK','UF_TASK_WEBDAV_FILES','CHAT_ID','RELATED_TASKS'];
 if(resource==='crm_requisite_fields')return {method:'crm.requisite.fields',params:{},mode:'fields'};
 if(resource==='crm_requisite_bank_fields')return {method:'crm.requisite.bankdetail.fields',params:{},mode:'fields'};
 if(resource==='crm_address_fields')return {method:'crm.address.fields',params:{},mode:'fields'};
 if(resource==='task_fields')return {method:'tasks.task.getFields',params:{},mode:'fields'};
 if(/^(company|contact|deal|lead)_fields$/.test(resource))return {method:`crm.${resource.split('_')[0]}.fields` as BitrixMethod,params:{},mode:'fields'};
 if(resource==='users')return {method:'user.get',params:{SORT:'ID',ORDER:'ASC',FILTER:{'>ID':after},ADMIN_MODE:true,select:['*','UF_*'],start:-1},mode:'keyset',idKey:'ID'};
 if(resource==='departments')return {method:'department.get',params:{SORT:'ID',ORDER:'ASC',START:start},mode:'offset',idKey:'ID'};
 if(resource==='projects')return {method:'sonet_group.get',params:{ORDER:{ID:'ASC'},FILTER:{'>ID':after},IS_ADMIN:'Y',start:-1},mode:'keyset',idKey:'ID'};
 if(resource==='tasks')return {method:'tasks.task.list',params:{order:{ID:'ASC'},filter:{'>ID':after},select:taskSelect,params:{WITH_RESULT_INFO:true,WITH_TIMER_INFO:true,WITH_PARSED_DESCRIPTION:true},start:-1},path:'tasks',mode:'keyset',idKey:'id'};
 if(['company','contact','deal','lead'].includes(resource))return {method:`crm.${resource}.list` as BitrixMethod,params:{order:{ID:'ASC'},filter:{'>ID':after},select,start:-1},mode:'keyset',idKey:'ID'};
 if(resource==='crm_status')return {method:'crm.status.list',params:{order:{ID:'ASC'},filter:{'>ID':after},start:-1},mode:'keyset',idKey:'ID'};
 if(resource==='crm_types')return {method:'crm.type.list',params:{order:{id:'ASC'},filter:{'>id':after},start:-1},path:'types',mode:'keyset',idKey:'id'};
 if(resource==='crm_requisite')return {method:'crm.requisite.list',params:{order:{ID:'ASC'},filter:{'>ID':after},select:selection,start:-1},mode:'keyset',idKey:'ID'};
 if(resource==='crm_requisite_bank')return {method:'crm.requisite.bankdetail.list',params:{order:{ID:'ASC'},filter:{'>ID':after},select:selection,start:-1},mode:'keyset',idKey:'ID'};
 // Addresses have a compound key; ID keyset navigation does not apply.
 if(resource==='crm_address')return {method:'crm.address.list',params:{order:{ENTITY_ID:'ASC',TYPE_ID:'ASC'},start},mode:'offset'};
 const smart=resource.match(/^smart(_fields)?:(\d+)$/);
 if(smart)return smart[1]?{method:'crm.item.fields',params:{entityTypeId:smart[2],useOriginalUfNames:'Y'},mode:'fields'}:{method:'crm.item.list',params:{entityTypeId:smart[2],order:{id:'ASC'},filter:{'>id':after},select:['*'],useOriginalUfNames:'Y',start:-1},path:'items',mode:'keyset',idKey:'id'};
 assert(/^[1-9]\d{0,17}$/.test(id),400,'Нужен ID объекта для загрузки.');
 if(resource==='user_one')return {method:'user.get',params:{FILTER:{ID:id},ADMIN_MODE:true,select:['*','UF_*']},mode:'all'};
 if(resource==='project_one')return {method:'sonet_group.get',params:{FILTER:{ID:id},IS_ADMIN:'Y'},mode:'all'};
 if(/^(company|contact|deal|lead)_one$/.test(resource))return {method:`crm.${resource.split('_')[0]}.get` as BitrixMethod,params:{id},mode:'all'};
 if(/^smart_one:\d+$/.test(resource))return {method:'crm.item.get',params:{entityTypeId:resource.split(':')[1],id},path:'item',mode:'all'};
 if(resource==='task'||resource==='task_detail')return {method:'tasks.task.get',params:{taskId:id,select:taskSelect},path:'task',mode:'all'};
 if(resource==='task_history')return {method:'tasks.task.history.list',params:{taskId:id},mode:'all'};
 if(resource==='task_results')return {method:'tasks.task.result.list',params:{taskId:id,params:{WITH_USER_INFO:'Y',WITH_FILE_INFO:'Y'}},mode:'all'};
 if(resource==='task_checklist')return {method:'task.checklistitem.getlist',params:{TASKID:id,ORDER:{ID:'ASC'}},mode:'all'};
 if(resource==='task_time')return {method:'task.elapseditem.getlist',params:[id,{ID:'asc'},{},['*'],{NAV_PARAMS:{nPageSize:50,iNumPage:Math.floor(start/50)+1}}],mode:'offset',idKey:'ID'};
 if(resource==='task_comments'){
  assert(cursor.chatId,409,'Чат задачи не определён. Выберите старую карточку явно, если она используется.');
  return {method:'im.dialog.messages.get',params:{DIALOG_ID:'chat'+cursor.chatId,LIMIT:50,...(cursor.forward?(cursor.afterMessage?{FIRST_ID:cursor.afterMessage}:{}):(cursor.before?{LAST_ID:cursor.before}:{}))},path:'messages',mode:'messages',idKey:'id'};
 }
 if(resource==='task_legacy_comments')return {method:'task.commentitem.getlist',params:{TASKID:id,ORDER:{ID:'asc'},FILTER:{'>ID':after}},mode:'all'};
 if(resource==='project_members')return {method:'sonet_group.user.get',params:{ID:id},mode:'all'};
 if(/^(company|deal|lead)_contacts$/.test(resource))return {method:('crm.'+resource.split('_')[0]+'.contact.items.get') as BitrixMethod,params:{id},mode:'all'};
 if(/^(deal|lead)_products$/.test(resource))return {method:('crm.'+resource.split('_')[0]+'.productrows.get') as BitrixMethod,params:{id},mode:'all'};
 const timeline=resource.match(/^(company|contact|deal|lead)_timeline$/);
 if(timeline)return {method:'crm.timeline.comment.list',params:{filter:{ENTITY_TYPE:timeline[1],ENTITY_ID:id},order:{ID:'ASC'},select:['*'],start},mode:'offset',idKey:'ID'};
 const activity=resource.match(/^(company|contact|deal|lead)_activities$/);
 if(activity)return {method:'crm.activity.list',params:{filter:{OWNER_TYPE_ID:({company:4,contact:3,deal:2,lead:1} as Record<string,number>)[activity[1]],OWNER_ID:id,'>ID':after},order:{ID:'ASC'},select:['*','COMMUNICATIONS','FILES'],start:-1},mode:'keyset',idKey:'ID'};
 if(resource==='attached_file')return {method:'disk.attachedObject.get',params:{id},mode:'all'};
 if(resource==='file')return {method:'disk.file.get',params:{id},mode:'all'};
 throw Error('Неизвестный раздел загрузки.');
}
