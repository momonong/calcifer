import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const run = (...args) => {
  const p = spawnSync('/runtime/node', ['/workspace/src/cli.mjs',...args], {env:{},encoding:'utf8',timeout:800});
  assert.equal(p.status,0,p.stderr); return JSON.parse(p.stdout);
};
test('preserve stats and public listing', () => {
  assert.deepEqual(run('stats'), {total:3,done:2});
  assert.deepEqual(run('list').map(t=>t.id), ['a','b','c']);
});
test('host completed filter',()=>assert.deepEqual(run('list','--status','done').map(t=>t.id),['b','c']));
