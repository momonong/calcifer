import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, readdir, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, hash } from './helpers/collaboration.mjs';
import { runCollaboration, reopenRun } from '../src/collaboration-runner.mjs';

test('dependent edits compose in distinct snapshots, final host check runs even when planner omits checks', async () => {
  const f = await fixture();
  try {
    const seen = [];
    const result = await runCollaboration({ plan: f.plan, host: f.host,
      worker: async context => { seen.push(context.workspaceDir); return f.worker(context); } });
    assert.equal(result.status, 'completed'); assert.equal(new Set(seen).size, 2);
    assert.equal(await readFile(join(f.host.sourceDir, 'note.txt'), 'utf8'), 'draft\n');
    assert.equal(await readFile(join(f.host.sourceDir, 'unrelated.txt'), 'utf8'), 'preserve\n');
    assert.equal(await readFile(join(result.integrationDir, 'note.txt'), 'utf8'), 'draft\nfirst\nsecond\n');
    assert.equal(result.artifacts[0].beforeHash, hash('draft\n'));
    assert.equal(result.artifacts[0].afterHash, hash('draft\nfirst\nsecond\n'));
    assert.equal(result.checks.length, 1); assert.equal(result.checks[0].manifestHash, result.finalManifestHash);
    assert.match(result.checks[0].definitionHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.provenance, { kind: 'mock', generations: 0, remoteInference: 'not_applicable' });
    const reopened = await reopenRun({ stateRoot: f.host.stateRoot, runID: result.runID });
    assert.equal(reopened.status, 'completed');
  } finally { await f.cleanup(); }
});

test('independent overlapping edits conflict instead of overwriting a prior artifact', async () => {
  const f = await fixture(); f.plan.tasks[1].dependsOn = [];
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: f.worker });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'ARTIFACT_CONFLICT');
    assert.equal(result.integrationAccepted, false);
    assert.equal(await readFile(join(f.host.sourceDir, 'note.txt'), 'utf8'), 'draft\n');
  } finally { await f.cleanup(); }
});

test('host computes unauthorized changes and preserves rejected workspace without accepting it', async () => {
  const f = await fixture();
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: async ({ workspaceDir }) => {
      await writeFile(join(workspaceDir, 'created.txt'), 'forbidden'); return { status: 'completed' };
    } });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'UNAUTHORIZED_WORKSPACE_ENTRY');
    assert.equal(result.integrationAccepted, false);
    assert.equal(await readFile(join(result.runDir, 'tasks', 'first', 'created.txt'), 'utf8'), 'forbidden');
  } finally { await f.cleanup(); }
});

test('worker throw leaves UNKNOWN, blocks dependents and fresh run in stable state root', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const worker = async () => { calls++; throw new Error('lost result'); };
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker });
    assert.equal(result.status, 'unknown'); assert.equal(calls, 1);
    const reopened = await reopenRun({ stateRoot: f.host.stateRoot, runID: result.runID });
    assert.equal(reopened.status, 'unknown'); assert.equal(calls, 1);
    await assert.rejects(runCollaboration({ plan: f.plan, host: f.host, worker }), /LOCKED|UNKNOWN/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('reopen is read only, rejects changed identity, missing ledger and truncated ledger', async () => {
  const f = await fixture();
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: f.worker });
    const before = await readFile(join(result.runDir, 'ledger.jsonl'), 'utf8');
    await reopenRun({ stateRoot: f.host.stateRoot, runID: result.runID });
    assert.equal(await readFile(join(result.runDir, 'ledger.jsonl'), 'utf8'), before);
    await assert.rejects(reopenRun({ stateRoot: f.host.stateRoot, runID: result.runID,
      expected: { authorityHash: 'changed' } }), /IDENTITY_MISMATCH/);
    await appendFile(join(result.runDir, 'ledger.jsonl'), '{');
    await assert.rejects(reopenRun({ stateRoot: f.host.stateRoot, runID: result.runID }), /LEDGER_INCOMPLETE/);
    await unlink(join(result.runDir, 'ledger.jsonl'));
    await assert.rejects(reopenRun({ stateRoot: f.host.stateRoot, runID: result.runID }), /LEDGER_MISSING/);
  } finally { await f.cleanup(); }
});

