import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { platform, arch } from 'node:os';
const repo = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const runID = `offline-${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`;
const ledgerDirectory = join(repo, 'evidence/offline-ledgers', runID);
await mkdir(ledgerDirectory, { recursive: true });
const report = { runID, createdAt: new Date().toISOString(), scope: 'official SDK engineering integration with synthetic in-process fixtures only', liveRequests: 0,
  liveWindow: 'pending-owner-confirmation', humanAcceptance: 'pending', dataScope: 'full payload/events are synthetic only; native SDK sessions use isolated temporary paths and are removed; persistent guard ledger stores request hash and metadata, never prompt/response/key',
  environment: { node: process.version, os: platform(), arch: arch() }, dependencies: {}, sourceManifest: {}, fixtures: {}, ledgerDirectory, frameworks: {} };
for (const directory of ['src','test','fixtures']) for (const name of (await readdir(join(repo, directory))).sort()) {
  if (!name.endsWith('.mjs') && !name.endsWith('.json')) continue;
  const path = `${directory}/${name}`, sha256 = hash(await readFile(join(repo, path)));
  if (directory === 'fixtures') report.fixtures[path] = sha256; else report.sourceManifest[path] = sha256;
}
for (const name of ['package.json','package-lock.json']) report.sourceManifest[name] = hash(await readFile(join(repo, name)));
for (const name of ['@opencode/sdk','@earendil-works/pi-coding-agent','@earendil-works/pi-ai','bun']) report.dependencies[name] = JSON.parse(await readFile(join(repo, 'node_modules', name, 'package.json'))).version;
const env = { PATH: process.env.PATH }, bun = resolve(repo, 'node_modules/.bin/bun');
for (const framework of ['opencode','pi']) {
  const result = spawnSync(bun, [join(repo,'src/worker.mjs'), framework, '--selfhost', ledgerDirectory, runID], { cwd: repo, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  let parsed;
  try { const marker = result.stdout?.lastIndexOf('CALCIFER_RESULT=') ?? -1; if (marker < 0) throw new Error('Missing result'); parsed = JSON.parse(result.stdout.slice(marker + 16).trim()); }
  catch (error) { parsed = { import: 'failed', failure: error.message }; }
  parsed.process = { status: !result.error && !result.signal && result.status === 0 ? 'passed' : 'failed', exitCode: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr };
  report.frameworks[framework] = parsed;
  console.log(framework, parsed.import, Object.entries(parsed.cases ?? {}).map(([name,c]) => `${name}:${c.status}/${c.requests.length}`).join(' '));
}
report.ledgers = {};
for (const name of (await readdir(ledgerDirectory)).sort()) {
  const content = await readFile(join(ledgerDirectory,name));
  report.ledgers[name] = { sha256: hash(content), events: content.toString('utf8').trim().split('\n').map(line => JSON.parse(line)) };
}
const path = `evidence/runs/${runID}.json`;
await writeFile(join(repo,path), JSON.stringify(report,null,2) + '\n', { flag: 'wx' });
await writeFile(join(repo,'evidence/offline-latest.json'), JSON.stringify({ runID, path, sha256: hash(await readFile(join(repo,path))) }, null, 2) + '\n');
console.log(path);
if (Object.values(report.frameworks).some(f => f.import !== 'passed' || f.process.status !== 'passed' || Object.values(f.cases ?? {}).some(c => c.status !== 'observed'))) process.exitCode = 1;
