import {readFile} from 'node:fs/promises';
import {assert,AppError} from './domain.js';
import {listCompanies} from './okb.js';
import type {User} from '../shared/types.js';

export const dadataConfigured=()=>!!(process.env.DADATA_API_KEY_FILE||process.env.DADATA_API_KEY);
let pending=0;
const lastQuery=new Map<string,number>();
const endpoint='https://suggestions.dadata.ru/suggestions/api/4_1/rs/';
type RegistryEntry={value?:string;data?:{inn?:string;kpp?:string;ogrn?:string;branch_type?:string;
 address?:{unrestricted_value?:string;value?:string};state?:{status?:string}}};
export async function suggestCompanies(actor:User,query:string){
 assert(dadataConfigured(),503,'Подсказки DaData ещё не подключены. Реквизиты можно заполнить вручную.');
 const now=Date.now();
 for(const [id,when] of lastQuery)if(now-when>1000)lastQuery.delete(id);
 assert(!lastQuery.has(actor.id)&&pending<4,429,'Подождите секунду и попробуйте снова.');
 lastQuery.set(actor.id,now);pending++;
 try{
  const key=(process.env.DADATA_API_KEY||await readFile(process.env.DADATA_API_KEY_FILE??'','utf8')).trim();
  assert(/^[a-zA-Z0-9_-]+$/.test(key),503,'DaData ещё не настроена.');
  const exact=/^(?:\d{10}|\d{12}|\d{13}|\d{15})(?:\/\d{9})?$/.test(query);
  const response=await fetch(endpoint+(exact?'findById/party':'suggest/party'),{
   method:'POST',headers:{Authorization:'Token '+key,'Content-Type':'application/json',Accept:'application/json'},
   body:JSON.stringify({query,count:7}),signal:AbortSignal.timeout(4500),redirect:'error'
  });
  if(!response.ok)throw new AppError(502,'DaData недоступна. Проверьте настройку и лимит или заполните реквизиты вручную.');
  const result=await response.json() as {suggestions?:RegistryEntry[]};
  const companies=await listCompanies(actor,query);
  const byInn=new Map(companies.map(company=>[company.tax_id,company.id]));
  return (result.suggestions??[]).filter(item=>item.value&&item.data?.inn&&(query.includes('/')||item.data.branch_type!=='BRANCH')).map(({value,data})=>({
   name:value!,taxId:data!.inn!,kpp:data!.kpp??null,ogrn:data!.ogrn??null,legalAddress:data!.address?.unrestricted_value??data!.address?.value??null,
   registryStatus:data!.state?.status??null,branch:data!.branch_type==='BRANCH',existingId:byInn.get(data!.inn!)??null
  }));
 }catch(error){
  if(error instanceof AppError)throw error;
  throw new AppError(502,'Не получили ответ DaData. Реквизиты можно заполнить вручную.');
 }finally{pending--;}
}
