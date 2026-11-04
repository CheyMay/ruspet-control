
// Draw Run: adapted from server/src/runtime.js and the standalone demo's rules.js.
// Keep value lookup and branching pure so preview and execution take the same route.
type Context=Record<string,unknown>;
export function getValueByPath(source:unknown,path:string):unknown{
 return path.split('.').reduce<unknown>((value,key)=>value!==null&&typeof value==='object'&&Object.hasOwn(value,key)?(value as Context)[key]:undefined,source);
}
export function renderTemplate(template:string,context:Context){
 return template.replace(/\{\{\s*([^}]+)\s*\}\}/g,(_,path:string)=>{
  const value=getValueByPath(context,path.trim());
  return typeof value==='string'||typeof value==='number'||typeof value==='boolean'?String(value):'';
 });
}
export function evaluateCondition(cfg:{field:string;operator:string;value:string},context:Context){
 const rawValue=getValueByPath(context,cfg.field),expected=renderTemplate(cfg.value,context);
 if(cfg.operator==='exists')return rawValue!==undefined&&rawValue!==null&&rawValue!=='';
 if(rawValue==null)return false;
 if(cfg.operator==='contains')return String(rawValue).toLowerCase().includes(expected.toLowerCase());
 if(cfg.operator==='=')return String(rawValue)===expected;
 if(cfg.operator==='!=')return String(rawValue)!==expected;
 return false;
}
export const chooseBranch=(cfg:Parameters<typeof evaluateCondition>[0],context:Context)=>evaluateCondition(cfg,context)?'yes':'no';
