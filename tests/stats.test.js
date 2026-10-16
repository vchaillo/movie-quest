import test from 'node:test';import assert from 'node:assert/strict';import {completion,recentSeen,byMonth} from '../stats.js';
const movies=[{id:1,title:'One'},{id:2,title:'Two'},{id:3,title:'Three'}];
test('completion counts seen and skipped independently',()=>assert.deepEqual(completion(movies,{1:'seen',2:'skip'}),{total:3,seen:1,skipped:1,remaining:1,percent:67}));
test('empty filmography never divides by zero',()=>assert.equal(completion([],{}).percent,0));
test('recent films ordered by viewing date',()=>assert.deepEqual(recentSeen(movies,{1:'seen',2:'seen',3:'skip'},{1:'2026-01-01',2:'2026-10-01'}).map(m=>m.id),[2,1]));
test('monthly viewing counts ignore skipped films',()=>assert.deepEqual(byMonth(movies,{1:'seen',2:'seen',3:'skip'},{1:'2026-10-01',2:'2026-10-11',3:'2026-10-12'}),[{month:'2026-10',count:2}]));