test('stale lock is never silently cleared', async () => {
  const f = await fixture();
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: f.worker });
    const files = await readdir(join(f.host.stateRoot, 'workspaces'));
    const active = files.find(name => name.endsWith('.json'));
    const lock = join(f.host.stateRoot, 'workspaces', active.replace(/\.json$/, '.lock'));
    await writeFile(lock, 'stale');
    await assert.rejects(runCollaboration({ plan: f.plan, host: f.host, worker: f.worker }), /WORKSPACE_LOCKED/);
    assert.equal(await readFile(lock, 'utf8'), 'stale');
  } finally { await f.cleanup(); }
});

test('cancel before dispatch causes no worker or persistent side effects', async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort(); let calls = 0;
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, signal: controller.signal,
      worker: async () => { calls++; } });
    assert.equal(result.status, 'cancelled'); assert.equal(calls, 0);
    await assert.rejects(readdir(f.host.stateRoot), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('inflight cancellation is bounded UNKNOWN and never replays an unanswered worker', async () => {
  const f = await fixture(); const controller = new AbortController(); let calls = 0;
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, signal: controller.signal,
      worker: async () => { calls++; controller.abort(); return new Promise(() => {}); } });
    assert.equal(result.status, 'unknown'); assert.equal(result.cancellation.userStoppedWaiting, true);
    assert.equal(result.cancellation.worker, 'unknown'); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('final failed check prevents completion and check results bind final content', async () => {
  const f = await fixture(); f.host.checks.final.evaluate = async () => false;
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: f.worker });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'FINAL_CHECK_FAILED');
    assert.equal(result.checks[0].manifestHash, result.finalManifestHash);
    assert.equal(result.integrationAccepted, false);
  } finally { await f.cleanup(); }
});

test('changing snapshot during a trusted mock check cannot produce stale accepted verification', async () => {
  const f = await fixture(); f.host.checks.final.evaluate = async ({ workspaceDir }) => {
    await writeFile(join(workspaceDir, 'note.txt'), 'tampered'); return true;
  };
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: f.worker });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'CHECK_MANIFEST_CHANGED');
  } finally { await f.cleanup(); }
});

test('arbitrary check executables and missing final host checks reject before worker dispatch', async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.host.checks.final = { kind: 'node', executable: 'arbitrary', scriptPath: 'check.mjs' };
    await assert.rejects(runCollaboration({ plan: f.plan, host: f.host, worker: async () => { calls++; } }), /INVALID_CHECK_DEFINITION/);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test('returned worker seals tools and settles already accepted queue before computing artifacts', async () => {
  const f = await fixture(); let retained;
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: async ({ task, tools }) => {
      retained = tools;
      const file = await tools.dispatch({ action: 'read', args: { path: 'note.txt' } });
      void tools.dispatch({ action: 'edit', args: { path: 'note.txt', expectedHash: file.hash, content: file.content + task.id + '\n' } });
      return { status: 'completed' };
    } });
    assert.equal(result.status, 'completed');
    await assert.rejects(retained.dispatch({ action: 'edit', args: { path: 'note.txt', expectedHash: hash('draft\nfirst\nsecond\n'), content: 'late' } }), /TOOLS_CLOSED/);
    assert.equal(await readFile(join(result.integrationDir, 'note.txt'), 'utf8'), 'draft\nfirst\nsecond\n');
  } finally { await f.cleanup(); }
});

test('read-only task direct mutation is rejected and integration remains unaccepted', async () => {
  const f = await fixture(); f.plan.tasks[0].writePaths = []; f.plan.tasks[0].requiredCapabilities = ['verify'];
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: async ({ workspaceDir }) => {
      await writeFile(join(workspaceDir, 'note.txt'), 'unapproved'); return { status: 'completed' };
    } });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'UNAUTHORIZED_FILE_CHANGE');
    assert.equal(result.integrationAccepted, false);
  } finally { await f.cleanup(); }
});

