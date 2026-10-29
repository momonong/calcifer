import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, hash } from './helpers/collaboration.mjs';
import { runNodeDataCheck } from '../src/sandbox-check.mjs';
import { runCollaboration, reopenRun } from '../src/collaboration-runner.mjs';
async function input(f, files = { 'note.txt': 'draft\n' }) {
  const entries = Object.keys(files).sort().map(path => ({ path, hash: hash(files[path]), bytes: Buffer.byteLength(files[path]) }));
  const value = { schemaVersion: 1, manifest: { files: entries, hash: hash(JSON.stringify(entries)) }, files };
  const source = JSON.stringify(value), inputPath = join(f.root, 'snapshot.json'); await writeFile(inputPath, source);
  return { inputPath, expectedInputHash: hash(source), expectedManifestHash: value.manifest.hash };
}
const run = (f, data, scriptPath, extra = {}) => runNodeDataCheck({ ...data, scriptPath, ...extra });
const readData = "import {readFile} from 'node:fs/promises';const snapshot=JSON.parse(await readFile('/input/snapshot.json','utf8'));";

test('node-data check accepts correct data and rejects wrong content without executing source', async () => {
  const f = await fixture(), scriptPath = join(f.root, 'check.mjs');
  try {
    await writeFile(scriptPath, "import assert from 'node:assert/strict';" + readData + "assert.equal(snapshot.files['note.txt'],'draft\\n');");
    for (const [content, expected] of [['draft\n', 'passed'], ['wrong\n', 'failed']]) {
      const result = await run(f, await input(f, { 'note.txt': content }), scriptPath);
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.kind, 'node-data');
    }
  } finally { await f.cleanup(); }
});

test('early exit and binary event forgery programs remain inert JSON strings', async () => {
  const f = await fixture(), scriptPath = join(f.root, 'check.mjs');
  try {
    await writeFile(scriptPath, "import assert from 'node:assert/strict';" + readData +
      "assert.equal(snapshot.files['note.txt'],'draft\\n');assert.equal(typeof snapshot.files['module.mjs'],'string');console.log('trusted-data-check-reached');");
    const payloads = [
      "process.exit(0);export const value=0;",
      "import{DefaultSerializer}from'node:v8';import{writeSync}from'node:fs';const send=item=>{const s=new DefaultSerializer();s.writeHeader();const h=s.releaseBuffer().length;s.writeHeader();s.writeRawBytes(Buffer.alloc(4));s.writeHeader();s.writeValue(item);const b=s.releaseBuffer();b.writeUInt32BE(b.length-4-h,h);writeSync(1,b);};const data={name:'host-check',file:'/check/harness.test.mjs',line:2,column:1,nesting:0,testNumber:1,details:{passed:true,type:'test',duration_ms:1}};send({type:'test:complete',data});send({type:'test:pass',data});send({type:'test:summary',data:{success:true,file:'/check/harness.test.mjs',counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0,suites:0,topLevel:1}}});process.exit(0);export const value=0;",
      "console.log('TAP version 13\\nok 1 - host-check');process.exit(0);"
    ];
    for (const payload of payloads) {
      const result = await run(f, await input(f, { 'note.txt': 'draft\n', 'module.mjs': payload }), scriptPath);
      assert.equal(result.status, 'passed', result.stderr);
      assert.equal(result.stdout.trim(), 'trusted-data-check-reached');
    }
    await writeFile(scriptPath, "import assert from 'node:assert/strict';" + readData + "assert.equal(snapshot.files['module.mjs'],'export const value=42;');");
    assert.equal((await run(f, await input(f, { 'module.mjs': payloads[0] }), scriptPath)).status, 'failed');
  } finally { await f.cleanup(); }
});

