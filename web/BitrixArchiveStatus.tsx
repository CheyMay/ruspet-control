import {useEffect,useState} from 'react';
import {api} from './api.js';
type Status={run:{id:string;state:string;scope:{files:string}}|null;complete?:boolean;pending?:number;sections:{resource:string;state:string;count:number}[];issues:{id:string;resource:string;external_id:string;error:string}[];limitations?:string[]};
type Selected={expected_name:string;ready:boolean;matches:{id:string;role:string;external_id:string|null}[]};
const sectionNames:Record<string,string>={users:'Сотрудники',departments:'Подразделения',projects:'Проекты',tasks:'Задачи',task_detail:'Полные карточки задач',task_list:'Первичный список задач',task:'Обновление задач',company:'Компании',contact:'Контакты',deal:'Сделки',lead:'Лиды',task_comments:'Обсуждения задач',task_legacy_comments:'Старые комментарии задач',task_history:'История задач',task_results:'Результаты задач',task_checklist:'Чек-листы',task_time:'Затраченное время',attached_file:'Привязки файлов',file:'Метаданные файлов',file_blob:'Содержимое файлов',crm_status:'Справочники CRM',crm_types:'Типы смарт-процессов',crm_requisite:'Реквизиты',crm_requisite_bank:'Банковские реквизиты',crm_address:'Адреса'};
const label=(resource:string)=>sectionNames[resource]||(resource==='unresolved_file'?'Файлы с неизвестной привязкой':resource.includes('fields')?'Описание полей':resource.includes('timeline')?'Комментарии CRM':resource.includes('activities')?'Дела CRM':resource.includes('smart')?'Смарт-процессы':resource==='company_contacts'?'Связи компаний и контактов':'Дополнительные данные');
export function BitrixArchiveStatus(){
 const [status,setStatus]=useState<Status|null>(null),[selected,setSelected]=useState<Selected[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function refresh(){setBusy(true);try{const [next,people]=await Promise.all([api<Status>('/system/bitrix-archive'),api<Selected[]>('/system/selected-managers')]);setStatus(next);setSelected(people);setError('');}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
 useEffect(()=>{void refresh();},[]);
 const groups=new Map<string,{done:number;pending:number;blocked:number}>();
 for(const item of status?.sections||[]){const name=label(item.resource),group=groups.get(name)||{done:0,pending:0,blocked:0};if(item.state==='done')group.done+=item.count;else if(['blocked','failed'].includes(item.state))group.blocked+=item.count;else group.pending+=item.count;groups.set(name,group);}
 return <section className="panel automation-settings"><div className="automation-heading"><div><h2>Первоначальная загрузка Битрикс24</h2><p className="muted">Данные загружаются в архив с сохранением прогресса. Перенос в рабочие задачи выполняется отдельно после сверки.</p></div><button className="button secondary" disabled={busy} onClick={()=>void refresh()}>Обновить состояние</button></div>
  {error&&<p role="alert" className="alert error">{error}</p>}
  {!status&&!error&&<p role="status">Проверяем состояние загрузки…</p>}
  {status&&!status.run&&<p>Загрузка ещё не запускалась. Сначала нужны доступ к порталу и настроенный приём событий.</p>}
  {selected.length>0&&<div><h3>Первые менеджеры пилота</h3>{selected.map(person=><p key={person.expected_name}>{person.expected_name} · {person.ready?'Профиль и ID Битрикс24 подтверждены':person.matches.length===1?'Профиль найден, проверьте роль и привязку Битрикс24':'Нужно однозначно выбрать профиль сотрудника'}</p>)}</div>}
  {status?.run&&<><p><strong>{status.complete?'Первоначальный архив готов':status.run.state==='paused'?'Загрузка приостановлена':status.run.state==='captured'?'Обход завершён: проверяем пропуски и события':'Загрузка выполняется'}</strong> · обновлений по событиям в очереди: {status.pending||0}</p><p className="muted">Файлы: {status.run.scope.files==='binary'?'метаданные и содержимое':'только метаданные'}</p>
   <div className="table-scroll"><table><thead><tr><th>Раздел</th><th>Завершено шагов</th><th>В очереди</th><th>Требуют внимания</th></tr></thead><tbody>{[...groups].map(([name,counts])=><tr key={name}><td>{name}</td><td>{counts.done}</td><td>{counts.pending}</td><td>{counts.blocked}</td></tr>)}</tbody></table></div>
   {status.issues.map(issue=><p key={issue.id} className="red-text">{label(issue.resource)} · #{issue.external_id}: {issue.error}</p>)}
   {status.limitations?.map(text=><p className="muted" key={text}>{text}</p>)}
  </>}
 </section>;
}
