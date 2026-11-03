import type {Task} from './types.js';
import {taskCode} from './queues.js';

export const writtenRuleExamples=[
 'В задаче всегда должен быть буквенный код',
 'В задаче должен быть крайний срок',
 'Описание задачи должно содержать не менее 30 символов',
] as const;
export type WrittenRule={text:string;severity:'critical'|'warning'|'info'};
// Deliberately finite grammar: unsupported prose must never become a silently inactive rule.
export function parseWrittenRule(text:string):{label:string;violates:(task:Task)=>boolean}|null {
 const value=text.toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[.,!]/g,'').replace(/\s+/g,' ').trim();
 if(['в задаче всегда должен быть буквенный код','в задаче должен быть буквенный код','в названии задачи должен быть буквенный код'].includes(value))return {label:'Буквенный код обязателен для каждой задачи',violates:t=>!taskCode(t.title).valid};
 if(['в задаче должен быть крайний срок','в задаче всегда должен быть крайний срок'].includes(value))return {label:'Крайний срок обязателен',violates:t=>!t.deadline};
 const description=value.match(/^описание задачи должно содержать не менее (\d{1,4}) символов$/);
 if(description&&Number(description[1])>=1&&Number(description[1])<=4000){const n=Number(description[1]);return {label:`Описание короче ${n} символов`,violates:t=>t.description.trim().length<n};}
 return null;
}
