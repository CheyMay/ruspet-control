/** Persist metadata, never short-lived download credentials. */
export function safeBitrixData(value:unknown):unknown{
 if(typeof value==='string'&&/[?&](?:auth|access_token|signature|_esd|token)=/i.test(value))return null;
 if(Array.isArray(value))return value.map(safeBitrixData);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|secret|password|download.?url|url.?(?:download|preview|show)|^viewerAttrs$|^auth$)/i.test(key)).map(([key,item])=>[key,safeBitrixData(item)]));
 return value;
}
