import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReceiptLedger } from '../src/receipts.mjs';

test('an unknown operation result blocks a second side effect until receipt reconciliation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calcifer-receipt-test-'));
  try {
    const ledger = new ReceiptLedger(directory);
    await assert.rejects(ledger.execute('op-fixed', { loseResult: true }), /UNKNOWN_RESULT/);
    await assert.rejects(ledger.execute('op-fixed'), /RECONCILE_REQUIRED/);
    assert.equal(JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')).count, 1);
    assert.equal((await readFile(join(directory, 'effects.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.deepEqual(await ledger.reconcile('op-fixed'), { operationID: 'op-fixed', count: 1, status: 'committed' });
    assert.deepEqual(await ledger.execute('op-fixed'), { operationID: 'op-fixed', count: 1, status: 'committed' });
    assert.equal(JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8')).count, 1);
    assert.equal((await readFile(join(directory, 'effects.jsonl'), 'utf8')).trim().split('\n').length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a restart cannot silently replay an unacknowledged operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calcifer-restart-test-'));
  try {
    await assert.rejects(new ReceiptLedger(directory).execute('op-fixed', { loseResult: true }), /UNKNOWN_RESULT/);
    const restarted = new ReceiptLedger(directory);
    await assert.rejects(restarted.execute('op-fixed'), /RECONCILE_REQUIRED/);
    assert.equal((await restarted.reconcile('op-fixed')).count, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
