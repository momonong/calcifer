import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, link, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, hash } from './helpers/collaboration.mjs';
import { snapshotWorkspace, createWorkspaceTools } from '../src/workspace-tools.mjs';

test('snapshot rejects symlink components, writable hardlinks, binary and size violations', async () => {
  const f = await fixture();
  try {
    await symlink(join(f.host.sourceDir, 'note.txt'), join(f.host.sourceDir, 'escape.txt'));
    await assert.rejects(snapshotWorkspace(f.host.sourceDir, ['escape.txt']), /SYMLINK/);
    await link(join(f.host.sourceDir, 'note.txt'), join(f.host.sourceDir, 'hard.txt'));
    await assert.rejects(snapshotWorkspace(f.host.sourceDir, ['hard.txt'], { writablePaths: ['hard.txt'] }), /HARDLINK/);
    await writeFile(join(f.host.sourceDir, 'binary.txt'), Buffer.from([0xff]));
    await assert.rejects(snapshotWorkspace(f.host.sourceDir, ['binary.txt']), /INVALID_UTF8/);
    await assert.rejects(snapshotWorkspace(f.host.sourceDir, ['note.txt'], { limits: { maxFileBytes: 2 } }), /FILE_SIZE_LIMIT/);
  } finally { await f.cleanup(); }
});

test('controlled dispatch rejects traversal, canary, unknown arguments, stale hashes and unregistered checks', async () => {
  const f = await fixture();
  try {
    const tools = createWorkspaceTools({ root: f.host.sourceDir, sourceFiles: ['note.txt'], readPaths: ['note.txt'],
      writePaths: ['note.txt'], checkIds: [], checks: {}, journal: async () => {} });
    for (const request of [
      { action: 'read', args: { path: '../canary.txt' } },
      { action: 'read', args: { path: 'unrelated.txt' } },
      { action: 'read', args: { path: 'note.txt', extra: true } },
      { action: 'edit', args: { path: 'note.txt', content: 'changed' } },
      { action: 'edit', args: { path: 'note.txt', expectedHash: hash('old'), content: 'changed' } },
      { action: 'check', args: { checkId: 'arbitrary' } },
      { action: 'shell', args: { command: 'arbitrary' } }
    ]) await assert.rejects(tools.dispatch(request));
    const file = await tools.dispatch({ action: 'read', args: { path: 'note.txt' } });
    assert.equal(file.content, 'draft\n');
    const found = await tools.dispatch({ action: 'search', args: { query: 'draft' } });
    assert.deepEqual(found.matches.map(hit => [hit.path, hit.line]), [['note.txt', 1]]);
    await tools.dispatch({ action: 'edit', args: { path: 'note.txt', expectedHash: file.hash, content: 'known\n' } });
    assert.equal((await tools.dispatch({ action: 'read', args: { path: 'note.txt' } })).content, 'known\n');
  } finally { await f.cleanup(); }
});

test('controlled tool rechecks every symlink component and does not expose host canary', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'canary.txt'), 'host-only');
    await symlink(f.root, join(f.host.sourceDir, 'alias'));
    const tools = createWorkspaceTools({ root: f.host.sourceDir, sourceFiles: ['alias/canary.txt'],
      readPaths: ['alias/canary.txt'], writePaths: [], checkIds: [], checks: {}, journal: async () => {} });
    await assert.rejects(tools.dispatch({ action: 'read', args: { path: 'alias/canary.txt' } }), /SYMLINK/);
  } finally { await f.cleanup(); }
});

test('UTF-8 BOM is preserved byte-for-byte in snapshot contents and hashes', async () => {
  const f = await fixture();
  try {
    const content = '\ufeffdraft\n'; await writeFile(join(f.host.sourceDir, 'note.txt'), content);
    const snapshot = await snapshotWorkspace(f.host.sourceDir, ['note.txt']);
    assert.equal(snapshot.contents['note.txt'], content);
    assert.equal(snapshot.manifest.files[0].hash, hash(content));
  } finally { await f.cleanup(); }
});

test('UNKNOWN seals new tool admission so lost check is not replayed and edits do not execute', async () => {
  const f = await fixture(); let checks = 0; const events = [];
  try {
    const tools = createWorkspaceTools({ root: f.host.sourceDir, sourceFiles: ['note.txt'], readPaths: ['note.txt'],
      writePaths: ['note.txt'], checkIds: ['final'], check: async () => { checks++; throw new Error('lost receipt'); },
      journal: async event => { events.push(event); } });
    await tools.dispatch({ action: 'check', args: { checkId: 'final' } }).catch(() => {});
    const retry = await tools.dispatch({ action: 'check', args: { checkId: 'final' } }).catch(error => error);
    const edit = await tools.dispatch({ action: 'edit', args: { path: 'note.txt', expectedHash: hash('draft\n'), content: 'after unknown' } }).catch(error => error);
    assert.equal(checks, 1); assert.match(retry.message, /TOOL_OUTCOME_UNKNOWN/); assert.match(edit.message, /TOOL_OUTCOME_UNKNOWN/);
    assert.equal(await readFile(join(f.host.sourceDir, 'note.txt'), 'utf8'), 'draft\n');
    assert.equal(events.filter(event => event.type === 'intent').length, 1);
    await assert.rejects(tools.drain(), /TOOL_OUTCOME_UNKNOWN/);
  } finally { await f.cleanup(); }
});

test('UNKNOWN refuses queued operations that had not begun while normal seal still permits settlement', async () => {
  const f = await fixture(); let checks = 0;
  try {
    const tools = createWorkspaceTools({ root: f.host.sourceDir, sourceFiles: ['note.txt'], readPaths: ['note.txt'],
      writePaths: ['note.txt'], checkIds: ['final'], check: async () => { checks++; throw new Error('lost receipt'); } });
    const results = await Promise.allSettled([
      tools.dispatch({ action: 'check', args: { checkId: 'final' } }),
      tools.dispatch({ action: 'check', args: { checkId: 'final' } }),
      tools.dispatch({ action: 'edit', args: { path: 'note.txt', expectedHash: hash('draft\n'), content: 'queued after unknown' } })
    ]);
    assert.equal(checks, 1); assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected', 'rejected']);
    assert.match(results[1].reason.message, /TOOL_OUTCOME_UNKNOWN/); assert.match(results[2].reason.message, /TOOL_OUTCOME_UNKNOWN/);
    assert.equal(await readFile(join(f.host.sourceDir, 'note.txt'), 'utf8'), 'draft\n');
  } finally { await f.cleanup(); }
});
