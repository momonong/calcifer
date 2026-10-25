import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function readReport() {
  const index = JSON.parse(await readFile(new URL('../evidence/latest.json', import.meta.url), 'utf8'));
  return JSON.parse(await readFile(new URL('../' + index.path, import.meta.url), 'utf8'));
}

// Characterization of the integration boundary: these assertions inspect the
// actual official framework run, never an alternate local agent implementation.
for (const framework of ['opencode', 'pi']) {
  test(`${framework}: official harness makes the fixed scoped T1/T2 changes`, async () => {
    const report = await readReport();
    const runs = report.frameworks[framework].cases;
    assert.equal(runs.T1.provenance, 'framework E2E');
    assert.equal(runs.T1.after['note.txt'].content, 'hello calcifer\n');
    assert.equal(runs.T1.after['sentinel.txt'].sha256, runs.T1.before['sentinel.txt'].sha256);
    assert.deepEqual(runs.T1.changedFiles, ['note.txt']);
    assert.deepEqual(runs.T2.probes.map(probe => probe.passed), [false, true]);
    assert.deepEqual(runs.T2.probes[0].failures, [0, 2]);
    assert.deepEqual(runs.T2.changedFiles, ['range.mjs']);
    assert.equal(runs.T2.after['sentinel.txt'].sha256, runs.T2.before['sentinel.txt'].sha256);
    assert.ok(runs.T1.requests[1].body.messages.some(message => message.role === 'tool'));
  });
  test(`${framework}: denies unknown tool and does not retry a 503 with retries disabled`, async () => {
    const report = await readReport();
    const runs = report.frameworks[framework].cases;
    assert.deepEqual(runs.denied_tool.toolAttempts, []);
    assert.deepEqual(runs.denied_tool.changedFiles, []);
    assert.equal(runs.http_error.requests.length, 1);
    assert.ok(runs.http_error.nativeError);
    assert.equal(runs.retry.requests.length, 2);
    assert.deepEqual(runs.truncated_tool.toolAttempts, []);
    assert.deepEqual(runs.truncated_tool.changedFiles, []);
    assert.equal(runs.hook_throw.hardGateHookThrew, true);
    assert.equal(runs.hook_throw.requests.length, framework === 'opencode' ? 0 : 1);
  });
  test(`${framework}: unknown side effect is not resent before reconciliation`, async () => {
    const report = await readReport();
    const run = report.frameworks[framework].cases.T3;
    assert.equal(run.requestsBeforeReconcile, 1);
    assert.equal(run.preReconcileReceipt.count, 1);
    assert.equal(run.preReconcileReceipt.acknowledged, false);
    assert.equal(run.reconciledReceipt.count, 1);
    assert.equal(run.after['receipt.json'].content.includes('"count":1'), true);
    assert.equal(run.toolAttempts.length, 1);
    assert.equal(run.sideEffectCount, 1);
    assert.equal(run.requestsAfterBlockedRestart, 1);
    assert.equal(run.restartReadback, true);
  });
  test(`${framework}: cancellation and stream boundaries have explicit observed states`, async () => {
    const report = await readReport();
    const runs = report.frameworks[framework].cases;
    assert.equal(runs.text_stop.assistantText.includes('fixture-ok 火。'), true);
    assert.equal(runs.text_stop.streams[0].drained, true);
    assert.ok(runs.length.nativeFinishes.includes('length'));
    assert.equal(runs.length.requests.length, framework === 'opencode' ? 2 : 1);
    assert.ok(runs.truncated.nativeError);
    assert.equal(runs.cancel.cancellation.userStoppedWaiting, true);
    assert.equal(runs.cancel.cancellation.remoteInference, 'unknown');
    assert.equal(runs.cancel.cancellation.toolStopped, 'not started');
    assert.equal(runs.cancel.requests.length, 1);
    assert.ok(runs.cancel.streams[0].clientCancelled || runs.cancel.streams[0].abortObserved);
  });
}


test('evidence matches current fixtures and lockfile and contains only mock provider dispatch', async () => {
  const report = await readReport();
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(report.fixtures.sha256, hash(await readFile(new URL('../fixtures/scenarios.json', import.meta.url))));
  assert.equal(report.lockfile.sha256, hash(await readFile(new URL('../package-lock.json', import.meta.url))));
  assert.equal(report.environment.bun, '1.4.4');
  for (const result of Object.values(report.frameworks)) {
    assert.equal(result.process.exitCode, 0);
    assert.equal(result.process.spawnError, undefined);
    assert.deepEqual(result.externalNetworkAttempts, []);
    for (const run of Object.values(result.cases)) {
      assert.equal(run.status, 'observed');
      assert.equal(run.settled, true);
      for (const request of run.requests) {
        assert.equal(request.url, 'https://calcifer.invalid/v1/chat/completions');
        assert.equal(request.body.max_completion_tokens, 512);
        assert.deepEqual(request.body.tools.map(tool => tool.function.name), ['fixture_tool']);
      }
    }
  }
});

test('process errors cannot be reported as successful CLI or SDK runs, and adapter hashes match', async () => {
  const report = await readReport();
  for (const framework of Object.values(report.frameworks)) assert.equal(framework.process.status, 'passed');
  for (const cli of Object.values(report.cli)) { assert.equal(cli.status, 'passed'); assert.equal(cli.error, undefined); assert.equal(cli.signal, null); }
  const probe = report.hostRuntimeSdkProbe;
  assert.equal(probe.runtime.name, 'node');
  assert.equal(probe.error, undefined);
  assert.equal(probe.signal, null);
  assert.ok(['passed', 'failed'].includes(probe.parsed.import));
  if (probe.parsed.import === 'failed') {
    assert.equal(probe.exitCode, 1);
    assert.equal(probe.sdkStatus, 'SDK import failed on host runtime');
    assert.equal(typeof probe.parsed.failure, 'string');
  } else {
    assert.equal(probe.exitCode, probe.parsed.cases.text_stop.status === 'observed' ? 0 : 1);
    assert.equal(probe.sdkStatus, probe.exitCode === 0 ? 'SDK smoke passed on host runtime' : 'SDK smoke failed on host runtime');
  }
  assert.ok(Object.keys(report.sourceManifest).includes('src/worker.mjs'));
  assert.ok(Object.keys(report.sourceManifest).includes('test/harness.test.mjs'));
  for (const [path, digest] of Object.entries(report.sourceManifest)) {
    assert.equal(createHash('sha256').update(await readFile(new URL('../' + path, import.meta.url))).digest('hex'), digest, path);
  }
});
