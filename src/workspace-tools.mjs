import { open, lstat, realpath, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const digest = value => hash(JSON.stringify(value));
export const fail = code => { const error = new Error(code); error.known = true; throw error; };
export const DEFAULT_LIMITS = Object.freeze({ maxFiles: 16, maxFileBytes: 16384, maxTotalBytes: 131072, maxOutputBytes: 32768, maxToolCalls: 32 });
export function boundedLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_LIMITS');
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value < 1 || value > result[key]) fail('INVALID_LIMITS');
    result[key] = value;
  }
  return result;
}
export const relativePath = value => typeof value === 'string' && value === value.trim() && value.length > 0
  && !/[\\:\x00-\x1f\x7f*?\[\]]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
export function pathList(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length || Array.from(value).some(path => !relativePath(path))) fail('INVALID_PATH_LIST');
}
export async function secureRoot(root) {
  if (typeof root !== 'string' || resolve(root) !== root) fail('CANONICAL_DIRECTORY_REQUIRED');
  let cursor = '/';
  for (const part of root.split('/').filter(Boolean)) {
    cursor = join(cursor, part); const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail('SYMLINK_REJECTED');
    if (!info.isDirectory()) fail('DIRECTORY_REQUIRED');
  }
  if (await realpath(root) !== root) fail('CANONICAL_DIRECTORY_REQUIRED');
  return root;
}
export async function secureFile(root, path, writable = false) {
  if (!relativePath(path)) fail('INVALID_PATH');
  await secureRoot(root);
  let cursor = root; const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]); const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail('SYMLINK_REJECTED');
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) fail('REGULAR_FILE_REQUIRED');
    if (index === parts.length - 1 && writable && info.nlink !== 1) fail('WRITABLE_HARDLINK_REJECTED');
  }
  return cursor;
}
export async function readText(root, path, { writable = false, limits = DEFAULT_LIMITS, anyExtension = false } = {}) {
  const full = await secureFile(root, path, writable);
  if (!anyExtension && !['.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts'].includes(extname(path))) fail('UNSUPPORTED_FILE_TYPE');
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (writable && info.nlink !== 1)) fail('REGULAR_FILE_REQUIRED');
    if (info.size > limits.maxFileBytes) fail('FILE_SIZE_LIMIT');
    const bytes = await file.readFile(); if (bytes.length > limits.maxFileBytes) fail('FILE_SIZE_LIMIT');
    let content; try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('INVALID_UTF8'); }
    if (content.includes('\0')) fail('BINARY_FILE_REJECTED');
    return { content, hash: hash(bytes), bytes: bytes.length };
  } finally { await file.close(); }
}
export async function syncDirectory(path) { const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); } }
export async function writeDurable(path, content, exclusive = false) {
  await secureRoot(dirname(path));
  if (exclusive) {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  } else {
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_STATE_FILE'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(dirname(path), `.atomic-${randomUUID()}`);
    try {
      await writeDurable(temporary, content, true); await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  await syncDirectory(dirname(path));
}
export function snapshotContents(contents, limits = DEFAULT_LIMITS) {
  const paths = Object.keys(contents).sort(); pathList(paths);
  if (!paths.length || paths.length > limits.maxFiles) fail('FILE_COUNT_LIMIT');
  let total = 0;
  const files = paths.map(path => {
    const content = contents[path]; if (typeof content !== 'string') fail('INVALID_TEXT');
    const bytes = Buffer.byteLength(content); if (bytes > limits.maxFileBytes) fail('FILE_SIZE_LIMIT');
    total += bytes; return { path, hash: hash(content), bytes };
  });
  if (total > limits.maxTotalBytes) fail('TOTAL_SIZE_LIMIT');
  return { manifest: { files, hash: digest(files) }, contents: structuredClone(contents) };
}
export async function snapshotWorkspace(root, sourceFiles, { writablePaths = [], limits: input, complete = false } = {}) {
  const limits = boundedLimits(input); pathList(sourceFiles); pathList(writablePaths);
  if (sourceFiles.length > limits.maxFiles) fail('FILE_COUNT_LIMIT');
  if (complete) {
    const directories = new Set(sourceFiles.flatMap(path => { const parts = path.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')); }));
    const walk = async (prefix = '') => {
      await secureRoot(join(root, prefix));
      for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) fail('SYMLINK_REJECTED');
        if (entry.isDirectory() && directories.has(path)) await walk(path);
        else if (!entry.isFile() || !sourceFiles.includes(path)) fail('UNAUTHORIZED_WORKSPACE_ENTRY');
      }
    };
    await walk();
  }
  const contents = {};
  for (const path of [...sourceFiles].sort()) contents[path] = (await readText(root, path, { writable: writablePaths.includes(path), limits })).content;
  return snapshotContents(contents, limits);
}
export async function materializeSnapshot(root, snapshot) {
  await mkdir(root, { mode: 0o700 }); await secureRoot(root);
  for (const file of snapshot.manifest.files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true, mode: 0o700 });
    await writeDurable(join(root, file.path), snapshot.contents[file.path], true);
  }
  await syncDirectory(root);
}
export function diffSnapshots(before, after, writePaths) {
  if (before.manifest.files.length !== after.manifest.files.length) fail('UNAUTHORIZED_WORKSPACE_ENTRY');
  const artifacts = [];
  for (const file of before.manifest.files) {
    const current = after.manifest.files.find(value => value.path === file.path);
    if (!current) fail('UNAUTHORIZED_WORKSPACE_ENTRY');
    if (file.hash !== current.hash) {
      if (!writePaths.includes(file.path)) fail('UNAUTHORIZED_FILE_CHANGE');
      artifacts.push({ path: file.path, beforeHash: file.hash, afterHash: current.hash, content: after.contents[file.path] });
    }
  }
  return artifacts;
}
export function applyArtifacts(snapshot, artifacts, limits = DEFAULT_LIMITS) {
  const contents = { ...snapshot.contents };
  for (const artifact of artifacts) {
    if (!(artifact.path in contents) || hash(contents[artifact.path]) !== artifact.beforeHash || hash(artifact.content) !== artifact.afterHash) fail('ARTIFACT_CONFLICT');
    contents[artifact.path] = artifact.content;
  }
  return snapshotContents(contents, limits);
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_TOOL_ARGUMENTS');
}
export function createWorkspaceTools({ root, sourceFiles, readPaths, writePaths, checkIds, check, journal = async () => {}, limits: input }) {
  const limits = boundedLimits(input); let accepting = true, queue = Promise.resolve(), calls = 0, uncertain = false;
  const perform = async request => {
    if (uncertain) fail('TOOL_OUTCOME_UNKNOWN');
    exact(request, ['action', 'args']);
    const { action, args } = request;
    const schemas = { read: ['path'], search: ['query'], edit: ['path', 'expectedHash', 'content'], check: ['checkId'] };
    if (typeof action !== 'string' || !Object.hasOwn(schemas, action)) fail('UNKNOWN_TOOL_ACTION');
    exact(args, schemas[action]);
    if (++calls > limits.maxToolCalls) fail('TOOL_CALL_LIMIT');
    if (['read', 'edit'].includes(action) && (!relativePath(args.path) || !(action === 'read' ? readPaths : writePaths).includes(args.path))) fail('TOOL_PATH_NOT_ALLOWED');
    if (action === 'search' && (typeof args.query !== 'string' || !args.query.length || args.query.length > 256)) fail('INVALID_SEARCH_QUERY');
    if (action === 'edit' && (typeof args.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedHash) || typeof args.content !== 'string' || args.content.includes('\0') || Buffer.byteLength(args.content) > limits.maxFileBytes)) fail('INVALID_EDIT_ARGUMENTS');
    if (action === 'check' && (!checkIds.includes(args.checkId) || typeof check !== 'function')) fail('CHECK_NOT_ALLOWED');
    const id = randomUUID();
    try {
      await journal({ type: 'intent', data: { id, kind: `tool:${action}`, path: args.path, checkId: args.checkId } });
      let result;
      if (action === 'read') result = await readText(root, args.path, { limits });
      if (action === 'search') {
        const matches = []; let truncated = false;
        for (const path of [...readPaths].sort()) {
          const file = await readText(root, path, { limits });
          file.content.split('\n').forEach((line, index) => {
            if (line.includes(args.query)) {
              const hit = { path, line: index + 1, text: line.slice(0, 256) };
              if (Buffer.byteLength(JSON.stringify(matches)) + Buffer.byteLength(JSON.stringify(hit)) < limits.maxOutputBytes - 128) matches.push(hit);
              else truncated = true;
            }
          });
        }
        result = { matches, truncated };
      }
      if (action === 'edit') {
        const before = await readText(root, args.path, { writable: true, limits });
        if (before.hash !== args.expectedHash) fail('STALE_EXPECTED_HASH');
        await secureFile(root, args.path, true);
        await writeDurable(join(root, args.path), args.content);
        result = { path: args.path, beforeHash: before.hash, hash: hash(args.content) };
      }
      if (action === 'check') result = await check(args.checkId);
      if (Buffer.byteLength(JSON.stringify(result)) > limits.maxOutputBytes) fail('TOOL_OUTPUT_LIMIT');
      await journal({ type: 'completed', data: { id, resultHash: digest(result) } });
      return result;
    } catch (error) {
      if (error.known) {
        try { await journal({ type: 'completed', data: { id, failed: true, code: error.message } }); }
        catch (journalError) { uncertain = true; accepting = false; throw journalError; }
      } else { uncertain = true; accepting = false; }
      throw error;
    }
  };
  return {
    dispatch(request) {
      if (uncertain) return Promise.reject(Object.assign(new Error('TOOL_OUTCOME_UNKNOWN'), { known: true }));
      if (!accepting) return Promise.reject(Object.assign(new Error('TOOLS_CLOSED'), { known: true }));
      const operation = queue.then(() => perform(request)); queue = operation.catch(() => {}); return operation;
    },
    seal() { accepting = false; },
    async drain() { await queue; if (uncertain) fail('TOOL_OUTCOME_UNKNOWN'); }
  };
}
