import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ReceiptLedger } from './receipts.mjs';

export const toolSchema = {
  type: 'object', properties: {
    action: { type: 'string', enum: ['probe', 'edit', 'record'] },
    path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, operationID: { type: 'string' }
  }, required: ['action'], additionalProperties: false
};
export const prompt = 'Fixed synthetic task. Use only fixture_tool as requested; no external data. Report actual tool results.';
export const contextMarker = '[calcifer synthetic context v1]';
export const scenarios = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url), 'utf8'));
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function seed(directory) {
  await writeFile(join(directory, 'note.txt'), 'hello\n');
  await writeFile(join(directory, 'range.mjs'), 'export function inRange(value, min, max) { return value > min && value < max; }\n');
  await writeFile(join(directory, 'sentinel.txt'), 'unchanged\n');
}
export async function snapshot(directory) {
  const files = {};
  for (const name of (await readdir(directory)).filter(name => ['note.txt', 'range.mjs', 'sentinel.txt', 'receipt.json', 'effects.jsonl', 'intent.json'].includes(name)).sort()) {
    const content = await readFile(join(directory, name), 'utf8');
    files[name] = { sha256: sha256(content), content };
  }
  return files;
}
export function createTools(directory, evidence, { offlineSelfhost = false } = {}) {
  const ledger = new ReceiptLedger(directory);
  const probe = async () => {
    const source = await readFile(join(directory, 'range.mjs'), 'utf8');
    const { inRange } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const checks = [[0,0,2,true],[2,0,2,true],[1,0,2,true],[-1,0,2,false],[3,0,2,false]];
    const failures = checks.filter(([value,min,max,want]) => inRange(value,min,max) !== want).map(([value]) => value);
    const result = { passed: failures.length === 0, failures, total: 5 };
    evidence.probes.push(result);
    return result;
  };
  return { ledger, probe, execute: async input => {
    evidence.toolAttempts.push(input);
    if (offlineSelfhost && Object.keys(input).some(key => !['action','path','before','after','operationID'].includes(key))) throw new Error('UNKNOWN_TOOL_ARGUMENT');
    if (offlineSelfhost && input.action === 'read') {
      if (!['note.txt','range.mjs','sentinel.txt'].includes(input.path)) throw new Error('DENIED_PATH');
      return { path: input.path, content: await readFile(join(directory, input.path), 'utf8') };
    }
    if (offlineSelfhost && input.action === 'test') return probe();
    if (offlineSelfhost && input.action === 'receipt') return { receipt: await ledger.read() };
    if (input.action === 'probe') return probe();
    if (input.action === 'edit') {
      if (!['note.txt','range.mjs'].includes(input.path)) throw new Error('DENIED_PATH');
      const path = join(directory, input.path);
      const before = await readFile(path, 'utf8');
      if (!input.before || before.split(input.before).length !== 2) throw new Error('EXPECTED_ONE_MATCH');
      await writeFile(path, before.replace(input.before, input.after));
      return { changed: input.path, ...(!offlineSelfhost && input.path === 'range.mjs' ? { regression: await probe() } : {}) };
    }
    if (input.action === 'record') {
      if (offlineSelfhost && input.operationID !== 'operation-fixed') throw new Error('DENIED_OPERATION');
      try { return await ledger.execute(input.operationID, { loseResult: !evidence.reconciled }); }
      catch (error) { if (error.message.startsWith('UNKNOWN_RESULT')) evidence.unknown = true; throw error; }
    }
    throw new Error('DENIED_ACTION');
  }};
}

export class MockChat {
  constructor(name, evidence, { steps = scenarios[name], model = 'mock', maxRequests = 3 } = {}) { this.name = name; this.evidence = evidence; this.index = 0; this.steps = steps; this.model = model; this.maxRequests = maxRequests; }
  async fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url !== 'https://calcifer.invalid/v1/chat/completions') {
      this.evidence.deniedFetch.push({ url: request.url });
      throw new Error(`MOCK_ONLY: denied URL ${request.url}`);
    }
    const body = JSON.parse(await request.text());
    this.evidence.requests.push({ index: this.index, url: request.url, method: request.method,
      headers: Object.fromEntries([...request.headers].filter(([key]) => key !== 'authorization')),
      body, bytes: Buffer.byteLength(JSON.stringify(body)), sha256: sha256(JSON.stringify(body)) });
    if (this.index >= this.maxRequests) throw new Error('MODEL_TURN_BUDGET_EXCEEDED');
    const step = this.steps[this.index++];
    if (!step) throw new Error(`FIXTURE_EXHAUSTED: ${this.name} request ${this.index}`);
    if (step.status) return Response.json({ error: { message: 'synthetic provider unavailable', type: 'server_error', code: 'fixture' } }, { status: step.status });
    const chunk = (delta, finish_reason = null) => ({ id: `chatcmpl-fixture-${this.index}`, object: 'chat.completion.chunk', created: 1,
      model: this.model, choices: [{ index: 0, delta, finish_reason }] });
    const frames = [chunk({ role: 'assistant', content: '' })];
    if (step.tool) {
      const args = step.truncateArguments ? JSON.stringify(step.args).slice(0, -13) : JSON.stringify(step.args);
      frames.push(chunk({ tool_calls: [{ index: 0, id: `call_${this.index}`, type: 'function', function: { name: step.tool, arguments: '' } }] }));
      for (let i = 0; i < args.length; i += 9) frames.push(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 9) } }] }));
    } else frames.push(chunk({ content: step.text }));
    if (!step.truncated && !step.hold) frames.push(chunk({}, step.finish ?? 'tool_calls'));
    if (step.usage) frames.push({ id: `chatcmpl-fixture-${this.index}`, object: 'chat.completion.chunk', created: 1, model: this.model, choices: [], usage: step.usage });
    if (step.errorFrame) frames.push({ error: { message: 'synthetic SSE failure', code: 'fixture' } });
    let data = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
    if (!step.truncated && !step.hold && !step.omitDone && !step.errorFrame) data += 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(data);
    const state = { drained: false, clientCancelled: false, abortObserved: false, bytesProduced: 0 };
    this.evidence.streams.push(state);
    let cursor = 0;
    let controllerRef;
    const abort = () => {
      state.abortObserved = true;
      try { controllerRef?.error(new DOMException('fixture aborted', 'AbortError')); } catch {}
    };
    const stream = new ReadableStream({
      start(controller) { controllerRef = controller; request.signal.addEventListener('abort', abort, { once: true }); },
      pull(controller) {
        if (cursor < bytes.length) {
          const end = Math.min(cursor + 37, bytes.length);
          controller.enqueue(bytes.slice(cursor, end)); state.bytesProduced += end - cursor; cursor = end;
          return;
        }
        if (step.hold) return new Promise(() => {});
        state.drained = true;
        request.signal.removeEventListener('abort', abort);
        controller.close();
      },
      cancel() { state.clientCancelled = true; request.signal.removeEventListener('abort', abort); }
    });
    this.evidence.onRequest?.();
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-calcifer-fixture': this.name } });
  }
}
