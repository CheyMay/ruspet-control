import type {Task} from './types.js';
/** Business selection, independent of deadline and completion. Do not infer checklist completion. */
export function exclusionReason(task:Pick<Task,'title'>):'checklist'|'unfinished_analysis'|null{
 const title=(task.title||'').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[‐‑‒–—−]/g,'-').replace(/\s+/g,' ');
 if(/(?:^|[^а-яa-z])чек[ -]*лист[а-я]*(?=$|[^а-яa-z])/.test(title))return 'checklist';
 if(/(?:^|[^а-я])анализ(?:а|ом|у|е)?\s+не\s*выполненн[а-я]*\s+задач[а-я]*(?=$|[^а-я])/.test(title))return 'unfinished_analysis';
 return null;
}