test('node-data adapter exposes only readonly JSON, not executable workspace or host environment', async () => {
  const f = await fixture(), scriptPath = join(f.root, 'check.mjs'), canary = join(f.root, 'canary.txt');
  process.env.CALCIFER_SYNTHETIC_SECRET = 'must-not-cross';
  try {
    await writeFile(canary, 'host-only'); await writeFile(join(f.host.sourceDir, 'module.mjs'), 'process.exit(0);');
    await writeFile(scriptPath, "import assert from 'node:assert/strict';import{writeFile}from'node:fs/promises';" + readData + `
assert.equal(process.env.CALCIFER_SYNTHETIC_SECRET,undefined);
await assert.rejects(readFile(${JSON.stringify(canary)}),{code:'ENOENT'});
await assert.rejects(import('/workspace/module.mjs'),{code:'ERR_MODULE_NOT_FOUND'});
await assert.rejects(readFile('/workspace/module.mjs'),{code:'ENOENT'});
await assert.rejects(writeFile('/input/snapshot.json','forbidden'),{code:'EROFS'});
await assert.rejects(writeFile('/check/check.mjs','forbidden'),{code:'EROFS'});`);
    const result = await run(f, await input(f), scriptPath);
    assert.equal(result.status, 'passed', result.stderr);
    assert.equal(await readFile(join(f.host.sourceDir, 'module.mjs'), 'utf8'), 'process.exit(0);');
  } finally { delete process.env.CALCIFER_SYNTHETIC_SECRET; await f.cleanup(); }
});

test('trusted node-data scripts still have bounded timeout and output', async () => {
  const f = await fixture(), scriptPath = join(f.root, 'check.mjs');
  try {
    const data = await input(f);
    await writeFile(scriptPath, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
    assert.equal((await run(f, data, scriptPath, { timeoutMs: 100 })).code, 'CHECK_TIMEOUT_OR_TERMINATED');
    await writeFile(scriptPath, "console.log('x'.repeat(10000));");
    const result = await run(f, data, scriptPath, { maxOutputBytes: 128 });
    assert.equal(result.code, 'CHECK_OUTPUT_LIMIT'); assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 128);
  } finally { await f.cleanup(); }
});

test('node-data rejects missing runtime, wrong manifest and changed input hash', async () => {
  const f = await fixture(), scriptPath = join(f.root, 'check.mjs');
  try {
    await writeFile(scriptPath, 'process.exitCode=0;'); const data = await input(f);
    await assert.rejects(run(f, data, scriptPath, { hostNodeBinary: join(f.root, 'missing', 'node') }), /CHECK_ISOLATION_UNAVAILABLE/);
    await assert.rejects(run(f, { ...data, expectedManifestHash: 'wrong' }, scriptPath), /CHECK_INPUT_MISMATCH/);
    await writeFile(data.inputPath, '{}');
    await assert.rejects(run(f, data, scriptPath), /CHECK_INPUT_MISMATCH/);
  } finally { await f.cleanup(); }
});

test('runner node-data final check binds immutable data, script and protocol and reopens readonly', async () => {
  const f = await fixture(), scriptPath = join(f.root, 'check.mjs');
  try {
    await writeFile(scriptPath, "import assert from 'node:assert/strict';" + readData + "assert.equal(snapshot.files['note.txt'],'draft\\nfirst\\nsecond\\n');");
    f.host.checks.final = { kind: 'node-data', scriptPath };
    const result = await runCollaboration({ plan: f.plan, host: f.host, worker: f.worker });
    assert.equal(result.status, 'completed'); assert.equal(result.checks[0].manifestHash, result.finalManifestHash);
    assert.match(result.checks[0].inputHash, /^[a-f0-9]{64}$/);
    assert.equal(result.checks[0].kind, 'node-data');
    assert.equal((await reopenRun({ stateRoot: f.host.stateRoot, runID: result.runID })).status, 'completed');
    assert.equal(await readFile(join(f.host.sourceDir, 'note.txt'), 'utf8'), 'draft\n');
  } finally { await f.cleanup(); }
});
