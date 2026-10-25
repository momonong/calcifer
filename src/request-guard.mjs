import { open, readFile, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { verifyResponse } from './selfhost-contract.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const POLICY = { requests: 40, reservedOutputTokens: 20480, perRequestOutput: 512, task: 6, canary: 2, windowMs: 1200000, concurrency: 1, deadlineMs: 30000 };
// One runner owns one append-only run ledger. An unresolved intent is UNKNOWN,
// including after process death. There is deliberately no clear/retry/reset API.
export class RequestGuard {
  constructor(path, runID, { now = Date.now } = {}) { this.path = path; this.runID = runID; this.now = now; this.busy = false; }
  async events() {
    try {
      const text = await readFile(this.path, 'utf8');
      if (!text.endsWith('\n')) throw new Error('LEDGER_INCOMPLETE_FAIL_CLOSED');
      const events = text.trim().split('\n').map(line => JSON.parse(line));
      if (events[0]?.type !== 'run' || events[0].runID !== this.runID || events[0].policyHash !== digest(POLICY)) throw new Error('LEDGER_IDENTITY_MISMATCH');
      return events;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async append(event, exclusive = false) {
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(this.path, exclusive ? 'wx' : 'a', 0o600);
    try { await file.writeFile(JSON.stringify(event) + '\n'); await file.sync(); } finally { await file.close(); }
  }
  async state() {
    const events = await this.events(), intents = events.filter(e => e.type === 'intent');
    const completed = new Set(events.filter(e => e.type === 'completed').map(e => e.id));
    return { events, intents, unknown: intents.filter(e => !completed.has(e.id)), requests: intents.length, reservedOutputTokens: intents.reduce((sum, e) => sum + e.maxTokens, 0) };
  }
  async dispatch({ framework, task, payload, deadlineMs = 30000, signal }, transport) {
    if (this.busy) throw new Error('CONCURRENCY_LIMIT');
    this.busy = true;
    let lock;
    try {
      let state = await this.state();
      if (state.unknown.length) throw new Error('UNKNOWN_RECONCILE_REQUIRED');
      await mkdir(dirname(this.path), { recursive: true });
      try { lock = await open(this.path + '.lock', 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('CONCURRENCY_LIMIT_OR_STALE_LOCK'); throw error; }
      // Re-read after exclusive acquisition, so separate instances/processes
      // cannot both admit against an earlier budget snapshot.
      state = await this.state();
      if (!state.events.length) {
        await this.append({ type: 'run', runID: this.runID, startedAt: this.now(), policyHash: digest(POLICY), policy: POLICY }, true);
        state = await this.state();
      }
      if (state.unknown.length) throw new Error('UNKNOWN_RECONCILE_REQUIRED');
      if (!['opencode','pi'].includes(framework) || !['T1','T2','T3','canary'].includes(task)) throw new Error('INVALID_BUDGET_SLOT');
      if (this.now() >= state.events[0].startedAt + POLICY.windowMs || this.now() < state.events[0].startedAt) throw new Error('DISPATCH_WINDOW_EXHAUSTED');
      if (!Number.isInteger(payload.max_tokens) || payload.max_tokens < 1 || payload.max_tokens > POLICY.perRequestOutput) throw new Error('OUTPUT_LIMIT');
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > POLICY.deadlineMs) throw new Error('DEADLINE_LIMIT');
      const subcount = state.intents.filter(e => e.framework === framework && e.task === task).length;
      if (state.requests >= POLICY.requests || state.reservedOutputTokens + payload.max_tokens > POLICY.reservedOutputTokens) throw new Error('RUN_BUDGET_EXHAUSTED');
      if (subcount >= (task === 'canary' ? POLICY.canary : POLICY.task)) throw new Error('SLOT_BUDGET_EXHAUSTED');
      if (signal?.aborted) throw new Error('ABORTED_BEFORE_DISPATCH');
      const id = randomUUID();
      await this.append({ type: 'intent', id, framework, task, at: this.now(), payloadHash: digest(payload), maxTokens: payload.max_tokens, deadlineMs });
      // No await or retry between durable intent and the one controlled transport.
      const controller = new AbortController();
      const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let timer, onAbort;
      const stopped = new Promise((_, reject) => {
        onAbort = () => reject(new Error(signal?.aborted ? 'CLIENT_ABORT_RESULT_UNKNOWN' : 'CLIENT_DEADLINE_RESULT_UNKNOWN'));
        boundedSignal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), deadlineMs + 1000);
      });
      try {
        if (boundedSignal.aborted) throw new Error('CLIENT_ABORT_RESULT_UNKNOWN');
        const response = await Promise.race([Promise.resolve().then(() => transport({ signal: boundedSignal })), stopped]);
        await this.append({ type: 'headers', id, at: this.now(), status: response.status,
          requestID: response.headers.get('x-request-id'), serviceVersion: response.headers.get('x-service-version') });
        const verified = await Promise.race([verifyResponse(response, { signal: boundedSignal, deadlineMs, tools: payload.tools?.map(t => t.function.name) ?? [] }), stopped]);
        await this.append({ type: 'completed', id, at: this.now(), terminal: verified.terminal,
          requestID: response.headers.get('x-request-id'), serviceVersion: response.headers.get('x-service-version') });
        return verified;
      } catch (error) {
        // Do not persist arbitrary provider errors (which may contain input/key).
        await this.append({ type: 'unknown', id, at: this.now(), remote: 'unknown', client: signal?.aborted ? 'stopped' : 'failed' });
        throw error;
      } finally { clearTimeout(timer); boundedSignal.removeEventListener('abort', onAbort); }
    } finally {
      if (lock) { await lock.close(); await unlink(this.path + '.lock'); }
      this.busy = false;
    }
  }
}
