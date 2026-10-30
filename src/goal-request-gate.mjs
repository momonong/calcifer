import { randomUUID } from 'node:crypto';
import { readRunState } from './run-state.mjs';
import { adaptRequest, verifyResponse } from './selfhost-contract.mjs';
import { digest, hash, fail } from './workspace-tools.mjs';

export const MODEL_ID = 'calcifer-synthetic-v1';
export const MOCK_POLICY = Object.freeze({ kind: 'mock', requests: 25, planner: 1, worker: 6, perRequestOutput: 512,
  reservedOutputTokens: 12800, concurrency: 1, windowMs: 120000, deadlineMs: 10000, maxRequestBytes: 131072 });
export const MOCK_PROFILE = Object.freeze({ model: MODEL_ID, context: 32768, maxTokens: 512, temperature: 0, topP: 1, deadlineMs: 10000, deploymentDeadlineMs: 10000 });
const snapshot = { id: MODEL_ID, revision: 'synthetic-only', backend: 'vllm', max_model_len: 32768,
  capabilities: { text: true, stream: true, tools: true, thinking: false, cancellation: 'drain_to_terminal', unsupported_parameters: [] } };
export class GoalRequestGate {
  constructor({ state, transport, signal, now = Date.now, endpoint = 'https://calcifer.invalid/v1/chat/completions' }) {
    if (endpoint !== 'https://calcifer.invalid/v1/chat/completions' && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1\/chat\/completions$/.test(endpoint)) fail('MOCK_ENDPOINT_REQUIRED');
    this.endpoint = endpoint;
    if (typeof transport !== 'function' || digest(state.metadata.policy) !== digest(MOCK_POLICY)) fail('MOCK_POLICY_REQUIRED');
    this.hostState = state; this.transport = transport; this.signal = signal; this.now = now;
    this.phases = new Map(); this.wire = []; this.failures = []; this.attempted = 0; this.busy = false; this.unknown = false; this.pending = new Set();
  }
  registerPhase(identity) {
    if (!['planner', 'worker'].includes(identity.kind) || !['opencode', 'pi'].includes(identity.framework) || identity.model !== MODEL_ID
      || !/^[A-Za-z0-9._-]{1,128}$/.test(identity.taskId) || !/^[A-Za-z0-9._-]{1,128}$/.test(identity.profileId)) fail('INVALID_PHASE');
    const phase = { id: randomUUID(), identity: Object.freeze({ ...identity }), open: true, pending: new Set(), tools: new Set() };
    this.phases.set(phase.id, phase); return phase;
  }
  closePhase(id) { const phase = this.phases.get(id); if (phase) phase.open = false; }
  markUnknown(code) { this.unknown = true; this.unknownCode = code; for (const phase of this.phases.values()) phase.open = false; }
  async state() {
    const saved = await readRunState({ stateRoot: this.hostState.metadata.stateRoot, runID: this.hostState.metadata.runID });
    const intents = saved.events.filter(event => event.type === 'intent' && event.data.kind === 'model').map(event => event.data);
    return { requests: intents.length, intents, unknown: saved.unknown.filter(item => item.kind === 'model'),
      reservedOutputTokens: intents.reduce((sum, item) => sum + item.maxTokens, 0), attempted: this.attempted };
  }
  fetch(request) {
    const promise = this.perform(request).catch(error => { this.failures.push({ url: request.url, phaseId: request.headers.get('x-calcifer-phase'), code: /^[A-Z_]+$/.test(error.message) ? error.message : 'REQUEST_FAILED', preDispatch: error.goalPreDispatch === true }); throw error; }); this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise)); return promise;
  }
  async perform(request) {
    this.attempted++;
    const phase = this.phases.get(request.headers.get('x-calcifer-phase'));
    if (this.unknown) fail('MODEL_OUTCOME_UNKNOWN');
    if (request.url !== this.endpoint || request.method !== 'POST') fail('MOCK_ENDPOINT_REQUIRED');
    if (!phase) fail('UNKNOWN_PHASE');
    if (!phase.open) fail('PHASE_CLOSED');
    if (this.busy) fail('MODEL_CONCURRENCY_LIMIT');
    this.busy = true; let intent;
    try {
      const source = await request.text(); if (Buffer.byteLength(source) > MOCK_POLICY.maxRequestBytes) fail('MODEL_REQUEST_BYTE_LIMIT');
      const original = JSON.parse(source);
      if (original.chat_template_kwargs?.enable_thinking !== false) fail('THINKING_POLICY_REQUIRED');
      const { payload, transforms } = adaptRequest({ framework: phase.identity.framework, payload: original, profile: MOCK_PROFILE, snapshot });
      const tools = payload.tools?.map(item => item.function.name) ?? [];
      if (phase.identity.kind === 'planner' ? tools.length : tools.length !== 1 || tools[0] !== 'calcifer_tool') fail('PHASE_TOOL_SCOPE');
      const saved = await this.state();
      if (this.unknown) fail('MODEL_OUTCOME_UNKNOWN');
      if (!phase.open) fail('PHASE_CLOSED');
      if (saved.unknown.length) { this.markUnknown('MODEL_OUTCOME_UNKNOWN'); fail('MODEL_OUTCOME_UNKNOWN'); }
      const started = this.hostState.metadata.startedAt;
      if (this.now() < started || this.now() >= started + MOCK_POLICY.windowMs) fail('GOAL_DISPATCH_WINDOW_EXHAUSTED');
      const count = saved.intents.filter(item => item.phase.kind === phase.identity.kind && item.phase.taskId === phase.identity.taskId).length;
      if (count >= MOCK_POLICY[phase.identity.kind]) fail('PHASE_BUDGET_EXHAUSTED');
      if (saved.requests >= MOCK_POLICY.requests || saved.reservedOutputTokens + payload.max_tokens > MOCK_POLICY.reservedOutputTokens) fail('GOAL_BUDGET_EXHAUSTED');
      if (this.signal?.aborted || request.signal.aborted) fail('MODEL_CANCELLED_BEFORE_DISPATCH');
      const id = randomUUID();
      await this.hostState.append({ type: 'intent', data: { id, kind: 'model', phaseId: phase.id, phase: phase.identity,
        maxTokens: payload.max_tokens, payloadHash: digest(payload), policyHash: digest(MOCK_POLICY) } }); intent = id;
      if (this.unknown || !phase.open || this.signal?.aborted || request.signal.aborted) throw new Error('MODEL_ADMISSION_STOPPED_RESULT_UNKNOWN');
      const wire = { id, phaseId: phase.id, phase: phase.identity, url: request.url, method: request.method,
        headers: Object.fromEntries([...request.headers].filter(([key]) => key !== 'authorization')), body: original,
        adapted: payload, transforms, bytes: Buffer.byteLength(source), contextBytes: Buffer.byteLength(JSON.stringify(original.messages)),
        systemBytes: Buffer.byteLength(JSON.stringify(original.messages.filter(message => message.role === 'system'))), toolBytes: Buffer.byteLength(JSON.stringify(original.tools ?? [])), sha256: hash(source) };
      this.wire.push(wire);
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, request.signal, ...(this.signal ? [this.signal] : [])]);
      let abort, timer;
      const stopped = new Promise((_, reject) => {
        abort = () => reject(new Error('MODEL_WAIT_STOPPED_RESULT_UNKNOWN'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => controller.abort(), MOCK_POLICY.deadlineMs);
      });
      try {
        const operation = (async () => {
          const response = await this.transport({ phase: phase.identity, phaseId: phase.id, payload, signal, index: count });
          return verifyResponse(response, { signal, deadlineMs: MOCK_POLICY.deadlineMs, tools });
        })();
        // A stopped wait never declares the underlying operation settled.
        phase.pending.add(operation); operation.then(() => phase.pending.delete(operation), () => phase.pending.delete(operation));
        const verified = await Promise.race([operation, stopped]);
        wire.terminal = verified.terminal;
        await this.hostState.append({ type: 'completed', data: { id, terminal: verified.terminal, responseHash: hash(await verified.response.clone().text()) } });
        return verified.response;
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    } catch (error) {
      if (intent) this.markUnknown('MODEL_OUTCOME_UNKNOWN');
      else if (error.known === true) error.goalPreDispatch = true;
      throw error;
    } finally { this.busy = false; }
  }
}
