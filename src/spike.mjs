import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, release, arch, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
const repo = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const bun = resolve(repo, 'node_modules/.bin/bun');
const runID = `${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`;
await mkdir(join(repo, 'evidence/runs'), { recursive: true });
const env = { PATH: process.env.PATH };
const processStatus = result => result.error || result.signal || result.status !== 0 ? 'failed' : 'passed';
const bunProbe = spawnSync(bun, ['--version'], { env, encoding: 'utf8' });
const report = { runtimeProbe: { status: processStatus(bunProbe), exitCode: bunProbe.status, signal: bunProbe.signal, error: bunProbe.error?.message }, runID, createdAt: new Date().toISOString(), scope: 'scripted mock harness engineering characterization only',
  sourceBaselines: { opencode: '68bc26b7da1990ce10ffecfbc1e09eb13aa5d824', pi: '4a080252f06caf63a525d7873c5d94d3c23887e0' },
  environment: { node: process.version, bun: bunProbe.stdout?.trim() ?? 'unavailable', os: platform(), kernel: release(), arch: arch() },
  dependencies: {}, sourceManifest: {}, fixtures: { sha256: hash(await readFile(join(repo, 'fixtures/scenarios.json'))) },
  lockfile: { sha256: hash(await readFile(join(repo, 'package-lock.json'))) },
  realModel: { quality: 'pending', latency: 'unknown', cost: 'unknown', quota: 'unknown', humanAcceptance: 'pending' },
  provenance: { taskRuns: 'framework E2E with official SDK/provider protocol and synthetic tools', receiptPolicy: 'local fixture integrated at framework boundary',
    unknownModelPostResult: 'pending: no durable model POST request ledger or restart guarantee tested',
    recoveryLimit: 'clean failed-session close/reopen readback; unclean process crash and at-least-once replay pending',
    cli: 'version smoke only; no CLI task E2E', compaction: 'disabled; summary fidelity pending' }, frameworks: {} };
for (const directory of ['src', 'test']) {
  for (const name of (await readdir(join(repo,directory))).sort()) {
    if (name.endsWith('.mjs')) report.sourceManifest[`${directory}/${name}`] = hash(await readFile(join(repo,directory,name)));
  }
}
report.sourceManifest['package.json'] = hash(await readFile(join(repo,'package.json')));
for (const name of ['@opencode/sdk','@opencode/plugin','@opencode/cli','@earendil-works/pi-coding-agent','@earendil-works/pi-ai','bun']) {
  report.dependencies[name] = JSON.parse(await readFile(join(repo, 'node_modules', name, 'package.json'), 'utf8')).version;
}
for (const framework of ['opencode','pi']) {
  const result = spawnSync(bun, [join(repo, 'src/worker.mjs'), framework], { cwd: repo, env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const marker = result.stdout?.lastIndexOf('CALCIFER_RESULT=') ?? -1;
  if (marker >= 0) {
    try { report.frameworks[framework] = JSON.parse(result.stdout.slice(marker + 16).trim()); }
    catch (error) { report.frameworks[framework] = { import: 'failed', failure: error.message, stdout: result.stdout }; }
  } else report.frameworks[framework] = { import: 'failed', failure: result.error?.message ?? `process exit ${result.status}`, stdout: result.stdout };
  report.frameworks[framework].process = { status: processStatus(result), exitCode: result.status, signal: result.signal, stderr: result.stderr, spawnError: result.error?.message, runtime: `Bun ${report.environment.bun}` };
}
// Characterize the actual host runtime independently of the common Bun task runs.
const nodeProbe = spawnSync(process.execPath, [join(repo, 'src/worker.mjs'), 'opencode', 'text_stop'], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
let nodeParsed;
try { nodeParsed = JSON.parse(nodeProbe.stdout.slice(nodeProbe.stdout.lastIndexOf('CALCIFER_RESULT=') + 16).trim()); } catch {}
const wellFormedHostProbe = !nodeProbe.error && !nodeProbe.signal && nodeParsed &&
  ((nodeParsed.import === 'failed' && nodeProbe.status === 1) ||
    (nodeParsed.import === 'passed' && nodeParsed.cases?.text_stop &&
      nodeProbe.status === (nodeParsed.cases.text_stop.status === 'observed' ? 0 : 1)));
report.hostRuntimeSdkProbe = { provenance: 'official SDK host runtime characterization', exitCode: nodeProbe.status, signal: nodeProbe.signal, error: nodeProbe.error?.message,
  stderr: nodeProbe.stderr, result: nodeProbe.stdout, parsed: nodeParsed,
  runtime: { name: process.versions.bun ? 'bun' : 'node', version: process.versions.bun ?? process.versions.node },
  sdkStatus: !wellFormedHostProbe ? 'infrastructure failure or malformed result' :
    nodeParsed.import === 'failed' ? 'SDK import failed on host runtime' :
    nodeProbe.status === 0 ? 'SDK smoke passed on host runtime' : 'SDK smoke failed on host runtime' };

const cliDir = await mkdtemp(join(tmpdir(), 'calcifer-cli-version-'));
try {
  const cliEnv = { ...env, XDG_CONFIG_HOME: join(cliDir,'config'), XDG_DATA_HOME: join(cliDir,'data'), XDG_CACHE_HOME: join(cliDir,'cache'),
    XDG_STATE_HOME: join(cliDir,'state'), OPENCODE_TEST_HOME: join(cliDir,'test-home'), PI_CODING_AGENT_DIR: join(cliDir,'pi') };
  report.cli = {};
  for (const [name, command, args] of [['opencode', join(repo,'node_modules/.bin/opencode'), ['--version']],
    ['pi', bun, [join(repo,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--version']]]) {
    const result = spawnSync(command,args,{cwd:cliDir,env:cliEnv,encoding:'utf8',timeout:15000});
    report.cli[name] = { provenance:'CLI version smoke', status:processStatus(result), signal:result.signal, exitCode:result.status, stdout:result.stdout?.trim(), stderr:result.stderr, error:result.error?.message };
  }
} finally { await rm(cliDir,{recursive:true,force:true}); }
const path = `evidence/runs/${runID}.json`;
await writeFile(join(repo,path), JSON.stringify(report,null,2)+'\n', { flag: 'wx' });
await writeFile(join(repo,'evidence/latest.json'), JSON.stringify({runID,path,sha256:hash(await readFile(join(repo,path)))},null,2)+'\n');
for (const [framework,result] of Object.entries(report.frameworks)) console.log(framework, result.import,
  Object.entries(result.cases ?? {}).map(([name,c]) => `${name}:${c.status}/${c.requests.length}`).join(' '));
console.log(path);
const failed = report.runtimeProbe.status !== 'passed' || Object.values(report.cli).some(result => result.status !== 'passed') ||
  !wellFormedHostProbe || Object.values(report.frameworks).some(result => result.process.status !== 'passed' || result.import !== 'passed' || Object.values(result.cases ?? {}).some(c => c.status === 'failed'));
if (failed) process.exitCode=1;
