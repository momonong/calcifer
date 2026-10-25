import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const index = JSON.parse(await readFile(new URL('../evidence/offline-latest.json', import.meta.url)));
const bytes = await readFile(new URL('../' + index.path, import.meta.url));
const report = JSON.parse(bytes);
const hash = value => createHash('sha256').update(value).digest('hex');
for (const framework of ['opencode','pi']) {
  test(`${framework}: real SDK path uses strict adapter and shared natural-language task tools`, () => {
    const f = report.frameworks[framework], c = f.cases;
    assert.equal(f.import, 'passed'); assert.equal(f.process.status, 'passed'); assert.equal(f.process.error, undefined); assert.equal(f.process.signal, null);
    assert.deepEqual(f.externalNetworkAttempts, []);
    assert.equal(c.T1.after['note.txt'].content, 'hello calcifer\n'); assert.deepEqual(c.T1.changedFiles, ['note.txt']);
    assert.deepEqual(c.T1.toolAttempts.map(t => t.action), ['read','edit']);
    assert.deepEqual(c.T2.toolAttempts.map(t => t.action), ['read','test','edit','test']);
    assert.deepEqual(c.T2.probes.map(p => p.passed), [false,true]); assert.deepEqual(c.T2.probes[0].failures, [0,2]);
    assert.deepEqual(c.T2.changedFiles, ['range.mjs']);
    for (const run of Object.values(c)) {
      assert.equal(run.status, 'observed'); assert.equal(run.settled, true);
      for (const request of run.requests) {
        assert.equal(request.body.model, 'Qwen/Qwen3.5-4B'); assert.equal(request.body.max_tokens, 512);
        assert.equal(request.body.temperature, 0); assert.equal(request.body.top_p, 1);
        assert.equal(request.headers['x-request-timeout-ms'], '30000');
        assert.equal('max_completion_tokens' in request.body, false); assert.equal('store' in request.body, false); assert.equal('calcifer_fixture' in request.body, false);
        assert.deepEqual(request.body.tools.map(tool => tool.function.name), ['fixture_tool']); assert.equal('strict' in request.body.tools[0].function, false);
      }
      assert.ok(run.adapters.every(a => a.context === 8192));
    }
    assert.ok(c.T1.adapters[0].transforms.includes(framework === 'opencode' ? 'remove_opencode_strict_false' : 'remove_pi_store_false'));
  });
  test(`${framework}: finish without DONE and HTTP200 error never expose text or execute a tool`, () => {
    for (const name of ['finish_no_done','tool_no_done','error_frame']) {
      const c = report.frameworks[framework].cases[name];
      assert.equal(c.requests.length, 1); assert.equal(c.requestsAfterUnknownReopen, 1); assert.equal(c.toolAttempts.length, 0);
      assert.deepEqual(c.changedFiles, []); assert.equal(c.assistantText, ''); assert.ok(c.nativeError);
      assert.equal(c.guardState.unknown.length, 1); assert.ok(c.guardFailures.includes('UNKNOWN_RECONCILE_REQUIRED')); assert.deepEqual(c.terminals, []);
    }
  });
  test(`${framework}: known model completion stays separate from local tool UNKNOWN`, () => {
    const c = report.frameworks[framework].cases.T3;
    assert.equal(c.requestsBeforeReconcile, 1); assert.equal(c.requestsAfterBlockedRestart, 1); assert.equal(c.restartReadback, true);
    assert.equal(c.preReconcileReceipt.acknowledged, false); assert.equal(c.reconciledReceipt.count, 1);
    assert.equal(c.sideEffectCount, 1); assert.equal(c.toolAttempts.length, 1); assert.equal(c.requests.length, 2);
    assert.equal(c.guardState.unknown.length, 0); assert.equal(c.terminals[0].finish, 'tool_calls');
  });
  test(`${framework}: cancellation UNKNOWN settles before advancing to another case`, () => {
    const c = report.frameworks[framework].cases.cancel;
    assert.equal(c.requests.length, 1); assert.equal(c.toolAttempts.length, 0); assert.equal(c.guardState.unknown.length, 1);
    assert.ok(c.guardFailures.length > 0); assert.equal(c.cancellation.remoteInference, 'unknown'); assert.equal(c.cancellation.streamDrain, false);
    const length = report.frameworks[framework].cases.length;
    assert.deepEqual(length.guardFailures, []); assert.equal(length.guardState.unknown.length, 0);
    assert.equal(length.terminals[0].finish, 'length'); assert.equal(length.terminals[0].answer, 'truncated');
    assert.equal(length.requests.length, framework === 'opencode' ? 2 : 1);
  });
  test(`${framework}: actual SDK requests respect UNKNOWN and exhausted shared-run budget`, () => {
    const c = report.frameworks[framework].cases;
    assert.equal(c.budget_gate.requests.length, 0); assert.ok(c.budget_gate.guardFailures.includes('RUN_BUDGET_EXHAUSTED'));
    assert.equal(c.budget_gate.guardState.requests, 40); assert.equal(c.budget_gate.guardState.reservedOutputTokens, 20480);
    assert.equal(c.unknown_gate.requests.length, 0); assert.ok(c.unknown_gate.guardFailures.includes('UNKNOWN_RECONCILE_REQUIRED'));
    assert.ok(c.canary, 'one canary session must perform the approved two-request tool roundtrip');
    assert.equal(c.canary.requests.length, 2); assert.deepEqual(c.canary.toolAttempts.map(t => t.action), ['read']);
    assert.ok(c.canary.requests[1].body.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_1'));
    assert.deepEqual(c.T1.terminals[0].usage, { status: 'unknown' });
    assert.equal(c.canary.terminals[1].usage.status, 'reported'); assert.equal(c.canary.terminals[1].usage.totalTokens, 22); assert.equal(c.canary.terminals[1].usage.cachedTokens, 3);
    const assistant = c.canary.messages.filter(m => m.role === 'assistant' || m.type === 'assistant').at(-1);
    if (framework === 'pi') { assert.equal(assistant.usage.output, 5); assert.equal(assistant.usage.cacheRead, 3); }
    else { assert.equal(assistant.tokens.output, 5); assert.equal(assistant.tokens.cache.read, 3); }
  });
}
test('offline evidence hashes source/profile/fixtures/lockfile and preserves one cross-framework task budget', async () => {
  assert.equal(index.sha256, hash(bytes)); assert.equal(report.liveRequests, 0);
  for (const [path,digest] of Object.entries({ ...report.sourceManifest, ...report.fixtures })) assert.equal(hash(await readFile(new URL('../' + path, import.meta.url))), digest, path);
  const events = report.ledgers['shared-task-run.jsonl'].events;
  const intents = events.filter(e => e.type === 'intent');
  assert.equal(intents.length, 24); assert.deepEqual([...new Set(intents.map(e => e.framework))].sort(), ['opencode','pi']);
  assert.equal(intents.reduce((sum,e) => sum + e.maxTokens, 0), 12288);
  assert.equal(events.filter(e => e.type === 'completed').length, 24);
  assert.equal(events.filter(e => e.type === 'unknown').length, 0);
});
