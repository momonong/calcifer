import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
export const hash = text => createHash('sha256').update(text).digest('hex');
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'calcifer-m2-'));
  const sourceDir = join(root, 'source'); await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'note.txt'), 'draft\n');
  await writeFile(join(sourceDir, 'unrelated.txt'), 'preserve\n');
  const host = { sourceDir, stateRoot: join(root, 'state'), sourceFiles: ['note.txt'],
    readPaths: ['note.txt'], allowedPaths: ['note.txt'], allowedCheckIds: ['final'], finalCheckIds: ['final'],
    checks: { final: { kind: 'mock', definition: 'two accepted edits',
      evaluate: async ({ files }) => files['note.txt'] === 'draft\nfirst\nsecond\n' } },
    profiles: [{ id: 'mock-worker', framework: 'opencode', model: 'synthetic-worker',
      capabilities: ['edit', 'verify'], priority: 1, enabled: true, mode: 'mock' }],
    authorization: { allowedProfileIds: ['mock-worker'], mode: 'mock' }, workerTimeoutMs: 500 };
  const plan = { schemaVersion: 1, goal: 'Synthetic dependent edits', tasks: [
    { id: 'first', instruction: 'append first', dependsOn: [], requiredCapabilities: ['edit'], writePaths: ['note.txt'], checkIds: [] },
    { id: 'second', instruction: 'append second', dependsOn: ['first'], requiredCapabilities: ['edit'], writePaths: ['note.txt'], checkIds: [] }] };
  const worker = async ({ task, tools }) => {
    const file = await tools.dispatch({ action: 'read', args: { path: 'note.txt' } });
    await tools.dispatch({ action: 'edit', args: { path: 'note.txt', expectedHash: file.hash, content: file.content + task.id + '\n' } });
    return { status: 'completed' };
  };
  return { root, host, plan, worker, cleanup: () => rm(root, { recursive: true, force: true }) };
}
