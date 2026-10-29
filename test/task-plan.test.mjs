import test from 'node:test';
import assert from 'node:assert/strict';

import { validateTaskPlan } from '../src/task-plan.mjs';
const scope = { allowedPaths: ['src/example.mjs'], allowedCheckIds: ['fixture-check'] };
const task = (id, dependsOn = []) => ({ id, instruction: `Perform ${id}`, dependsOn,
  requiredCapabilities: [id], writePaths: [], checkIds: [] });
const plan = () => ({ schemaVersion: 1, goal: 'Update a synthetic example',
  tasks: [task('analysis'), { ...task('edit', ['analysis']), writePaths: ['src/example.mjs'] },
    { ...task('verify', ['edit']), checkIds: ['fixture-check'] }] });

test('valid DAG is returned independently from input and host allowlists', () => {
  const input = plan();
  const actual = validateTaskPlan(input, scope);
  assert.deepEqual(actual, input);
  actual.tasks[1].writePaths.push('other.mjs');
  assert.deepEqual(input.tasks[1].writePaths, ['src/example.mjs']);
  assert.deepEqual(scope.allowedPaths, ['src/example.mjs']);
});

for (const [name, change, code] of [
  ['cycle', p => { p.tasks[0].dependsOn = ['verify']; }, 'CYCLIC_DEPENDENCY'],
  ['unknown dependency', p => { p.tasks[1].dependsOn = ['missing']; }, 'UNKNOWN_DEPENDENCY'],
  ['duplicate task ID', p => { p.tasks[1].id = 'analysis'; }, 'DUPLICATE_TASK_ID'],
  ['more than four tasks', p => { p.tasks.push(task('four'), task('five')); }, 'TASK_LIMIT'],
  ['empty task list', p => { p.tasks = []; }, 'TASK_LIMIT'],
  ['blank goal', p => { p.goal = '  '; }, 'INVALID_GOAL'],
  ['blank instruction', p => { p.tasks[0].instruction = '  '; }, 'INVALID_INSTRUCTION'],
  ['wrong schema version', p => { p.schemaVersion = '1'; }, 'INVALID_SCHEMA_VERSION'],
  ['wrong dependency type', p => { p.tasks[0].dependsOn = 'edit'; }, 'INVALID_DEPENDENCIES'],
  ['wrong capability type', p => { p.tasks[0].requiredCapabilities = [1]; }, 'INVALID_CAPABILITIES'],
  ['duplicate dependencies', p => { p.tasks[1].dependsOn = ['analysis', 'analysis']; }, 'INVALID_DEPENDENCIES'],
  ['unknown plan permission', p => { p.endpoint = 'synthetic-endpoint'; }, 'UNKNOWN_PLAN_FIELD'],
  ['unknown task permission', p => { p.tasks[0].tools = ['arbitrary-command']; }, 'UNKNOWN_TASK_FIELD'],
  ['unlisted write path', p => { p.tasks[1].writePaths = ['src/other.mjs']; }, 'PATH_NOT_ALLOWED'],
  ['unlisted check ID', p => { p.tasks[2].checkIds = ['arbitrary-shell']; }, 'CHECK_NOT_ALLOWED'],
]) {
  test(`plan rejects ${name}`, () => {
    const input = plan(); change(input);
    assert.throws(() => validateTaskPlan(input, scope), new RegExp(code));
  });
}

test('path allowlists use exact portable relative files and reject traversal before matching', () => {
  for (const path of ['../escape.mjs', '/absolute.mjs', 'src/../escape.mjs', './example.mjs',
    'src//example.mjs', 'C:/example.mjs', 'src\\example.mjs', 'src/', 'src/*.mjs']) {
    const input = plan(); input.tasks[1].writePaths = [path];
    assert.throws(() => validateTaskPlan(input, scope), /INVALID_PATH/);
    assert.throws(() => validateTaskPlan(input, { ...scope, allowedPaths: [path] }), /INVALID_ALLOWED_PATHS/);
  }
  const input = plan();
  assert.throws(() => validateTaskPlan(input, { ...scope, allowedPaths: ['src'] }), /PATH_NOT_ALLOWED/);
});

test('maxTasks may narrow but cannot raise the product limit or disable host validation', () => {
  assert.throws(() => validateTaskPlan(plan(), { ...scope, maxTasks: 2 }), /TASK_LIMIT/);
  assert.throws(() => validateTaskPlan(plan(), { ...scope, maxTasks: 5 }), /INVALID_MAX_TASKS/);
  assert.throws(() => validateTaskPlan(plan(), {}), /INVALID_ALLOWED_PATHS/);
  const input = plan(); input.tasks.push(task('four'));
  assert.equal(validateTaskPlan(input, scope).tasks.length, 4);
});

test('write declarations require edit capability before routing', () => {
  const input = plan(); input.tasks[1].requiredCapabilities = ['analysis'];
  assert.throws(() => validateTaskPlan(input, scope), /EDIT_CAPABILITY_REQUIRED/);
});

test('check declarations require verify capability before routing', () => {
  const input = plan(); input.tasks[2].requiredCapabilities = ['analysis'];
  assert.throws(() => validateTaskPlan(input, scope), /VERIFY_CAPABILITY_REQUIRED/);
});
