import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compactTaskTitle} from '../shared/task-title.js';
import {botTextPages,botDue,botTaskStatus,botExcerpt,sortBotTasks} from '../server/bot-presentation.js';
import type {Task} from '../shared/types.js';

test('task labels remove only leading boilerplate and retain codes, negations and reference numbers',()=>{
 assert.equal(compactTaskTitle('РЗМ* Задача: Необходимо   проверить макет'),'РЗМ* проверить макет');
 assert.equal(compactTaskTitle('Не отправлять заказ без согласования'),'Не отправлять заказ без согласования');
 const title='РЗМ* Необходимо подготовить подробную документацию по условиям очередной поставки комплектующих для производства, не отгружать без согласования по заказу №1742 — крышка 28 мм';
 const label=compactTaskTitle(title,110);
 assert(label.startsWith('РЗМ* подготовить'));assert(label.includes('не отгружать'));assert(label.includes('без согласования'));assert(label.includes('№1742'));assert(label.includes('28'));assert(label.includes('…'));assert(label.length<=110);
 for(const word of label.replace(/…/g,'').split(/\s+/).filter(Boolean))assert(title.includes(word),word);
});

test('short labels are deterministic and distinguish long tasks by their references',()=>{
 const title='Проверить комплект документов и требования к качеству продукции для следующего производственного заказа '.repeat(3);
 const a=compactTaskTitle(title+'№9811'),b=compactTaskTitle(title+'№9812');
 assert.notEqual(a,b);assert(a.includes('9811'));assert(b.includes('9812'));assert.equal(a,compactTaskTitle(title+'№9811'));
 assert.equal(compactTaskTitle('   '),'Без названия');
 assert(compactTaskTitle('🧰'.repeat(100),47).length<=47);
 const action=compactTaskTitle('РЗМ* Необходимо подготовить и согласовать макет для тестового заказа №1742 — синяя крышка 28 мм',68);
 assert(action.includes('макет'));assert(action.includes('№1742'));
});

test('bot text pagination preserves all content and never splits surrogate pairs',()=>{
 const text=('Большой абзац с результатом и номером №345. 🧰\n\n').repeat(300)+'Последняя важная строка';
 const pages=botTextPages(text);assert(pages.length>1);assert.equal(pages.join(''),text);
 for(const page of pages){assert(page.length<=2400);assert(!/[\uD800-\uDBFF]$/.test(page));assert(!/^[\uDC00-\uDFFF]/.test(page));}
 const unbroken='🧰'.repeat(3000);assert.equal(botTextPages(unbroken,101).join(''),unbroken);
});

test('list deadlines follow Moscow days and completed tasks are sorted after open tasks',()=>{
 const now=new Date('2026-11-12T21:30:00Z');
 const make=(id:string,deadline:string|null,status:Task['status']='active')=>({id,deadline,status} as Task);
 assert.equal(botDue(make('1','2026-11-12T22:00:00Z'),now),'Сегодня 01:00');
 assert.equal(botTaskStatus(make('1','2026-11-12T20:59:00Z'),now),'Просрочена');
 assert.equal(botTaskStatus(make('1','2026-11-12T21:05:00Z'),now),'Срок сегодня прошёл');
 assert.equal(botTaskStatus(make('1','2026-11-12T20:59:00Z','review'),now),'На приёмке');
 assert.equal(botTaskStatus(make('1',null),now,true),'На согласовании');
 assert.equal(botTaskStatus(make('1',null,'completed'),now),'Завершена');
 assert.equal(botDue(make('1',null),now),'Без срока');
 const tasks=[make('3',null,'completed'),make('2','2026-11-12T22:00:00Z'),make('1','2026-11-12T20:59:00Z')];
 assert.deepEqual(sortBotTasks(tasks,now).map(t=>t.id),['1','2','3']);assert.equal(tasks[0].id,'3');
});

test('task description excerpts collapse spacing and stop at a complete character',()=>{
 assert.equal(botExcerpt(' Проверить\n\nкрышку 28 мм ',100),'Проверить крышку 28 мм');
 const preview=botExcerpt('Проверить образцы крышки перед отправкой на производство',34);
 assert.equal(preview,'Проверить образцы крышки перед…');
 assert.match(botExcerpt('🧰'.repeat(100),10),/^(?:🧰){4}…$/u);
});
