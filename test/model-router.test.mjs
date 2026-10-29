import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { routeTask, planAssignments } from '../src/model-router.mjs';
const task = (id = 'analysis', requiredCapabilities = ['analysis']) => ({ id, instruction: `Perform ${id}`,
  dependsOn: [], requiredCapabilities, writePaths: [], checkIds: [] });
const profile = (id, capabilities = ['analysis'], priority = 10) => ({ id, framework: 'opencode',
  model: `synthetic-${id}`, capabilities, priority, enabled: true, mode: 'mock' });
const authorization = { allowedProfileIds: ['alpha', 'beta'], mode: 'mock' };

test('router requires every capability and explains eligibility and exclusions', () => {
  const actual = routeTask(task('edit', ['analysis', 'edit']),
    [profile('alpha'), profile('beta', ['analysis', 'edit'], 20)], authorization);
  assert.equal(actual.status, 'assigned'); assert.equal(actual.profileId, 'beta');
  assert.equal(actual.reason.code, 'CAPABILITIES_PRIORITY_ID');
  assert.deepEqual(actual.reason.eligibleProfileIds, ['beta']);
  assert.deepEqual(actual.reason.excludedProfiles, [{ profileId: 'alpha',
    reasons: ['MISSING_CAPABILITIES'], missingCapabilities: ['edit'] }]);
});

test('priority then ID remains stable across registry reorder and never mutates inputs', () => {
  const profiles = [profile('beta'), profile('alpha'), profile('gamma', ['analysis'], 1)];
  const snapshot = structuredClone(profiles);
  const expected = routeTask(task(), profiles, authorization);
  assert.equal(expected.profileId, 'alpha');
  assert.deepEqual(expected, routeTask(task(), [...profiles].reverse(), authorization));
  assert.deepEqual(profiles, snapshot);
  assert.equal(routeTask(task(), [profile('alpha', ['analysis'], 20), profile('beta')], authorization).profileId, 'beta');
});

test('unauthorized, disabled, mode mismatch and missing capability never trigger fallback', () => {
  for (const profiles of [
    [profile('unapproved', ['analysis'], -100)],
    [{ ...profile('alpha'), enabled: false }],
    [{ ...profile('alpha'), mode: 'live' }],
    [profile('alpha', ['edit'])],
    []
  ]) {
    const actual = routeTask(task(), profiles, authorization);
    assert.equal(actual.status, 'rejected');
    assert.equal(actual.code, 'NO_ELIGIBLE_PROFILE');
    assert.equal('profileId' in actual, false);
  }
  assert.throws(() => routeTask(task(), [profile('alpha')], { ...authorization, mode: 'live' }), /LIVE_MODE_UNAVAILABLE/);
});

test('malformed profiles and permissions fail closed instead of being ignored', () => {
  for (const change of [p => { p.endpoint = 'synthetic-endpoint'; }, p => { p.priority = NaN; },
    p => { p.enabled = 'true'; }, p => { p.capabilities = 'analysis'; }, p => { p.framework = 'other'; }]) {
    const input = profile('alpha'); change(input);
    assert.throws(() => routeTask(task(), [input], authorization));
  }
  assert.throws(() => routeTask(task(), [profile('alpha'), profile('alpha')], authorization), /DUPLICATE_PROFILE_ID/);
  assert.throws(() => routeTask(task(), [profile('alpha')], {}), /INVALID_AUTHORIZATION/);
  assert.throws(() => routeTask({ ...task(), profileId: 'alpha' }, [profile('alpha')], authorization), /UNKNOWN_TASK_FIELD/);
});

test('one unrouteable required task rejects the complete plan with no partial assignments', () => {
  const plan = { schemaVersion: 1, goal: 'Synthetic goal', tasks: [task(), task('edit', ['edit'])] };
  const profiles = [profile('alpha')];
  const actual = planAssignments(plan, profiles, authorization);
  assert.equal(actual.status, 'rejected'); assert.equal(actual.code, 'UNROUTABLE_PLAN');
  assert.deepEqual(actual.assignments, []);
  assert.deepEqual(actual.rejections.map(r => r.taskId), ['edit']);
  const complete = planAssignments(plan, [...profiles, profile('beta', ['edit'])], authorization);
  assert.equal(complete.status, 'assigned');
  assert.deepEqual(complete.assignments.map(a => [a.taskId, a.profileId]), [['analysis', 'alpha'], ['edit', 'beta']]);
});

const root = new URL('../', import.meta.url);
const cli = (...args) => spawnSync(process.execPath, ['src/collaboration-cli.mjs', ...args], { cwd: root, encoding: 'utf8' });
test('CLI is repeatable, machine readable and explicitly mock planning only', async () => {
  const args = ['--plan', 'fixtures/collaboration/plan.json', '--registry', 'fixtures/collaboration/mock-registry.json'];
  const first = cli(...args), second = cli(...args);
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  const actual = JSON.parse(first.stdout);
  assert.deepEqual(actual.provenance, { kind: 'mock', modelRequests: 0, executesTasks: false });
  assert.deepEqual(actual.assignments.map(a => [a.taskId, a.profileId]),
    [['analysis', 'mock-analysis'], ['edit', 'mock-edit'], ['verify', 'mock-analysis']]);
});

test('CLI rejects bad JSON, expanded registry authority, live mode and incomplete routing with nonzero exits', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'calcifer-routing-'));
  try {
    const plan = JSON.parse(await readFile(new URL('../fixtures/collaboration/plan.json', import.meta.url)));
    const registry = JSON.parse(await readFile(new URL('../fixtures/collaboration/mock-registry.json', import.meta.url)));
    const planPath = join(temp, 'plan.json'), registryPath = join(temp, 'registry.json');
    await writeFile(planPath, JSON.stringify(plan));
    for (const change of [r => { r.authorization.mode = 'live'; }, r => { r.endpoint = 'synthetic-endpoint'; },
      r => { r.authorization.allowedProfileIds = []; }]) {
      const modified = structuredClone(registry); change(modified);
      await writeFile(registryPath, JSON.stringify(modified));
      const result = cli('--plan', planPath, '--registry', registryPath);
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).status, 'rejected');
    }
    await writeFile(planPath, '{');
    await writeFile(registryPath, JSON.stringify(registry));
    assert.notEqual(cli('--plan', planPath, '--registry', registryPath).status, 0);
    assert.notEqual(cli('--plan', planPath, '--plan', planPath, '--registry', registryPath).status, 0);
    assert.notEqual(cli().status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
