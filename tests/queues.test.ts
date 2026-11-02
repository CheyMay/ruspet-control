import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskQueue,elapsedToday,taskCode} from '../shared/queues.js';
import type {Task} from '../shared/types.js';
import {summarize,plannedMinutesOn} from '../shared/analytics.js';
import {nextRuns} from '../shared/schedule.js';
import {reportAnalysis} from '../shared/reporting.js';
const now=new Date('2026-10-30T10:00:00+03:00');
const task=(deadline:string|null,status='active')=>({deadline,status} as Task);
test('yesterday, today, upcoming and review are disjoint, including the Moscow midnight boundary',()=>{
 assert.equal(taskQueue(task('2026-10-29T20:59:59Z'),now),'overdue');
 assert.equal(taskQueue(task('2026-10-29T21:00:00Z'),now),'today');
 assert.equal(elapsedToday(task('2026-10-30T09:00:00+03:00'),now),true);
 assert.equal(taskQueue(task('2026-10-31T00:00:00+03:00'),now),'upcoming');
 assert.equal(taskQueue(task('2026-10-20T00:00:00+03:00','review'),now),'review');
 assert.equal(taskQueue(task(null),now),'no_deadline');
});
test('GAS code grammar supports recurring tasks and legacy codes',()=>{
 for(const title of ['РПМ* Задача','ЕВБ* Задача','СТРПМХ# Задача','копия РЗМ* Задача'])assert.equal(taskCode(title).valid,true);
 assert.equal(taskCode('РПM* латинская M').valid,false);assert.equal(taskCode('Задача без кода').valid,false);
});
test('dashboard partition reconciles all tasks without double counting',()=>{
 const rows=[task('2026-10-29T12:00:00+03:00'),task('2026-10-30T09:00:00+03:00'),task('2026-10-30T18:00:00+03:00'),task('2026-11-01T12:00:00+03:00'),task(null),task('2026-10-01T12:00:00+03:00','review'),task('2026-10-01T12:00:00+03:00','completed')];
 const s=summarize(rows,now);assert.equal(s.total,7);assert.equal(s.unfinished,6);assert.equal(s.overdue,1);assert.equal(s.today,2);assert.equal(s.elapsedToday,1);assert.equal(s.overdue+s.today+s.upcoming+s.no_deadline+s.review+s.completed,s.total);
});
test('planned load clips at Moscow midnight and respects explicitly cleared dates',()=>{
 const t={...task(null),planned_start:'2026-10-30T23:00:00+03:00',planned_end:'2026-10-31T02:00:00+03:00'};
 assert.equal(plannedMinutesOn(t,'2026-10-30'),60);assert.equal(plannedMinutesOn(t,'2026-10-31'),120);assert.equal(plannedMinutesOn(t,'2026-11-01'),0);
 assert.equal(plannedMinutesOn({...t,planned_start:null,source_fields:{'Планируемая дата начала':'2026-10-30 23:00:00'}},'2026-10-30'),null);
});
test('report schedule skips weekends and completed runs, retaining same-day delayed work',()=>{
 const cfg={enabled:true,morning:'09:00',evening:'18:00'};
 const weekend=nextRuns(cfg,new Date('2026-11-01T14:00:00+03:00'),new Set());assert.ok(weekend.every(r=>r.at.startsWith('2026-11-02')));
 const late=nextRuns(cfg,new Date('2026-11-02T20:00:00+03:00'),new Set(['morning:2026-11-02']));assert.equal(late[0].key,'evening:2026-11-02');assert.equal(late[0].late,true);assert.equal(late[1].key,'morning:2026-11-03');
 assert.deepEqual(nextRuns({...cfg,enabled:false},now,new Set()),[]);
});
test('report comparison distinguishes leaving a queue from completing work and keeps zero history honest',()=>{
 const t={...task('2026-10-30T18:00:00+03:00'),id:'1',assignee_id:'a',planned_start:null,planned_end:null};
 const first=reportAnalysis([t],[],now,null,null);assert.equal(first.comparison,null);assert.equal(first.counts.today,1);assert.equal(first.missingPlan,1);
 const later=reportAnalysis([],[],now,{id:'report-1',created_at:now.toISOString(),rows:[t]},null);assert.equal(later.comparison?.left,1);assert.equal(later.comparison?.completed,0);
});
