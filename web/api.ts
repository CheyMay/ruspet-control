const viewAsPrefix='/view-as/';
export const viewAs=typeof location!=='undefined'&&location.pathname.startsWith(viewAsPrefix)
 ? location.pathname.slice(viewAsPrefix.length)
 : null;
export const viewAsLink=(id:string)=>viewAsPrefix+encodeURIComponent(id);
export const workspaceUrl=()=>viewAs===null?location.origin:location.origin+location.pathname;

export async function api<T>(path:string,method='GET',body?:unknown):Promise<T> {
 const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:{...(body?{'Content-Type':'application/json'}:{}),...(viewAs!==null?{'X-Ruspet-View-As':viewAs}:{})},body:body?JSON.stringify(body):undefined});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'Не удалось выполнить запрос.');return data;
}
