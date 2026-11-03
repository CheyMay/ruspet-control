import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePrice,taskPrice,priceBand,priceCounts} from '../shared/pricing.js';
import {frontTasks,summarizeWork} from '../shared/report-summary.js';
import {stateAt} from '../server/reports-v5.js';
import {taskLink,linkedText} from '../shared/report-links.js';
import type {Task,User,Event} from '../shared/types.js';
const task=(values:Partial<Task>={}):Task=>({id:'T1',title:'РЗМ* Проверка',description:'Описание',branch_id:'B',assignee_id:'worker',creator_id:'boss',deadline:'2035-01-01T12:00:00Z',original_deadline:null,planned_end:null,status:'active',priority:'normal',code:'РЗМ*',important:true,customer_risk:false,version:1,transfer_count:0,created_at:'2034-12-01T00:00:00Z',updated_at:'2034-12-01T00:00:00Z',completed_at:null,...values});

test('price boundaries, zero, missing source prices and localized money are distinct',()=>{
 for(const [price,expected] of [[0,'low'],[4999.99,'low'],[5000,'medium'],[54999.99,'medium'],[55000,'high'],[499999.99,'high'],[500000,'premium']] as const)assert.equal(priceBand(task({price})),expected);
 assert.equal(taskPrice(task({source_fields:{'Цена задачи':55000}})),55000);assert.equal(taskPrice(task({price:0,source_fields:{'Цена задачи':55000}})),0);
 assert.equal(priceBand(task()),'unknown');assert.equal(parsePrice('55 000,50 ₽'),55000.5);assert.equal(parsePrice('-1'),null);assert.equal(parsePrice('5к'),null);assert.equal(parsePrice('1.001'),null);assert.equal(parsePrice('Infinity'),null);
 assert.deepEqual(priceCounts([task({price:0}),task({price:500000}),task()]),{low:1,medium:0,high:0,premium:1,unknown:1});
});
test('work-front outcomes use fixed morning IDs, exclude reminder acknowledgements and distinguish the person acting',()=>{
 const old=task({price:5000}),closed=task({price:5000,status:'completed',version:3}),late=task({id:'T2',price:500000,deadline:'2034-12-31T12:00:00Z'}),future=task({id:'T3',deadline:'2035-01-03T12:00:00Z'}),now=new Date('2035-01-01T12:00:00+03:00');
 assert.deepEqual(frontTasks([old,late,future], '2035-01-01').map(t=>t.id),['T1','T2']);
 const events:Event[]=[{id:'E1',task_id:'T1',actor_id:'boss',kind:'task_completed',message:'Принято',data:{before:old,after:closed},created_at:'2035-01-01T10:00:00+03:00'},{id:'E2',task_id:'T2',actor_id:'worker',kind:'reminder_acknowledged',message:'ОК',data:{},created_at:'2035-01-01T11:00:00+03:00'}];
 const users=[{id:'worker',name:'Сотрудник',role:'employee',branch_id:'B',position:'Менеджер'},{id:'boss',name:'Руководитель',role:'director',branch_id:'B',position:'Директор'}] as User[];
 const summary=summarizeWork([closed,late],users,events,{},new Date('2035-01-01T00:00:00+03:00'),now,[{user_id:'worker',day:'2035-01-01',captured_at:'2035-01-01T09:00:00+03:00',rows:[old,late]}],'2034-12-01T00:00:00Z',true,[closed,late,future]);
 assert.equal(summary.activity.processed,1);assert.equal(summary.activity.closed,1);assert.equal(summary.front.total,2);assert.equal(summary.front.closed,1);assert.equal(summary.front.remaining,1);assert.equal(summary.team.find(t=>t.id==='worker')!.closed,1);assert.equal(summary.team.find(t=>t.id==='boss')!.closedByActor,1);assert.equal(summary.trend.find(b=>b.label==='10:00')!.closed,1);assert.equal(summary.trend.at(-1)!.cumulativeClosed,1);
});
test('historical state rolls back actual changes and never invents pre-import state',()=>{
 const before=task({price:4999}),after=task({price:55000,version:2});
 const event:Event={id:'E',task_id:'T1',actor_id:'boss',kind:'task_edited',message:'Цена',data:{before,after},created_at:'2035-01-01T12:00:00+03:00'};
 assert.equal(taskPrice(stateAt(after,[event],new Date('2035-01-01T11:00:00+03:00'))!),4999);
 assert.equal(stateAt(after,[{...event,kind:'imported'}],new Date('2035-01-01T11:00:00+03:00')),null);
});
test('task/report hyperlinks have no credentials and escape malicious labels',()=>{
 const url=taskLink('https://cheymay.ru',{report:'r',subset:'overdue',owner:'person-id',price:'premium'}),q=new URL(url).searchParams;assert.equal(q.get('view'),'tasks');assert.equal(q.get('price'),'premium');assert.equal(q.get('owner'),'person-id');assert(!url.includes('token'));
 const html=linkedText('Закрыто: 10 <script>alert(1)</script>',[{text:'Закрыто: 10',url}]);assert(html.includes('<a href='));assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));
});
