import type {Bootstrap} from '../shared/types.js';

const viewAsPrefix='/view-as/';
export const viewAs=typeof location!=='undefined'&&location.pathname.startsWith(viewAsPrefix)
 ? location.pathname.slice(viewAsPrefix.length)
 : null;
export const viewAsLink=(id:string)=>viewAsPrefix+encodeURIComponent(id);
export const workspaceUrl=()=>viewAs===null?location.origin:location.origin+location.pathname;

export class ApiError extends Error {
 constructor(message:string,readonly status?:number){super(message);}
 get unconfirmed(){return this.status===undefined||this.status>=500;}
}

type Snapshot={data:Bootstrap;version:string|null};
type RequestOptions={timeout?:number;key?:string;version?:string|null};
async function request<T>(path:string,method:string,body:unknown,{timeout,key,version}:RequestOptions={}){
 const controller=timeout?new AbortController():undefined;
 const timer=controller?setTimeout(()=>controller.abort(),timeout):undefined;
 const headers:Record<string,string>={};
 if(body!==undefined)headers['Content-Type']='application/json';
 if(viewAs!==null)headers['X-Ruspet-View-As']=viewAs;
 if(key)headers['Idempotency-Key']=key;
 if(version)headers['X-Ruspet-Workspace-Version']=version;
 try{
  const response=await fetch('/api'+path,{method,credentials:'same-origin',headers,signal:controller?.signal,
   body:body===undefined?undefined:JSON.stringify(body)});
  if(response.status===204&&version)return {response,data:undefined};
  const json=response.headers.get('Content-Type')?.includes('application/json');
  if(!response.ok){
   const error=json?await response.json().catch(()=>null):null;
   const fallback=response.status>=500?'Сервис временно недоступен. Попробуйте ещё раз.':
    response.status===401?'Сессия завершена. Войдите снова.':'Не удалось выполнить запрос.';
   throw new ApiError(error?.error||fallback,response.status);
  }
  if(!json)throw new ApiError('Сервис вернул неожиданный ответ. Попробуйте ещё раз.');
  return {response,data:await response.json() as T};
 }catch(error){
  if(error instanceof ApiError)throw error;
  throw new ApiError(controller?.signal.aborted?'Сервис не ответил вовремя. Попробуйте ещё раз.':
   'Не удалось связаться с сервисом. Проверьте подключение и попробуйте ещё раз.');
 }finally{clearTimeout(timer);}
}

export async function api<T>(path:string,method='GET',body?:unknown,options?:RequestOptions):Promise<T> {
 const {data}=await request<T>(path==='/bootstrap'?'/bootstrap?view=workspace':path,method,body,options);
 return data as T;
}

export async function loadWorkspace(previous?:Snapshot):Promise<Snapshot>{
 const {response,data}=await request<Bootstrap>('/bootstrap?view=workspace','GET',undefined,{timeout:10000,version:previous?.version});
 if(response.status===204&&previous){
  const serverTime=response.headers.get('X-Ruspet-Server-Time');
  if(!serverTime)throw new ApiError('Сервис не подтвердил время обновления данных.');
  return {...previous,data:{...previous.data,serverTime}};
 }
 if(!data)throw new ApiError('Сервис не вернул данные.');
 return {data,version:response.headers.get('X-Ruspet-Workspace-Version')};
}
