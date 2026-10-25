import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { RequestGuard } from '../src/request-guard.mjs';

const payload = { model: 'synthetic/model', max_tokens: 512, messages: [{ role: 'user', content: 'NEVER_PERSIST_THIS_PROMPT' }], stream: true };
const response = () => new Response('data: {"choices":[{"index":0,"delta":{"content":"NEVER_PERSIST_RESPONSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic-request' } });
const options = { framework: 'opencode', task: 'T1', payload };
async function fixture(fn) { const dir = await mkdtemp(join(tmpdir(), 'calcifer-guard-')); try { await fn(join(dir, 'run.jsonl')); } finally { await rm(dir, { recursive: true, force: true }); } }
test('durable intent precedes transport and unknown blocks a new guard and changed payload', async () => fixture(async path => {
  let dispatches = 0;
  const guard = new RequestGuard(path, 'run');
  await assert.rejects(guard.dispatch(options, async () => {
    dispatches++; const state = await guard.state(); assert.equal(state.intents.length, 1); throw new Error('synthetic connection lost');
  }), /synthetic connection lost/);
  await assert.rejects(new RequestGuard(path, 'run').dispatch({ ...options, payload: { ...payload, model: 'changed' } }, response), /UNKNOWN_RECONCILE_REQUIRED/);
  assert.equal(dispatches, 1);
  const log = await readFile(path, 'utf8'); assert.equal(log.includes('NEVER_PERSIST'), false);
  await assert.rejects(new RequestGuard(path, 'different-run').dispatch(options, response), /LEDGER_IDENTITY_MISMATCH/);
}));
test('40 shared requests and task/canary reservations survive reopening and reject before dispatch', async () => fixture(async path => {
  let count = 0;
  for (const framework of ['opencode','pi']) for (const task of ['T1','T2','T3','canary']) for (let n = 0; n < (task === 'canary' ? 2 : 6); n++) await new RequestGuard(path, 'run').dispatch({ framework, task, payload }, () => { count++; return response(); });
  const guard = new RequestGuard(path, 'run');
  assert.equal((await guard.state()).requests, 40); assert.equal((await guard.state()).reservedOutputTokens, 20480);
  await assert.rejects(guard.dispatch(options, () => { count++; return response(); }), /RUN_BUDGET_EXHAUSTED/);
  assert.equal(count, 40); assert.equal((await readFile(path, 'utf8')).includes('NEVER_PERSIST'), false);
}));
test('slot, output, deadline and persistent dispatch window limits apply before transport', async () => fixture(async path => {
  let clock = 1000, count = 0; const guard = new RequestGuard(path, 'run', { now: () => clock });
  const send = () => { count++; return response(); };
  await assert.rejects(guard.dispatch({ ...options, payload: { ...payload, max_tokens: 513 } }, send), /OUTPUT_LIMIT/);
  await assert.rejects(guard.dispatch({ ...options, deadlineMs: 30001 }, send), /DEADLINE_LIMIT/);
  for (let n = 0; n < 2; n++) await guard.dispatch({ ...options, task: 'canary' }, send);
  await assert.rejects(guard.dispatch({ ...options, task: 'canary' }, send), /SLOT_BUDGET_EXHAUSTED/);
  clock = 1201000;
  await assert.rejects(new RequestGuard(path, 'run', { now: () => clock }).dispatch(options, send), /DISPATCH_WINDOW_EXHAUSTED/);
  assert.equal(count, 2);
}));
test('a process exit after intent cannot be bypassed by a fresh process or different body', async () => fixture(async path => {
  const moduleURL = new URL('../src/request-guard.mjs', import.meta.url).href;
  const run = source => spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: resolve('.'), env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000 });
  const setup = `import { RequestGuard } from ${JSON.stringify(moduleURL)}; const guard = new RequestGuard(${JSON.stringify(path)}, 'crashed');`;
  const first = run(setup + `await guard.dispatch(${JSON.stringify(options)}, () => process.exit(0));`);
  assert.equal(first.error, undefined); assert.equal(first.signal, null); assert.equal(first.status, 0, first.stderr);
  const second = run(setup + `try { await guard.dispatch(${JSON.stringify({ ...options, payload: { ...payload, model: 'changed' } })}, () => { throw new Error('TRANSPORT_MUST_NOT_RUN'); }); process.exit(2); } catch(e) { console.log(e.message); process.exit(e.message === 'UNKNOWN_RECONCILE_REQUIRED' ? 0 : 3); }`);
  assert.equal(second.error, undefined); assert.equal(second.signal, null); assert.equal(second.status, 0, second.stderr); assert.match(second.stdout, /UNKNOWN_RECONCILE_REQUIRED/);
  assert.equal((await new RequestGuard(path, 'crashed').state()).intents.length, 1);
}));
test('two guard instances cannot dispatch concurrently through one single-runner ledger', async () => fixture(async path => {
  await new RequestGuard(path, 'run').dispatch(options, response);
  let dispatched = 0;
  const send = async () => { dispatched++; await new Promise(resolve => setTimeout(resolve, 10)); return response(); };
  await Promise.allSettled([new RequestGuard(path, 'run').dispatch(options, send), new RequestGuard(path, 'run').dispatch(options, send)]);
  assert.equal(dispatched, 1);
}));
test('client abort while waiting for headers records UNKNOWN and releases local waiting', async () => fixture(async path => {
  const guard = new RequestGuard(path, 'run'), controller = new AbortController();
  const waiting = guard.dispatch({ ...options, signal: controller.signal }, () => { controller.abort(); return new Promise(() => {}); }).then(() => 'completed', () => 'rejected');
  const result = await Promise.race([waiting, new Promise(resolve => setTimeout(() => resolve('still-waiting'), 100))]);
  assert.equal(result, 'rejected'); assert.equal((await guard.state()).unknown.length, 1);
}));
