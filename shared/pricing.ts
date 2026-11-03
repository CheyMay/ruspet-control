import type {Task} from './types.js';
export const priceLabels={low:'Низкобюджетные',medium:'Средние',high:'Высокие',premium:'Премиум',unknown:'Цена не указана'} as const;
export type PriceBand=keyof typeof priceLabels;
export function parsePrice(value:unknown):number|null {
 if(value===null||value===undefined||value==='')return null;
 const text=String(value).trim().replace(/[\s\u00a0\u202f]/g,'').replace(/(?:₽|руб\.?|rub)$/i,'').replace(',','.');
 if(!/^\d+(?:\.\d{1,2})?$/.test(text))return null;
 const n=Number(text);return Number.isSafeInteger(Math.round(n*100))&&n<=999999999999.99?n:null;
}
export function taskPrice(t:Pick<Task,'price'|'source_fields'>){return parsePrice(t.price??t.source_fields?.['Цена задачи']);}
export function priceBand(t:Pick<Task,'price'|'source_fields'>):PriceBand{const n=taskPrice(t);return n===null?'unknown':n<5000?'low':n<55000?'medium':n<500000?'high':'premium';}
export function priceCounts(tasks:Task[]){const counts={low:0,medium:0,high:0,premium:0,unknown:0};for(const task of tasks)counts[priceBand(task)]++;return counts;}
export const formatPrice=(t:Pick<Task,'price'|'source_fields'>)=>taskPrice(t)===null?'Цена не указана':taskPrice(t)!.toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
export function priceSummary(tasks:Task[]){const c=priceCounts(tasks);return `${c.low} низкобюджетных · ${c.medium} средних · ${c.high} высоких · ${c.premium} премиум${c.unknown?' · '+c.unknown+' без цены':''}`;}
