import test from 'node:test';
import assert from 'node:assert/strict';
import { listTasks, stats } from '../src/taskboard.mjs';
const tasks = [{id:'a',status:'todo',due:'2026-10-30'},{id:'b',status:'done',due:'2026-10-31'},{id:'c',status:'done'}];
test('list and statistics preserve all tasks', () => {
  assert.equal(listTasks(tasks).length, 3);
  assert.deepEqual(stats(tasks), {total:3,done:2});
});
