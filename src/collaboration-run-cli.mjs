import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename, resolve } from 'node:path';
import { readText, pathList } from './workspace-tools.mjs';
import { runCollaboration, reopenRun } from './collaboration-runner.mjs';

const provenance = { kind: 'mock', generations: 0, remoteInference: 'not_applicable' };
let knownRunID;
const summarize = check => check.kind !== 'node-npm-repo' ? check : ({ checkId: check.checkId, kind: check.kind, status: check.status, code: check.code, manifestHash: check.manifestHash, definitionHash: check.definitionHash,
  npm: check.npm ? { closed: check.npm.process.closed, exitCode: check.npm.process.exitCode, signal: check.npm.process.signal, code: check.npm.process.outputLimit ? 'CHECK_OUTPUT_LIMIT' : undefined } : undefined,
  oracle: check.oracle ? { status: check.oracle.status, code: check.oracle.code, cases: check.oracle.cases.map(({ id, status, code, comparison }) => ({ id, status, code, comparison })), remainingCaseIds: check.oracle.remainingCaseIds } : undefined });
try {
  const [command, ...args] = process.argv.slice(2), options = new Map();
  if (!['demo', 'reopen', 'repo-check'].includes(command)) throw new Error('USAGE_DEMO_OR_REOPEN_REQUIRED');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!(command === 'demo' ? ['--state-root'] : command === 'repo-check' ? ['--repo', '--contract', '--state-root'] : ['--state-root', '--run-id']).includes(key)
      || options.has(key) || !value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    options.set(key, value);
  }
  if (!options.has('--state-root') || command === 'reopen' && !options.has('--run-id')) throw new Error('INVALID_ARGUMENTS');
  let result, executionMode, reopenedWithoutExecution;
  if (command === 'reopen') {
    knownRunID = options.get('--run-id');
    const state = await reopenRun({ stateRoot: options.get('--state-root'), runID: options.get('--run-id') });
    result = { ...state.report, runID: state.metadata.runID, status: state.status, unknown: state.unknown };
    executionMode = 'readonly-host-reopen'; reopenedWithoutExecution = true;
  } else if (command === 'repo-check') {
    if (process.versions.bun || !options.has('--repo') || !options.has('--contract')) throw new Error('INVALID_ARGUMENTS');
    const sourceDir = options.get('--repo'), contractPath = options.get('--contract');
    if (resolve(sourceDir) !== sourceDir || resolve(contractPath) !== contractPath) throw new Error('CANONICAL_PATH_REQUIRED');
    const contract = JSON.parse((await readText(dirname(contractPath), basename(contractPath), { writable: true })).content);
    if (!contract || contract.schemaVersion !== 1 || Object.keys(contract).some(key => !['schemaVersion','sourceFiles','check'].includes(key)) || !Array.isArray(contract.sourceFiles) || contract.check?.kind !== 'node-npm-repo') throw new Error('INVALID_REPO_CONTRACT');
    pathList(contract.sourceFiles);
    const host = { sourceDir, stateRoot: options.get('--state-root'), sourceFiles: contract.sourceFiles, readPaths: contract.sourceFiles,
      allowedPaths: [], allowedCheckIds: ['repo-contract'], finalCheckIds: ['repo-contract'], checks: { 'repo-contract': contract.check }, hostNodeBinary: process.execPath,
      profiles: [{ id: 'local-check-placeholder', framework: 'opencode', model: 'not-instantiated', capabilities: [], priority: 1, enabled: true, mode: 'mock' }],
      authorization: { allowedProfileIds: ['local-check-placeholder'], mode: 'mock' } };
    const plan = { schemaVersion: 1, goal: 'Validate the fixed caller npm repository contract', tasks: [{ id: 'repo-check', instruction: 'Host-only final check; no model or edit', dependsOn: [], requiredCapabilities: [], writePaths: [], checkIds: [] }] };
    result = await runCollaboration({ plan, host, worker: async () => ({ status: 'completed' }) }); knownRunID = result.runID;
    const verified = await reopenRun({ stateRoot: host.stateRoot, runID: result.runID }); result = { ...verified.report, runID: verified.metadata.runID, status: verified.status, unknown: verified.unknown };
    executionMode = 'local-host-check';
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
    provenance, executionMode, frameworkInstantiated: false, modelRequests: 0, reopenedWithoutExecution, unknown: result.unknown?.map(({ id, kind, stage, caseId }) => ({ id, kind, stage, caseId })), initialManifestHash: result.initialManifestHash, finalManifestHash: result.finalManifestHash, integrationAccepted: result.integrationAccepted, artifacts: result.artifacts, checks: result.checks?.map(summarize) }) + '\n');
  if (result.status !== 'completed') process.exitCode = 1;
} catch (error) {
  const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'INPUT_OR_RUN_FAILED';
  process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'rejected', runID: knownRunID, provenance, code }) + '\n');
  process.exitCode = 1;
}
