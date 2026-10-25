import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// Synthetic, single-process fixture only. The durable unknown state is deliberate:
// a tool error after a write is not permission to execute the operation again.
export class ReceiptLedger {
  constructor(directory) { this.path = join(directory, 'receipt.json'); this.effects = join(directory, 'effects.jsonl'); this.intent = join(directory, 'intent.json'); }
  async read() {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async execute(operationID, { loseResult = false } = {}) {
    const previous = await this.read();
    if (previous) {
      if (previous.operationID !== operationID) throw new Error('OPERATION_CONFLICT');
      if (!previous.acknowledged) throw new Error('RECONCILE_REQUIRED');
      return { operationID, count: previous.count, status: 'committed' };
    }
    // Write intent before an append-only observable side effect. A lost receipt
    // remains unknown, rather than being treated as proof that nothing happened.
    try { await readFile(this.intent); throw new Error('RECONCILE_REQUIRED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(this.intent, JSON.stringify({ operationID }));
    await appendFile(this.effects, JSON.stringify({ operationID, effect: 'synthetic-append' }) + '\n');
    const count = (await readFile(this.effects, 'utf8')).trim().split('\n').length;
    await writeFile(this.path, JSON.stringify({ operationID, count, acknowledged: !loseResult }));
    if (loseResult) throw new Error('UNKNOWN_RESULT: side effect committed, acknowledgement lost');
    return { operationID, count: 1, status: 'committed' };
  }
  async reconcile(operationID) {
    const receipt = await this.read();
    if (!receipt || receipt.operationID !== operationID) throw new Error('RECEIPT_NOT_FOUND');
    await writeFile(this.path, JSON.stringify({ ...receipt, acknowledged: true }));
    return { operationID, count: receipt.count, status: 'committed' };
  }
}
