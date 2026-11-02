import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exclusionReason} from '../shared/task-selection.js';
test('exclude checklist titles and unfinished-task analysis, including inflected source titles',()=>{
 for(const title of ['ЕЗМ* Свериться с УТРЕННИМ чек-листом','ДНЕВНОЙ ЧЕК‑ЛИСТ','чек лист','Проверить чеклист'])assert.equal(exclusionReason({title}),'checklist');
 for(const title of ['Анализ невыполненных задач','ЕЗМ* Займись анализом невыполненных задач за сегодня','Анализ не выполненных задач'])assert.equal(exclusionReason({title}),'unfinished_analysis');
 for(const title of ['Анализ продаж','Согласовать задачу','Проверить чек оплаты','Проверить список задач'])assert.equal(exclusionReason({title}),null);
});
