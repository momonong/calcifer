import test from 'node:test';
import assert from 'node:assert/strict';
import { listTasks, stats } from '../src/taskboard.mjs';
const tasks = [{id:'a',status:'todo',due:'2026-10-30'},{id:'b',status:'done',due:'2026-10-31'},{id:'c',status:'done'}];
test('list and statistics preserve all tasks', () => {
  assert.equal(listTasks(tasks).length, 3);
  assert.deepEqual(stats(tasks), {total:3,done:2});
});
test('done status includes only completed tasks', () => assert.deepEqual(listTasks(tasks,{status:'done'}).map(t=>t.id), ['b','c']));
test('before includes equal boundary and excludes missing due', () => assert.deepEqual(listTasks(tasks,{before:'2026-10-30'}).map(t=>t.id), ['a']));
