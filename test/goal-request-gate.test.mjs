import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunState, readRunState } from '../src/run-state.mjs';
import { digest } from '../src/workspace-tools.mjs';
import { GoalRequestGate, MODEL_ID, MOCK_POLICY } from '../src/goal-request-gate.mjs';
const terminal = () => new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const payload = () => ({ model: MODEL_ID, messages: [{ role: 'user', content: 'synthetic' }], stream: true, max_tokens: 512, tools: [{type:'function',function:{name:'calcifer_tool',parameters:{type:'object'}}}], chat_template_kwargs: { enable_thinking: false } });
const request = (phase, body = payload(), url = 'https://calcifer.invalid/v1/chat/completions') => {
  if (phase.identity?.kind === 'planner') { body = structuredClone(body); delete body.tools; }
  return new Request(url, { method: 'POST', headers: { 'x-calcifer-phase': phase.id, 'content-type': 'application/json' }, body: JSON.stringify(body) });
};
async function setup(transport = terminal) {
  const root = await mkdtemp(join(tmpdir(), 'calcifer-goal-gate-')), sourceDir = join(root, 'source'); await mkdir(sourceDir);
  const plan = { kind: 'goal_request', goal: 'synthetic' }, stateRoot = join(root, 'state');
  const state = await createRunState({ stateRoot, sourceDir, metadata: { kind: 'goal', stateRoot, plan, planHash: digest(plan), provenance: { kind: 'mock' }, policy: MOCK_POLICY, startedAt: Date.now() } });
  const gate = new GoalRequestGate({ state, transport });
  return { root, stateRoot, sourceDir, state, gate, cleanup: async () => { await state.release(false); await rm(root, { recursive: true, force: true }); } };
}
const identity = (kind = 'worker', taskId = 'first', framework = 'opencode') => ({ kind, taskId, framework, profileId: 'synthetic', model: MODEL_ID });

test('goal gate persists model intent before transport and shares 25/512/12800 budget across phases', async () => {
  let f, observed = 0;
  f = await setup(async () => {
    const saved = await readRunState({ stateRoot: f.stateRoot, runID: f.state.metadata.runID });
    assert.equal(saved.unknown.filter(item => item.kind === 'model').length, 1);
    observed++; return terminal();
  });
  try {
    const planner = f.gate.registerPhase(identity('planner', 'planner'));
    await f.gate.fetch(request(planner));
    await assert.rejects(f.gate.fetch(request(planner)), /PHASE_BUDGET/);
    f.gate.closePhase(planner.id);
    for (let task = 0; task < 4; task++) {
      const phase = f.gate.registerPhase(identity('worker', 'task' + task, task % 2 ? 'pi' : 'opencode'));
      for (let turn = 0; turn < 6; turn++) await f.gate.fetch(request(phase));
      if (!task) {
        f.gate.closePhase(phase.id);
        const switched = f.gate.registerPhase(identity('worker', 'task0', 'pi'));
        await assert.rejects(f.gate.fetch(request(switched)), /PHASE_BUDGET/);
      }
    }
    const extra = f.gate.registerPhase(identity('worker', 'extra'));
    await assert.rejects(f.gate.fetch(request(extra)), /GOAL_BUDGET/);
    assert.equal(observed, 25);
    const saved = await f.gate.state(); assert.equal(saved.requests, 25); assert.equal(saved.reservedOutputTokens, 12800);
  } finally { await f.cleanup(); }
});

test('goal gate rejects missing/late phase, wrong endpoint/model/thinking/output before dispatch', async () => {
  let calls = 0; const f = await setup(() => { calls++; return terminal(); });
  try {
    const phase = f.gate.registerPhase(identity());
    for (const item of [request({ id: 'unknown' }), request(phase, payload(), 'https://unapproved.invalid/v1/chat/completions'),
      request(phase, { ...payload(), model: 'wrong' }), request(phase, { ...payload(), max_tokens: 513 }),
      request(phase, { ...payload(), chat_template_kwargs: { enable_thinking: true } })]) await assert.rejects(f.gate.fetch(item));
    f.gate.closePhase(phase.id); await assert.rejects(f.gate.fetch(request(phase)), /PHASE_CLOSED/);
    assert.equal(calls, 0); assert.equal((await f.gate.state()).requests, 0);
  } finally { await f.cleanup(); }
});

test('incomplete tool stream remains UNKNOWN and blocks subsequent phase and workspace replay', async () => {
  let calls = 0; const f = await setup(() => { calls++; return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }); });
  try {
    const phase = f.gate.registerPhase(identity()); await assert.rejects(f.gate.fetch(request(phase)), /INCOMPLETE/);
    const later = f.gate.registerPhase(identity('worker', 'second', 'pi'));
    await assert.rejects(f.gate.fetch(request(later)), /UNKNOWN/);
    assert.equal(calls, 1); assert.equal((await f.gate.state()).unknown.length, 1);
    await assert.rejects(createRunState({ stateRoot: f.stateRoot, sourceDir: f.sourceDir, metadata: {} }), /LOCKED/);
  } finally { await f.cleanup(); }
});

test('unknown tool callback immediately closes model gate even if SDK converts error to a tool result', async () => {
  let calls = 0; const f = await setup(() => { calls++; return terminal(); });
  try {
    const phase = f.gate.registerPhase(identity()); await f.gate.fetch(request(phase));
    f.gate.markUnknown('TOOL_OUTCOME_UNKNOWN');
    await assert.rejects(f.gate.fetch(request(phase)), /UNKNOWN/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('goal gate allows one in-flight request and closes admission at the fixed goal window', async () => {
  let resolveResponse, started; const ready = new Promise(resolve => { started = resolve; });
  const f = await setup(() => new Promise(resolve => { resolveResponse = resolve; started(); }));
  try {
    const phase = f.gate.registerPhase(identity()), first = f.gate.fetch(request(phase)); await ready;
    await assert.rejects(f.gate.fetch(request(phase)), /CONCURRENCY/);
    resolveResponse(terminal()); await first;
    const expired = new GoalRequestGate({ state: f.state, transport: terminal, now: () => f.state.metadata.startedAt + 120000 });
    const next = expired.registerPhase(identity('worker','second','pi'));
    await assert.rejects(expired.fetch(request(next)), /WINDOW_EXHAUSTED/);
    assert.equal((await expired.state()).requests,1);
  } finally { await f.cleanup(); }
});
