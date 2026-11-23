import assert from 'node:assert/strict';
import {test} from 'node:test';
import {taskBoard} from '../shared/task-board.js';
import type {Task} from '../shared/types.js';

const task=(id:string,deadline:string|null,status:Task['status']='active')=>({id,deadline,status});

test('board follows Moscow days and Monday–Sunday weeks, independent of the browser timezone',()=>{
 const now=new Date('2026-11-20T21:30:00Z'); // Saturday 00:30 in Moscow
 const tasks=[
  task('yesterday','2026-11-20T20:59:00Z'),
  task('elapsed','2026-11-20T21:05:00Z'),
  task('today','2026-11-21T09:00:00Z'),
  task('sunday','2026-11-22T20:59:00Z'),
  task('monday','2026-11-22T21:00:00Z'),
  task('next-sunday','2026-11-29T20:59:00Z'),
  task('later','2026-11-29T21:00:00Z'),
 ];
 const lanes=Object.fromEntries(taskBoard(tasks,now,new Set()).map(column=>[column.id,column.tasks.map(row=>row.id)]));
 assert.deepEqual(lanes.overdue,['yesterday','elapsed']);
 assert.deepEqual(lanes.today,['today']);
 assert.deepEqual(lanes.week,['sunday']);
 assert.deepEqual(lanes.nextWeek,['monday','next-sunday']);
 assert.deepEqual(lanes.later,['later']);
});

test('paused, reviewing and completed tasks keep their own lanes and are counted once',()=>{
 const old='2026-11-18T09:00:00Z';
 const tasks=[task('pending',old),task('review',old,'review'),task('completed',old,'completed'),task('none',null),task('invalid','N/A')];
 const lanes=Object.fromEntries(taskBoard(tasks,new Date('2026-11-20T10:00:00Z'),new Set(['pending'])).map(column=>[column.id,column.tasks.map(row=>row.id)]));
 assert.deepEqual(lanes.pending,['pending']);
 assert.deepEqual(lanes.review,['review']);
 assert.deepEqual(lanes.completed,['completed']);
 assert.deepEqual(lanes.noDeadline,['none','invalid']);
 assert.deepEqual(lanes.overdue,[]);
 assert.equal(Object.values(lanes).flat().length,tasks.length);
});
