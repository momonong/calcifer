import { mkdir, open, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, fail, readText, secureRoot, writeDurable, syncDirectory } from './workspace-tools.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
async function localText(root, name, missing) {
  try { return (await readText(root, name, { anyExtension: true, limits: { maxFileBytes: 2097152 } })).content; }
  catch (error) { if (error.code === 'ENOENT') fail(missing); throw error; }
}
async function localJson(root, name, missing) {
  const text = await localText(root, name, missing);
  try { return JSON.parse(text); } catch { fail('STATE_JSON_INVALID'); }
}
export async function readRunState({ stateRoot, runID, expected = {} }) {
  if (!uuid(runID)) fail('INVALID_RUN_ID');
  await secureRoot(stateRoot);
  const runDir = join(stateRoot, 'runs', runID); await secureRoot(runDir);
  const metadata = await localJson(runDir, 'metadata.json', 'METADATA_MISSING');
  if (metadata.schemaVersion !== 1 || metadata.runID !== runID || !uuid(metadata.ledgerID)
    || metadata.stateRootHash !== digest(stateRoot) || metadata.planHash !== digest(metadata.plan)
    || metadata.provenance?.kind !== 'mock') fail('IDENTITY_MISMATCH');
  for (const [key, value] of Object.entries(expected)) {
    if (!['authorityHash', 'planHash', 'workspaceID', 'ledgerID'].includes(key) || metadata[key] !== value) fail('IDENTITY_MISMATCH');
  }
  const text = await localText(runDir, 'ledger.jsonl', 'LEDGER_MISSING');
  if (!text.endsWith('\n')) fail('LEDGER_INCOMPLETE');
  let events; try { events = text.trimEnd().split('\n').map(line => JSON.parse(line)); } catch { fail('LEDGER_INCOMPLETE'); }
  if (events.length > 1024 || events[0]?.type !== 'start' || events[0].data.metadataHash !== digest(metadata)) fail('LEDGER_IDENTITY_MISMATCH');
  let previousHash = null; const intents = new Map(), completed = new Set(); let outcome;
  for (let index = 0; index < events.length; index++) {
    const event = events[index], { hash: eventHash, ...body } = event;
    if (body.seq !== index || body.runID !== runID || body.ledgerID !== metadata.ledgerID || body.previousHash !== previousHash || digest(body) !== eventHash) fail('LEDGER_IDENTITY_MISMATCH');
    previousHash = eventHash;
    if (event.type === 'intent') {
      if (!uuid(event.data.id) || intents.has(event.data.id)) fail('LEDGER_INTENT_MISMATCH');
      intents.set(event.data.id, event.data);
    } else if (event.type === 'completed') {
      if (!intents.has(event.data.id) || completed.has(event.data.id)) fail('LEDGER_INTENT_MISMATCH');
      completed.add(event.data.id);
    } else if (event.type === 'outcome') {
      if (outcome || !['completed', 'failed', 'cancelled', 'unknown'].includes(event.data.status)) fail('LEDGER_OUTCOME_MISMATCH');
      outcome = event.data;
    } else if (event.type !== 'start' || index !== 0) fail('UNKNOWN_LEDGER_EVENT');
    if (outcome && outcome.status !== 'unknown' && index !== events.length - 1) fail('LEDGER_AFTER_TERMINAL');
  }
  const unknown = [...intents.values()].filter(intent => !completed.has(intent.id));
  if (unknown.length && outcome && outcome.status !== 'unknown') fail('LEDGER_UNSETTLED_TERMINAL');
  let report;
  if (outcome) {
    report = await localJson(runDir, 'report.json', 'REPORT_MISSING');
    if (digest(report) !== outcome.reportHash || report.status !== outcome.status || report.runID !== runID) fail('REPORT_IDENTITY_MISMATCH');
  }
  return { metadata, events, unknown, report, runDir, status: unknown.length ? 'unknown' : outcome?.status ?? 'incomplete' };
}
export async function createRunState({ stateRoot, sourceDir, metadata: details }) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 }); await secureRoot(stateRoot);
  for (const name of ['runs', 'workspaces']) { await mkdir(join(stateRoot, name), { recursive: true, mode: 0o700 }); await secureRoot(join(stateRoot, name)); }
  const workspaceID = digest(sourceDir), activePath = join(stateRoot, 'workspaces', `${workspaceID}.json`);
  const lockPath = join(stateRoot, 'workspaces', `${workspaceID}.lock`);
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('WORKSPACE_LOCKED_OR_STALE'); throw error; }
  let initialized = false;
  try {
    await lock.writeFile(JSON.stringify({ workspaceID })); await lock.sync(); await syncDirectory(join(stateRoot, 'workspaces'));
    let active;
    try { active = await localJson(join(stateRoot, 'workspaces'), `${workspaceID}.json`, 'ACTIVE_MISSING'); }
    catch (error) { if (error.message !== 'ACTIVE_MISSING') throw error; }
    if (active) {
      if (active.workspaceID !== workspaceID) fail('ACTIVE_IDENTITY_MISMATCH');
      const previous = await readRunState({ stateRoot, runID: active.runID });
      if (previous.metadata.workspaceID !== workspaceID || digest(previous.metadata) !== active.metadataHash) fail('ACTIVE_IDENTITY_MISMATCH');
      if (['unknown', 'incomplete'].includes(previous.status)) fail('WORKSPACE_UNKNOWN_RECONCILE_REQUIRED');
    }
    const runID = randomUUID(), ledgerID = randomUUID();
    const runDir = join(stateRoot, 'runs', runID); await mkdir(runDir, { mode: 0o700 });
    const metadata = { ...details, schemaVersion: 1, runID, ledgerID, workspaceID, stateRootHash: digest(stateRoot) };
    await writeDurable(join(runDir, 'metadata.json'), JSON.stringify(metadata), true);
    let sequence = 0, previousHash = null, pending = Promise.resolve();
    const append = event => {
      const operation = pending.then(async () => {
        if (sequence >= 1024) fail('LEDGER_EVENT_LIMIT');
        const body = { seq: sequence++, runID, ledgerID, previousHash, ...event }, record = { ...body, hash: digest(body) };
        const file = await open(join(runDir, 'ledger.jsonl'), constants.O_WRONLY | constants.O_APPEND | (body.seq === 0 ? constants.O_CREAT | constants.O_EXCL : 0) | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync(); } finally { await file.close(); }
        previousHash = record.hash;
      });
      pending = operation; return operation;
    };
    await append({ type: 'start', data: { metadataHash: digest(metadata) } });
    await writeDurable(activePath, JSON.stringify({ workspaceID, runID, metadataHash: digest(metadata) }));
    initialized = true;
    return { metadata, runDir, append,
      async finish(report) { await writeDurable(join(runDir, 'report.json'), JSON.stringify(report)); await append({ type: 'outcome', data: { status: report.status, reportHash: digest(report) } }); },
      async release(known) { await lock.close(); if (known) { await unlink(lockPath); await syncDirectory(join(stateRoot, 'workspaces')); } }
    };
  } catch (error) {
    await lock.close();
    if (!initialized) await unlink(lockPath);
    throw error;
  }
}
