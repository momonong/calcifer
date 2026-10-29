import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { reopenGoal } from './goal-runner.mjs';
try {
  const [command, ...args] = process.argv.slice(2), values = new Map();
  if (!['demo','reopen'].includes(command) || process.versions.bun) throw new Error('NODE_GOAL_CLI_REQUIRED');
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!(command === 'demo' ? ['--framework','--state-root','--example'] : ['--state-root','--run-id']).includes(key) || values.has(key) || !value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    values.set(key,value);
  }
  const stateRoot = values.get('--state-root');
  if (!stateRoot || resolve(stateRoot) !== stateRoot || command === 'reopen' && !values.has('--run-id')) throw new Error('INVALID_ARGUMENTS');
  let result;
  if (command === 'reopen') result = await reopenGoal({ stateRoot, runID: values.get('--run-id') });
  else {
    const framework = values.get('--framework') ?? 'opencode'; if (!['opencode','pi','mixed'].includes(framework)) throw new Error('INVALID_FRAMEWORK');
    const example = values.get('--example') ?? 'data'; if (!['data','json-cli'].includes(example)) throw new Error('INVALID_EXAMPLE');
    const bun = fileURLToPath(new URL('../node_modules/.bin/bun', import.meta.url)), childFile = fileURLToPath(new URL('./goal-child.mjs', import.meta.url));
    const outcome = await new Promise((accept, reject) => {
      const child = spawn(bun, [childFile, framework, stateRoot, process.execPath, example], { env: { PATH: process.env.PATH }, stdio: ['ignore','pipe','pipe'] });
      let stdout = '', stderr = '', exceeded = false;
      const stop = () => child.kill('SIGTERM'); process.on('SIGINT',stop); process.on('SIGTERM',stop);
      const timer = setTimeout(() => { stop(); setTimeout(() => child.kill('SIGKILL'),1000).unref(); },125000);
      child.stdout.on('data', bytes => { stdout += bytes.toString(); if (Buffer.byteLength(stdout) > 1048576) { exceeded = true; stop(); } });
      child.stderr.on('data', bytes => { if (Buffer.byteLength(stderr) < 16384) stderr += bytes.toString().slice(0,16384); });
      child.once('error',reject);
      child.once('close',(exitCode,signal) => {
        clearTimeout(timer); process.off('SIGINT',stop); process.off('SIGTERM',stop);
        if (exceeded || signal) return reject(new Error('GOAL_CHILD_RESULT_UNKNOWN'));
        try { const line = stdout.split('\n').find(item => item.startsWith('CALCIFER_GOAL_RESULT=')); if (!line) throw new Error('GOAL_CHILD_RESULT_UNKNOWN'); accept({ ...JSON.parse(line.slice(21)), exitCode }); } catch (error) { reject(error); }
      });
    });
    if (!outcome.runID) throw new Error(outcome.code ?? 'GOAL_CHILD_RESULT_UNKNOWN');
    result = await reopenGoal({ stateRoot, runID: outcome.runID });
    if (outcome.exitCode !== 0 && result.status === 'completed') throw new Error('GOAL_CHILD_RESULT_UNKNOWN');
    delete result.reopenedWithoutSDK;
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, status: result.status, code: result.code, runID: result.runID,
    acceptanceKind: result.acceptanceKind, runtimeCorrectness: result.runtimeCorrectness, generalTestFrameworks: result.generalTestFrameworks, provenance: result.provenance,
    syntheticModelRequests: result.syntheticModelRequests, actualModelRequests: 0, requestCounts: result.requestCounts, reservedOutputTokens: result.reservedOutputTokens,
    integrationAccepted: result.integrationAccepted, finalManifestHash: result.inner?.finalManifestHash,
    checks: result.inner?.checks.map(({ checkId, kind, status, code, manifestHash, definitionHash, inputHash, entryHash, cases, remainingCaseIds }) => ({ checkId, kind, status, code, manifestHash, definitionHash, inputHash, entryHash, cases: cases?.map(({ id, status, code, comparison }) => ({ id, status, code, comparison })), remainingCaseIds })), artifacts: result.inner?.artifacts, reopenedWithoutSDK: result.reopenedWithoutSDK })+'\n');
  if (result.status !== 'completed') process.exitCode=1;
} catch (error) { console.log(JSON.stringify({ schemaVersion: 1, status: 'rejected', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'GOAL_FAILED', actualModelRequests: 0 })); process.exitCode=1; }
