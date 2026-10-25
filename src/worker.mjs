import { mkdir, mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { createTools, seed, snapshot, MockChat, scenarios, prompt, contextMarker } from './fixture.mjs';
import { adaptRequest } from './selfhost-contract.mjs';
import { RequestGuard } from './request-guard.mjs';

const framework = process.argv[2];
const selfhost = process.argv[3] === '--selfhost';
const guardDirectory = selfhost ? process.argv[4] : null;
const runID = selfhost ? process.argv[5] : null;
if (selfhost && (!guardDirectory || !runID)) throw new Error('OFFLINE_RUN_ID_AND_LEDGER_DIRECTORY_REQUIRED');
const selected = process.argv.slice(selfhost ? 6 : 3);
const profile = selfhost ? JSON.parse(await readFile(new URL('../fixtures/selfhost-profile.json', import.meta.url))) : null;
const offlineScenarios = selfhost ? JSON.parse(await readFile(new URL('../fixtures/selfhost-scenarios.json', import.meta.url))) : null;
const tasks = selfhost ? JSON.parse(await readFile(new URL('../fixtures/tasks.json', import.meta.url))) : null;
if (selfhost && profile.liveEnabled !== false) throw new Error('LIVE_MODE_UNAVAILABLE');
const modelID = selfhost ? profile.model : 'mock';
const boundaryCases = ['finish_no_done','tool_no_done','error_frame','cancel','budget_gate','unknown_gate','length'];
const root = await mkdtemp(join(tmpdir(), `calcifer-${framework}-`));
// Purpose-built framework paths; HOME and CODEX_HOME are never reassigned.
for (const key of Object.keys(process.env)) if (!['PATH', 'SystemRoot', 'WINDIR'].includes(key)) delete process.env[key];
for (const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','OPENCODE_TEST_HOME','PI_CODING_AGENT_DIR']) {
  process.env[key] = join(root, key.toLowerCase());
  await mkdir(process.env[key], { recursive: true });
}
process.env.TMPDIR = join(root, 'tmp');
await mkdir(process.env.TMPDIR, { recursive: true });
if (framework === 'opencode') {
  try { await access('/etc/opencode'); throw new Error('Unisolated /etc/opencode exists; refusing startup'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const externalNetworkAttempts = [];
const denySocket = (...args) => { externalNetworkAttempts.push({ transport: 'socket' }); throw new Error('MOCK_ONLY: network sockets disabled'); };
net.connect = denySocket; net.createConnection = denySocket; net.Socket.prototype.connect = denySocket; tls.connect = denySocket;
syncBuiltinESMExports();
globalThis.WebSocket = class { constructor() { externalNetworkAttempts.push({ transport: 'websocket' }); throw new Error('MOCK_ONLY: WebSocket disabled'); } };
if (globalThis.Bun) globalThis.Bun.connect = denySocket;
let active;
globalThis.fetch = (...args) => {
  if (!active) throw new Error('MOCK_ONLY: no active fixture');
  const current = active;
  const pending = mockFetch(current, args);
  current.pending.add(pending);
  pending.then(() => current.pending.delete(pending), () => current.pending.delete(pending));
  return pending;
};
async function mockFetch(current, args) {
  const url = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (url === 'https://calcifer.invalid/v1/chat/completions') current.evidence.providerDispatchAttempts++;
  if (current.evidence.unknown && !current.evidence.reconciled) {
    current.evidence.egressGateBlocks++;
    throw new Error('RECONCILE_REQUIRED: model egress blocked until receipt readback');
  }
  if (selfhost && url === 'https://calcifer.invalid/v1/chat/completions') {
    const request = args[0] instanceof Request ? args[0] : new Request(...args);
    const adapted = adaptRequest({ framework, payload: JSON.parse(await request.clone().text()), profile, snapshot: profile.syntheticSnapshot });
    current.evidence.adapters.push({ transforms: adapted.transforms, model: adapted.payload.model, maxTokens: adapted.payload.max_tokens, context: profile.context });
    try {
      const result = await current.guard.dispatch({ framework, task: ['T1','T2','T3'].includes(current.evidence.name) ? current.evidence.name : 'canary',
        payload: adapted.payload, deadlineMs: profile.deadlineMs, signal: request.signal }, ({ signal }) => current.mock.fetch(new Request(request, {
          signal, body: JSON.stringify(adapted.payload), headers: { ...Object.fromEntries(request.headers), 'x-request-timeout-ms': String(profile.deadlineMs) }
        })));
      current.evidence.terminals.push(result.terminal);
      return result.response;
    } catch (error) { current.evidence.guardFailures.push(error.message); throw error; }
  }
  return current.mock.fetch(...args);
}
const errorText = error => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const report = { framework, cases: {}, externalNetworkAttempts, isolation: { homeReassigned: false, purposeBuiltPaths: true,
  socketEgress: 'denied', websocket: 'denied', providerFetch: 'in-process exact URL allowlist', globalCredentials: 'not loaded',
  systemConfig: framework === 'opencode' ? '/etc/opencode absent' : 'explicit noContextFiles + empty agentDir' } };
let lib;
try {
  lib = await import(framework === 'pi' ? '@earendil-works/pi-coding-agent' : '@opencode/sdk');
  report.import = 'passed';
  for (const name of selected.length ? selected : Object.keys(selfhost ? offlineScenarios : scenarios)) {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await seed(directory);
    const evidence = { name, provenance: 'framework E2E', requests: [], streams: [], deniedFetch: [], toolAttempts: [], probes: [],
      events: [], hooks: {}, unknown: false, reconciled: false, egressGateBlocks: 0, providerDispatchAttempts: 0, started: Date.now(), before: await snapshot(directory),
      retry: { transport: 'no independent transport retry configured', provider: 0, harness: name === 'retry' ? 'one explicit retry' : 'disabled' },
      compaction: { enabled: false, summaryFidelity: 'pending' } };
    const tools = createTools(directory, evidence, { offlineSelfhost: selfhost });
    const ledgerPath = selfhost ? join(guardDirectory, boundaryCases.includes(name) ? `${framework}-${name}.jsonl` : 'shared-task-run.jsonl') : null;
    const guard = selfhost ? new RequestGuard(ledgerPath, boundaryCases.includes(name) ? `${runID}-${framework}-${name}` : runID) : null;
    if (selfhost) Object.assign(evidence, { adapters: [], terminals: [], guardFailures: [], ledgerPath, dataScope: 'full wire/events only synthetic fixtures; SDK session in isolated temporary directory; guard stores metadata only' });
    if (selfhost && ['budget_gate','unknown_gate'].includes(name)) {
      const payload = { model: modelID, messages: [{ role: 'user', content: 'synthetic budget prefill' }], stream: true, max_tokens: 512 };
      const terminal = () => new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      if (name === 'unknown_gate') {
        try { await guard.dispatch({ framework, task: 'canary', payload }, () => { throw new Error('synthetic lost model response'); }); } catch {}
      } else for (const f of ['opencode','pi']) for (const task of ['T1','T2','T3','canary']) for (let i = 0; i < (task === 'canary' ? 2 : 6); i++) await guard.dispatch({ framework: f, task, payload }, terminal);
    }
    active = { evidence, tools, guard, pending: new Set(), mock: new MockChat(name, evidence, selfhost ? { steps: offlineScenarios[name], model: modelID, maxRequests: 6 } : {}) };
    const timeout = setTimeout(() => { console.error('RUN_TIMEOUT', name); process.exit(124); }, 30000);
    try {
      if (framework === 'pi') await runPi(name, directory, evidence, tools);
      else await runOpenCode(name, directory, evidence, tools);
      evidence.status = 'observed';
    } catch (error) { evidence.status = 'failed'; evidence.failure = errorText(error); }
    finally {
      await Promise.allSettled([...active.pending]);
      clearTimeout(timeout);
      evidence.after = await snapshot(directory);
      evidence.sideEffectCount = evidence.after['effects.jsonl']?.content.trim().split('\n').length ?? 0;
      evidence.context = { systemChars: evidence.requests.map(request => request.body.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message.content)).join('').length),
        declaredTools: evidence.requests.map(request => request.body.tools?.map(tool => tool.function.name) ?? []),
        syntheticMarkerPresent: evidence.requests.every(request => JSON.stringify(request.body.messages).includes(contextMarker)) };
      evidence.hardGateHook = name === 'hook_throw' ? (evidence.requests.length === 0 ? 'blocked before fixture dispatch' : 'failed: throw swallowed, dispatch continued') : 'not exercised';
      evidence.automaticContinuationAfterLength = name === 'length' && evidence.requests.length > 1;
      evidence.changedFiles = Object.keys(evidence.after).filter(file => evidence.after[file].sha256 !== evidence.before[file]?.sha256);
      evidence.elapsedMs = Date.now() - evidence.started;
      delete evidence.started; delete evidence.onRequest;
      report.cases[name] = evidence;
      if (selfhost) evidence.guardState = await guard.state();
    }
  }
} catch (error) { report.import = 'failed'; report.failure = errorText(error); }
finally {
  console.log('CALCIFER_RESULT=' + JSON.stringify(report));
  await rm(root, { recursive: true, force: true });
  if (report.import !== 'passed' || Object.values(report.cases).some(run => run.status === 'failed')) process.exitCode = 1;
}

function hook(evidence, key) { evidence.hooks[key] = (evidence.hooks[key] ?? 0) + 1; }
function summarizePi(evidence, session) {
  evidence.messages = session.messages;
  const assistants = session.messages.filter(message => message.role === 'assistant');
  evidence.assistantText = assistants.flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join('');
  const last = assistants.at(-1);
  evidence.nativeFinish = last?.stopReason;
  evidence.nativeFinishes = assistants.map(message => message.rawStopReason ?? message.stopReason);
  evidence.nativeError = last?.errorMessage ?? (last?.stopReason === 'error' ? 'provider error' : null);
  evidence.toolNames = session.getActiveToolNames();
}
async function runPi(name, directory, evidence, tools) {
  const { createAgentSession, SettingsManager, ModelRuntime, SessionManager, DefaultResourceLoader } = lib;
  const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: name === 'retry', maxRetries: 1, baseDelayMs: 1,
    provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: 'off' });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(directory, 'models-cache'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('calcifer', { api: 'openai-completions', baseUrl: 'https://calcifer.invalid/v1', apiKey: 'offline-fixture',
    models: [{ id: modelID, name: modelID, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: selfhost ? profile.context : 32000, maxTokens: 512 }] });
  const model = modelRuntime.getModel('calcifer', modelID);
  const make = async sessionManager => {
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
      noExtensions: true, disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search', 'llama'], noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => `${contextMarker}\nSynthetic mock-only agent. Use the declared fixture tool.`,
      extensionFactories: [pi => {
        pi.on('before_provider_request', event => { hook(evidence, 'before_provider_request'); if (name === 'hook_throw') { evidence.hardGateHookThrew = true; throw new Error('EXPLICIT_GATE_DENY'); } return { ...event.payload, calcifer_fixture: 'v1' }; });
        pi.on('before_provider_headers', event => { hook(evidence, 'before_provider_headers'); event.headers['x-calcifer-context'] = 'v1'; });
        pi.on('context', () => { hook(evidence, 'context'); });
      }] });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, model,
      settingsManager, sessionManager, resourceLoader, tools: ['fixture_tool'],
      customTools: [{ name: 'fixture_tool', label: 'Fixture tool', description: 'Only synthetic workspace operations.', parameters: {
        ...toolSchemaForPi() }, execute: async (_id, input) => ({ content: [{ type: 'text', text: JSON.stringify(await tools.execute(input)) }], details: {} }) }] });
    session.subscribe(event => evidence.events.push({ type: event.type, ...(event.type === 'tool_execution_end' ? { isError: event.isError } : {}) }));
    return session;
  };
  let session = await make(SessionManager.create(directory, join(directory, 'sessions')));
  try {
    if (name === 'cancel') {
      let started;
      const requested = new Promise(resolve => { started = resolve; });
      evidence.onRequest = started;
      const running = session.prompt(prompt);
      await requested;
      evidence.cancellation = { userStoppedWaiting: true, remoteInference: 'unknown', toolStopped: 'not started' };
      await session.abort();
      await running;
      evidence.cancellation.streamDrain = evidence.streams.every(stream => stream.drained);
    } else await session.prompt(selfhost ? tasks.tasks[name]?.prompt ?? '只回覆合成接入測試結果。' : `${prompt}\nTask: ${name}`);
    summarizePi(evidence, session);
    if (selfhost && ['finish_no_done','tool_no_done','error_frame'].includes(name)) {
      active.guard = new RequestGuard(evidence.ledgerPath, `${runID}-${framework}-${name}`);
      await session.prompt('Changed payload after failed stream; this must remain blocked.');
      evidence.requestsAfterUnknownReopen = evidence.requests.length;
    }
    if (name === 'T3') {
      evidence.preReconcileReceipt = await tools.ledger.read();
      evidence.requestsBeforeReconcile = evidence.requests.length;
      const sessionFile = session.sessionFile;
      evidence.sessionFilePersisted = !!sessionFile;
      session.dispose();
      session = await make(SessionManager.open(sessionFile, join(directory, 'sessions'), directory));
      evidence.restartReadback = session.messages.some(message => message.role === 'toolResult');
      // Explicitly exercise the same lower transport gate after reconstructing the session.
      await session.prompt('Read-only status check while receipt is unknown.');
      evidence.requestsAfterBlockedRestart = evidence.requests.length;
      evidence.reconciledReceipt = await tools.ledger.reconcile('operation-fixed');
      evidence.reconciled = true;
      await session.prompt('Receipt operation-fixed committed with count 1. Continue without repeating the operation.');
      summarizePi(evidence, session);
    }
    evidence.settled = evidence.events.some(event => event.type === 'agent_settled');
  } finally { session.dispose(); }
}
function toolSchemaForPi() { return { type: 'object', properties: { action: { type: 'string', enum: selfhost ? ['read','edit','test','record','receipt'] : ['probe','edit','record'] }, path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' }, operationID: { type: 'string' } }, required: ['action'], additionalProperties: false }; }

async function runOpenCode(name, directory, evidence, tools) {
  const { OpenCode, SessionMessage } = lib;
  const config = { model: `calcifer/${modelID}`, compaction: { auto: false }, providers: { calcifer: { name: 'Calcifer mock', package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'https://calcifer.invalid/v1', apiKey: 'offline-fixture', transport: 'http', encoding: 'none' }, models: { [modelID]: { limit: { context: selfhost ? profile.context : 32000, output: 512 } } } } } };
  const make = () => OpenCode.create({ database: { path: join(directory, 'session.sqlite') }, models: { fetch: false, snapshot: false },
    config: { directory: process.env.XDG_CONFIG_HOME, project: false, claude: false, content: JSON.stringify(config) },
    fs: { filewatcher: false, fff: false }, events: { persist: true }, plugins: [{ id: 'calcifer-spike', setup: async ctx => {
      await ctx.session.hook('prompt', event => { hook(evidence, 'prompt'); event.prompt.text = `${contextMarker}\n${event.prompt.text}`; });
      await ctx.session.hook('context', event => { hook(evidence, 'context'); event.options.calcifer_fixture = 'v1'; });
      await ctx.session.hook('title', event => { event.result = 'Synthetic fixture'; });
      await ctx.session.hook('compaction', () => { throw new Error('COMPACTION_DISABLED_FOR_FIXED_SPIKE'); });
      await ctx.session.hook('model.request', event => { hook(evidence, 'model.request'); event.headers['x-calcifer-context'] = 'v1'; });
      await ctx.session.hook('http.request', event => {
        hook(evidence, 'http.request');
        if (name === 'hook_throw') { evidence.hardGateHookThrew = true; throw new Error('EXPLICIT_GATE_DENY'); }
        if (event.request.url !== 'https://calcifer.invalid/v1/chat/completions') throw new Error('MOCK_ONLY: unexpected provider URL');
        if (evidence.unknown && !evidence.reconciled) { evidence.egressGateBlocks++; throw new Error('RECONCILE_REQUIRED'); }
      });
      await ctx.session.hook('retry', event => {
        hook(evidence, 'retry'); event.decision = name === 'retry' && evidence.requests.length === 1 ? { retry: true, delay: 0 } : { retry: false };
      });
      await ctx.tool.hook('execute.before', event => {
        hook(evidence, 'execute.before');
        if (event.tool !== 'fixture_tool') throw new Error('DENIED_TOOL');
      });
      await ctx.tool.transform(editor => {
        for (const tool of editor.list()) editor.remove(tool.id);
        editor.add({ name: 'fixture_tool', input: toolSchemaForPi(), description: 'Only synthetic workspace operations.', options: { codemode: false },
          execute: async input => ({ content: JSON.stringify(await tools.execute(input)) }) });
      });
    }}] });
  let host = await make();
  let session = await host.sessions.create({ location: { directory }, model: { providerID: 'calcifer', id: modelID }, permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'fixture_tool', resource: '*', effect: 'allow' }] });
  const run = async text => {
    await host.sessions.prompt({ sessionID: session.id, id: SessionMessage.ID.create(), text });
    await host.sessions.wait({ sessionID: session.id });
  };
  const readback = async () => {
    session = await host.sessions.get({ sessionID: session.id });
    evidence.session = session;
    const exported = await host.sessions.export({ sessionID: session.id });
    evidence.messages = exported.messages;
    const log = await host.sessions.log({ sessionID: session.id, follow: false });
    evidence.events = [];
    for await (const event of log) evidence.events.push(event);
    const assistants = exported.messages.filter(message => message.type === 'assistant');
    evidence.assistantText = assistants.flatMap(message => (message.content ?? []).filter(part => part.type === 'text').map(part => part.text)).join('');
    const failed = evidence.events.filter(event => ['session.execution.failed','session.step.failed'].includes(event.type));
    evidence.nativeError = failed.length ? failed.map(event => event.data) : null;
    evidence.nativeFinishes = assistants.map(message => message.rawFinish ?? message.finish).filter(Boolean);
    evidence.nativeFinish = evidence.nativeFinishes.at(-1);
    evidence.nativeOutcome = session.outcome;
    evidence.toolNames = evidence.requests[0]?.body.tools?.map(tool => tool.function.name) ?? [];

  };
  try {
    if (name === 'cancel') {
      let requested;
      const started = new Promise(resolve => { requested = resolve; }); evidence.onRequest = requested;
      const running = run(prompt);
      await started;
      evidence.cancellation = { userStoppedWaiting: true, remoteInference: 'unknown', toolStopped: 'not started' };
      await host.sessions.interrupt({ sessionID: session.id, resume: false });
      await running;
      evidence.cancellation.streamDrain = evidence.streams.every(stream => stream.drained);
    } else await run(selfhost ? tasks.tasks[name]?.prompt ?? '只回覆合成接入測試結果。' : `${prompt}\nTask: ${name}`);
    await readback();
    if (selfhost && ['finish_no_done','tool_no_done','error_frame'].includes(name)) {
      active.guard = new RequestGuard(evidence.ledgerPath, `${runID}-${framework}-${name}`);
      await run('Changed payload after failed stream; this must remain blocked.');
      evidence.requestsAfterUnknownReopen = evidence.requests.length;
    }
    if (name === 'T3') {
      evidence.preReconcileReceipt = await tools.ledger.read();
      evidence.requestsBeforeReconcile = evidence.requests.length;
      await host.close();
      host = await make();
      await readback();
      evidence.restartReadback = JSON.stringify(evidence.messages).includes('UNKNOWN_RESULT');
      await run('Read-only status check while receipt is unknown.');
      evidence.requestsAfterBlockedRestart = evidence.requests.length;
      evidence.reconciledReceipt = await tools.ledger.reconcile('operation-fixed'); evidence.reconciled = true;
      await run('Receipt operation-fixed committed with count 1. Continue without repeating the operation.');
      await readback();
    }
    evidence.settled = typeof session.time?.idle === 'number';
  } finally { await host.close(); }
}
