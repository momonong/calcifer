import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunState, readRunState } from '../src/run-state.mjs';
const repo = new URL('../', import.meta.url), bun = resolve(new URL('../node_modules/.bin/bun', import.meta.url).pathname);
async function run(framework, variant = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'calcifer-goal-test-')), stateRoot = join(root, 'state');
  const child = spawnSync(bun, ['test/helpers/goal-probe.mjs', framework, variant, stateRoot, process.execPath], { cwd: repo, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
  let result;
  try { assert.equal(child.error, undefined, child.error?.message); assert.equal(child.signal, null, child.stderr); result = JSON.parse(child.stdout.split('\n').find(line => line.startsWith('CALCIFER_GOAL_RESULT='))?.slice(21) ?? '{}'); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return { root, stateRoot, child, result, cleanup: () => rm(root, { recursive: true, force: true }) };
}
for (const framework of ['opencode', 'pi']) test(`${framework} official SDK loops plan, correlate four M2 tools and accept integrated data`, async () => {
  const f = await run(framework);
  try {
    assert.equal(f.child.status, 0, f.child.stdout + f.child.stderr); assert.equal(f.result.status, 'completed');
    assert.equal(f.result.actualModelRequests, 0); assert.equal(f.result.syntheticModelRequests, 11);
    const metadata=JSON.parse(await readFile(join(f.result.runDir,'metadata.json'),'utf8'));
    assert.equal(metadata.kind,'goal'); assert.equal(metadata.plan.kind,'goal_request'); assert.equal(metadata.policy.requests,25);
    assert.equal(f.result.inner.checks.at(-1).kind, 'node-data'); assert.equal(f.result.inner.checks.at(-1).manifestHash, f.result.inner.finalManifestHash);
    assert.equal(f.result.inner.artifacts[0].content, 'draft\nfirst\nsecond\n');
    const wire = JSON.parse(await readFile(join(f.result.runDir, 'synthetic-wire.json'), 'utf8'));
    assert.equal(wire.requests[0].body.tools, undefined);
    assert.deepEqual(f.result.requestCounts,{attempted:11,admitted:11,dispatched:11,terminalConfirmed:11});
    assert.deepEqual(wire.requestFailures, []); assert.equal(f.result.requestAttempts,11);
    for (const request of wire.requests) {
      assert.equal(request.body.chat_template_kwargs.enable_thinking, false); assert.equal(request.headers['x-calcifer-phase'], request.phaseId);
      assert.ok(request.bytes > 0); assert.equal(request.adapted.model, 'calcifer-synthetic-v1');
      assert.deepEqual(request.body.tools?.map(item => item.function.name) ?? [], request.phase.kind === 'planner' ? [] : ['calcifer_tool']);
    }
    const tools = wire.phases.flatMap(phase => phase.tools); assert.deepEqual([...new Set(tools.map(item => item.input.action))].sort(), ['check','edit','read','search']);
    for (const phase of wire.phases) { assert.equal(phase.sdkSettled, true); assert.equal(phase.toolsSettled, true); assert.equal(phase.transportSettled, true); assert.equal(phase.closed, true); }
    assert.ok(tools.some(item => item.result?.status === 'failed')); assert.ok(tools.some(item => item.result?.status === 'passed'));
    for (const tool of tools) assert.ok(wire.requests.some(request => request.phase.taskId === (wire.phases.find(phase => phase.tools.includes(tool)).phase.taskId) && request.adapted.messages.some(message => message.role === 'tool' && message.tool_call_id === tool.nativeId)));
  } finally { await f.cleanup(); }
});
for (const variant of ['invalid-plan','out-of-scope']) test(`${variant} planner never dispatches a worker`, async () => {
  const f = await run('opencode', variant);
  try { assert.equal(f.result.status, 'failed'); assert.equal(f.result.syntheticModelRequests, 1); assert.equal(f.result.inner, undefined); assert.equal(f.result.phases.length, 1); }
  finally { await f.cleanup(); }
});
test('one-task proposal completes and mixed routing dispatches two real SDK adapters', async () => {
  const single = await run('pi', 'one-task'), mixed = await run('mixed');
  try {
    assert.equal(single.result.status, 'completed'); assert.equal(single.result.inner.taskResults.length, 1);
    assert.equal(mixed.result.status, 'completed'); assert.deepEqual(mixed.result.phases.map(item => item.phase.framework), ['opencode','opencode','pi']);
    assert.equal(single.result.inner.checks.at(-1).kind, 'node-data');
  } finally { await single.cleanup(); await mixed.cleanup(); }
});
for (const framework of ['opencode','pi']) test(`${framework} partial tool stream and lost tool acknowledgement seal further model dispatch`, async () => {
  for (const variant of ['partial-tool','error-frame','lost-tool']) {
    const f = await run(framework, variant);
    try {
      assert.equal(f.result.status, 'unknown', f.child.stdout + f.child.stderr); assert.equal(f.result.integrationAccepted, false);
      assert.equal(f.result.syntheticModelRequests, variant === 'lost-tool' ? 5 : 2);
      const wire = JSON.parse(await readFile(join(f.result.runDir, 'synthetic-wire.json'), 'utf8'));
      assert.equal(wire.phases.flatMap(item => item.tools).length, variant === 'lost-tool' ? 4 : 0);
      if (variant === 'lost-tool') {
        assert.equal(await readFile(join(f.result.inner.runDir,'tasks','first','note.txt'),'utf8'),'draft\nfirst\n');
        assert.deepEqual(f.result.inner.artifacts,[]); assert.equal(f.result.inner.taskResults.length,0);
      }
      const retry = spawnSync(process.execPath, ['src/goal-cli.mjs','demo','--framework',framework,'--state-root',f.stateRoot], { cwd: repo, encoding: 'utf8', timeout: 15000 });
      assert.notEqual(retry.status, 0); assert.match(retry.stdout, /LOCKED|UNKNOWN/);
    } finally { await f.cleanup(); }
  }
});
for (const framework of ['opencode','pi']) test(`${framework} cancel in-flight records model/tool/native settlement separately without replay`, async () => {
  const f = await run(framework, 'cancel');
  try { assert.equal(f.result.status, 'unknown'); assert.equal(f.result.cancellation.userStoppedWaiting, true); assert.equal(f.result.cancellation.remoteInference, 'not_applicable'); assert.equal(f.result.syntheticModelRequests, 2); assert.equal(f.result.integrationAccepted, false); }
  finally { await f.cleanup(); }
});
test('Node goal CLI launches pinned Bun; reopen is readonly and missing ledger fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'calcifer-goal-cli-')), stateRoot = join(root, 'state');
  const cli = (...args) => spawnSync(process.execPath, ['src/goal-cli.mjs',...args], { cwd: repo, encoding: 'utf8', timeout: 25000, maxBuffer: 1024*1024 });
  try {
    const created = cli('demo','--state-root',stateRoot); assert.equal(created.status, 0, created.stdout + created.stderr); const result = JSON.parse(created.stdout);
    assert.ok(result.checks.every(check => check.kind==='node-data' && !('stderr' in check) && !('inputFile' in check)));
    const path = join(stateRoot,'runs',result.runID,'ledger.jsonl'), before = await readFile(path,'utf8');
    const reopened = cli('reopen','--state-root',stateRoot,'--run-id',result.runID); assert.equal(reopened.status, 0, reopened.stdout+reopened.stderr); assert.equal(JSON.parse(reopened.stdout).reopenedWithoutSDK, true); assert.equal(await readFile(path,'utf8'),before);
    await unlink(path); const missing = cli('reopen','--state-root',stateRoot,'--run-id',result.runID); assert.notEqual(missing.status, 0); assert.match(missing.stdout,/LEDGER_MISSING/);
    assert.notEqual(cli('demo','--framework','unapproved','--state-root',stateRoot).status,0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

for (const framework of ['opencode','pi']) test(`${framework} settled pre-dispatch phase budget failure is failed without partial acceptance or stale UNKNOWN`, async () => {
  const f = await run(framework, 'phase-budget');
  try {
    assert.equal(f.result.status,'failed',f.child.stdout+f.child.stderr);
    assert.equal(f.result.code,'PHASE_BUDGET_EXHAUSTED'); assert.equal(f.result.integrationAccepted,false);
    assert.deepEqual(f.result.requestCounts,{attempted:8,admitted:7,dispatched:7,terminalConfirmed:7});
    assert.deepEqual(f.result.inner.artifacts,[]); assert.deepEqual(f.result.inner.taskResults,[]); assert.equal(f.result.inner.status,'failed');
    assert.ok(f.result.phases.every(phase => phase.sdkSettled && phase.toolsSettled && phase.transportSettled && phase.closed));
    const saved=await readRunState({stateRoot:f.stateRoot,runID:f.result.runID}); assert.equal(saved.unknown.length,0); assert.equal(saved.status,'failed');
    const inner=await readRunState({stateRoot:join(f.result.runDir,'inner-state'),runID:f.result.inner.runID}); assert.equal(inner.unknown.length,0);
    const wire=JSON.parse(await readFile(join(f.result.runDir,'synthetic-wire.json'),'utf8'));
    assert.equal(wire.requestFailures.length,1); assert.equal(wire.requestFailures[0].code,'PHASE_BUDGET_EXHAUSTED'); assert.equal(wire.requestFailures[0].preDispatch,true);
    assert.equal(wire.phases.flatMap(phase=>phase.tools).length,6);
    // Claim the same canonical workspace again, without constructing an SDK or model request.
    const next=await createRunState({stateRoot:f.stateRoot,sourceDir:saved.metadata.hostScope.sourceDir,metadata:saved.metadata});
    try { await next.finish({runID:next.metadata.runID,status:'failed'}); } finally { await next.release(true); }
    assert.equal(f.result.syntheticModelRequests,7);
  } finally { await f.cleanup(); }
});
