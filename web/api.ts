export async function api<T>(path:string,method='GET',body?:unknown):Promise<T> {
 const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'Не удалось выполнить запрос.');return data;
}
