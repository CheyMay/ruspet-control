import {readFile,stat,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {assert} from './domain.js';
type Credentials={portal:string;member_id:string;client_id:string;client_secret:string;access_token:string;refresh_token:string;expires:number};
export async function readApplicationCredentials(file:string,portal:string):Promise<Credentials>{
 const info=await stat(file);assert(info.isFile()&&(info.mode&0o077)===0,503,'Файл OAuth должен быть закрытым (0600).');
 let value:Credentials;try{value=JSON.parse(await readFile(file,'utf8'));}catch{throw Error('Не удалось прочитать файл OAuth.');}
 assert(value&&typeof value==='object'&&!Array.isArray(value)&&value.portal===portal&&['member_id','client_id','client_secret','access_token','refresh_token'].every(k=>typeof value[k as keyof Credentials]==='string'&&String(value[k as keyof Credentials]).length>0)&&Number.isFinite(value.expires),503,'Проверьте поля и портал закрытого файла OAuth.');
 return value;
}
// Called under the portal REST advisory lock: rotating a refresh token is not retry-safe.
export async function applicationToken(file:string,portal:string,fetcher:typeof fetch=fetch){
 let credentials=await readApplicationCredentials(file,portal);
 const marker=file+'.refreshing';
 try{await stat(marker);throw Error('Предыдущее продление OAuth не подтверждено. Восстановите авторизацию вручную.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(credentials.expires>Date.now()/1000+120)return credentials;
 await writeFile(marker,'OAuth refresh started; reconcile before retry.\n',{flag:'wx',mode:0o600});
 const url=new URL('https://oauth.bitrix24.tech/oauth/token/');
 url.search=new URLSearchParams({grant_type:'refresh_token',client_id:credentials.client_id,client_secret:credentials.client_secret,refresh_token:credentials.refresh_token}).toString();
 let value:any;
 try{const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(15000)});assert(response.ok,503,'OAuth не подтвердил продление. Требуется восстановить авторизацию.');value=await response.json();}catch{throw Error('Продление OAuth не подтверждено. Повтор автоматически запрещён.');}
 assert(value.member_id===credentials.member_id&&value.client_endpoint===`https://${portal}/rest/`&&typeof value.access_token==='string'&&value.access_token&&typeof value.refresh_token==='string'&&value.refresh_token&&Number(value.expires)>Date.now()/1000,503,'OAuth вернул неподтверждённую авторизацию.');
 credentials={...credentials,access_token:value.access_token,refresh_token:value.refresh_token,expires:Number(value.expires)};
 const temporary=file+'.'+randomUUID()+'.pending';
 await writeFile(temporary,JSON.stringify(credentials),{flag:'wx',mode:0o600});
 await rename(temporary,file);await unlink(marker);return credentials;
}
