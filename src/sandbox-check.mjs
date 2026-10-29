import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename } from 'node:path';
import { secureFile, readText, snapshotContents, digest, fail } from './workspace-tools.mjs';

const DATA_PROTOCOL = Object.freeze({ kind: 'node-data', version: 1, inputSchemaVersion: 1, workerCodeExecution: false });
export const nodeDataCheckProtocol = () => ({ ...DATA_PROTOCOL });
export async function readNodeDataInput(inputPath, { expectedInputHash, expectedManifestHash } = {}) {
  const file = await readText(dirname(inputPath), basename(inputPath), { limits: { maxFileBytes: 1048576 } });
  if (expectedInputHash && file.hash !== expectedInputHash) fail('CHECK_INPUT_MISMATCH');
  let value;
  try {
    value = JSON.parse(file.content);
    if (!value || value.schemaVersion !== 1 || Object.keys(value).sort().join(',') !== 'files,manifest,schemaVersion'
      || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) fail('CHECK_INPUT_MISMATCH');
    const calculated = snapshotContents(value.files).manifest;
    if (!value.manifest || Object.keys(value.manifest).sort().join(',') !== 'files,hash'
      || value.manifest.hash !== calculated.hash || !Array.isArray(value.manifest.files)
      || value.manifest.files.length !== calculated.files.length
      || value.manifest.files.some((entry, index) => Object.keys(entry).sort().join(',') !== 'bytes,hash,path'
        || entry.path !== calculated.files[index].path || entry.hash !== calculated.files[index].hash || entry.bytes !== calculated.files[index].bytes)
      || expectedManifestHash && value.manifest.hash !== expectedManifestHash) fail('CHECK_INPUT_MISMATCH');
  } catch { fail('CHECK_INPUT_MISMATCH'); }
  return { snapshot: value, inputHash: file.hash, manifestHash: value.manifest.hash };
}

// Boundary derived from the separately verified synthetic Linux probe.
// Not a CPU/RAM/PID quota or seccomp guarantee. There is no host-exec fallback.
export async function runNodeDataCheck({ inputPath, scriptPath, expectedInputHash, expectedManifestHash, timeoutMs = 1000, maxOutputBytes = 8192, signal, hostNodeBinary, expectedProtocol }) {
  if (process.platform !== 'linux') fail('CHECK_ISOLATION_UNAVAILABLE');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 32768) fail('INVALID_CHECK_LIMITS');
  const nodeBinary = hostNodeBinary ?? (!process.versions.bun && process.release?.name === 'node' ? process.execPath : undefined);
  if (typeof nodeBinary !== 'string' || !nodeBinary.startsWith('/') || !nodeBinary.endsWith('/node')) fail('HOST_NODE_BINARY_REQUIRED');
  try {
    await secureFile(nodeBinary.slice(0, nodeBinary.lastIndexOf('/')), 'node');
    await access(nodeBinary, constants.X_OK);
  } catch { fail('CHECK_ISOLATION_UNAVAILABLE'); }
  const data = await readNodeDataInput(inputPath, { expectedInputHash, expectedManifestHash });
  const scriptRoot = scriptPath.slice(0, scriptPath.lastIndexOf('/'));
  await secureFile(scriptRoot, scriptPath.slice(scriptPath.lastIndexOf('/') + 1));
  try { for (const file of ['/usr/bin/unshare', '/usr/bin/bwrap', '/usr/bin/timeout']) await access(file, constants.X_OK); }
  catch { fail('CHECK_ISOLATION_UNAVAILABLE'); }
  const protocol = nodeDataCheckProtocol();
  if (expectedProtocol && digest(protocol) !== digest(expectedProtocol)) fail('CHECK_PROTOCOL_MISMATCH');
  const args = ['--signal=TERM', '--kill-after=0.2s', `${timeoutMs / 1000}s`, '/usr/bin/unshare',
    '--user', '--map-root-user', '--net', '--fork', '--kill-child=KILL', '/usr/bin/bwrap',
    '--unshare-user', '--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--cap-drop', 'ALL', '--disable-userns', '--assert-userns-disabled', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--dir', '/runtime', '--ro-bind', await realpath(nodeBinary), '/runtime/node',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/input', '--ro-bind', inputPath, '/input/snapshot.json',
    '--dir', '/check', '--ro-bind', scriptPath, '/check/check.mjs',
    '--chdir', '/input', '--remount-ro', '/', '--', '/runtime/node', '/check/check.mjs'];
  if (signal?.aborted) return { kind: 'node-data', status: 'failed', code: 'CHECK_CANCELLED', stdout: '', stderr: '' };
  const result = await new Promise(resolve => {
    const child = spawn('/usr/bin/timeout', args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), exceeded = false, spawnError;
    const capture = stream => bytes => {
      const current = stream === 'stdout' ? stdout : stderr;
      const remaining = maxOutputBytes - stdout.length - stderr.length;
      const next = Buffer.concat([current, bytes.subarray(0, Math.max(0, remaining))]);
      if (stream === 'stdout') stdout = next; else stderr = next;
      if (bytes.length > remaining && !exceeded) { exceeded = true; child.kill('SIGTERM'); }
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { spawnError = error.code; });
    child.once('close', (exitCode, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      const output = { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
      if (spawnError || /(?:unshare|bwrap):/.test(output.stderr) && exitCode !== 0) resolve({ status: 'failed', code: 'CHECK_ISOLATION_UNAVAILABLE', ...output });
      else if (exceeded) resolve({ status: 'failed', code: 'CHECK_OUTPUT_LIMIT', ...output });
      else if (signal?.aborted) resolve({ status: 'failed', code: 'CHECK_CANCELLED', ...output });
      else if (exitCode === 124 || exitCode === 137 || exitSignal) resolve({ status: 'failed', code: 'CHECK_TIMEOUT_OR_TERMINATED', ...output });
      else resolve({ status: exitCode === 0 ? 'passed' : 'failed', code: exitCode === 0 ? 'CHECK_PASSED' : 'CHECK_FAILED', exitCode, ...output });
    });
  });
  await readNodeDataInput(inputPath, { expectedInputHash: data.inputHash, expectedManifestHash: data.manifestHash });
  return { ...result, kind: 'node-data', inputHash: data.inputHash, manifestHash: data.manifestHash };
}