test('tampered completed evidence is rejected by read-only reopen', async () => {
  const f = await fixture();
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: f.worker });
    await writeFile(join(result.integrationDir, 'note.txt'), 'tampered after verification');
    await assert.rejects(reopenRun({ stateRoot: f.host.stateRoot, runID: result.runID }), /EVIDENCE_MANIFEST_MISMATCH/);
  } finally { await f.cleanup(); }
});

test('lost task check receipt remains UNKNOWN even when worker catches its error', async () => {
  const f = await fixture(); f.plan.tasks[0].checkIds = ['final']; f.plan.tasks[0].requiredCapabilities = ['edit', 'verify'];
  f.host.checks.final.evaluate = async () => { throw new Error('lost check receipt'); };
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: async ({ tools }) => {
      await tools.dispatch({ action: 'check', args: { checkId: 'final' } }).catch(() => {});
      return { status: 'completed' };
    } });
    assert.equal(result.status, 'unknown'); assert.equal(result.integrationAccepted, false);
    await assert.rejects(runCollaboration({ plan: f.plan, host: f.host, worker: f.worker }), /LOCKED|UNKNOWN/);
  } finally { await f.cleanup(); }
});

test('CLI runs fixed synthetic cooperation and reopens without execution, bad arguments exit nonzero', async () => {
  const f = await fixture();
  try {
    const cli = (...args) => spawnSync(process.execPath, ['src/collaboration-run-cli.mjs', ...args], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
    const created = cli('demo', '--state-root', f.host.stateRoot);
    assert.equal(created.status, 0, created.stdout + created.stderr);
    const result = JSON.parse(created.stdout); assert.equal(result.status, 'completed'); assert.equal(result.provenance.generations, 0);
    assert.ok(result.checks.length > 0 && result.checks.every(check => check.kind === 'node-data'));
    const reopened = cli('reopen', '--state-root', f.host.stateRoot, '--run-id', result.runID);
    assert.equal(reopened.status, 0, reopened.stdout + reopened.stderr);
    assert.equal(JSON.parse(reopened.stdout).status, 'completed');
    assert.deepEqual(JSON.parse(reopened.stdout).checks, result.checks);
    assert.notEqual(cli('arbitrary').status, 0);
  } finally { await f.cleanup(); }
});

test('one small task may complete without forced decomposition and still runs host final check', async () => {
  const f = await fixture(); f.plan.tasks = [f.plan.tasks[0]];
  f.host.checks.final.evaluate = async ({ files }) => files['note.txt'] === 'draft\nfirst\n';
  try {
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: f.worker });
    assert.equal(result.status, 'completed'); assert.equal(result.taskResults.length, 1);
    assert.equal(result.checks.length, 1); assert.equal(result.checks[0].status, 'passed');
  } finally { await f.cleanup(); }
});

test('worker cannot replace a writable file with a hardlink even when bytes are unchanged', async () => {
  const f = await fixture(); const canary = join(f.root, 'hardlink-canary.txt');
  f.host.checks.final.evaluate = async () => true;
  try {
    await writeFile(canary, 'draft\n');
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: async context => {
      if (context.task.id === 'second') return f.worker(context);
      await unlink(join(context.workspaceDir, 'note.txt')); await link(canary, join(context.workspaceDir, 'note.txt'));
      return { status: 'completed' };
    } });
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'WRITABLE_HARDLINK_REJECTED');
  } finally { await f.cleanup(); }
});

test('legacy executable node check kind rejects before any worker dispatch', async () => {
  const f = await fixture(), scriptPath = join(f.root, 'legacy-check.mjs'); let calls = 0;
  try {
    await writeFile(scriptPath, 'process.exitCode=0;'); f.host.checks.final = { kind: 'node', scriptPath };
    await assert.rejects(runCollaboration({ plan: f.plan, host: f.host, worker: async () => { calls++; return {status:'completed'}; } }), /INVALID_CHECK_DEFINITION/);
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});
