import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runCollaboration, reopenRun } from './collaboration-runner.mjs';

const provenance = { kind: 'mock', generations: 0, remoteInference: 'not_applicable' };
try {
  const [command, ...args] = process.argv.slice(2), options = new Map();
  if (!['demo', 'reopen'].includes(command)) throw new Error('USAGE_DEMO_OR_REOPEN_REQUIRED');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!(command === 'demo' ? ['--state-root'] : ['--state-root', '--run-id']).includes(key)
      || options.has(key) || !value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    options.set(key, value);
  }
  if (!options.has('--state-root') || command === 'reopen' && !options.has('--run-id')) throw new Error('INVALID_ARGUMENTS');
  let result;
  if (command === 'reopen') {
    const state = await reopenRun({ stateRoot: options.get('--state-root'), runID: options.get('--run-id') });
    result = { ...state.report, status: state.status };
  } else {
    const sourceDir = fileURLToPath(new URL('../fixtures/collaboration/demo/', import.meta.url)).replace(/\/$/, '');
    const plan = JSON.parse(await readFile(join(sourceDir, 'plan.json'), 'utf8'));
    const host = { sourceDir, stateRoot: options.get('--state-root'), sourceFiles: ['note.txt'], readPaths: ['note.txt'],
      allowedPaths: ['note.txt'], allowedCheckIds: ['demo-final'], finalCheckIds: ['demo-final'],
      checks: { 'demo-final': { kind: 'node-data', scriptPath: join(sourceDir, 'check.mjs') } },
      profiles: [{ id: 'mock-worker', framework: 'opencode', model: 'synthetic-worker', capabilities: ['edit'],
        priority: 1, enabled: true, mode: 'mock' }], authorization: { allowedProfileIds: ['mock-worker'], mode: 'mock' } };
    result = await runCollaboration({ plan, host, worker: async ({ task, tools }) => {
      if (!['first', 'second'].includes(task.id)) throw new Error('DEMO_TASK_UNKNOWN');
      const file = await tools.dispatch({ action: 'read', args: { path: 'note.txt' } });
      await tools.dispatch({ action: 'edit', args: { path: 'note.txt', expectedHash: file.hash, content: file.content + task.id + '\n' } });
      return { status: 'completed' };
    } });
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, status: result.status, code: result.code, runID: result.runID,
    provenance, finalManifestHash: result.finalManifestHash, artifacts: result.artifacts, checks: result.checks }) + '\n');
  if (result.status !== 'completed') process.exitCode = 1;
} catch (error) {
  const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'INPUT_OR_RUN_FAILED';
  process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'rejected', provenance, code }) + '\n');
  process.exitCode = 1;
}
