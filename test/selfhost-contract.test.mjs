import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = JSON.parse(await readFile(new URL('../evidence/latest.json', import.meta.url)));
const legacy = JSON.parse(await readFile(new URL('../' + index.path, import.meta.url)));
// Before the boundary exists, inspect the real SDK payload unchanged. This makes
// the initial RED about the incompatible wire shape, rather than a missing import.
const adapter = await import('../src/selfhost-contract.mjs');
const profile = { model: 'mock', context: 8192, maxTokens: 512, temperature: 0, topP: 1, deadlineMs: 30000, deploymentDeadlineMs: 30000 };
const capabilities = { id: 'mock', backend: 'vllm', max_model_len: 8192, capabilities: { text: true, stream: true, tools: true, thinking: false, cancellation: 'drain_to_terminal', unsupported_parameters: [] } };
for (const framework of ['opencode', 'pi']) {
  test(`${framework}: actual SDK payload becomes the selfhost strict subset`, () => {
    const raw = legacy.frameworks[framework].cases.T1.requests[0].body;
    const { payload } = adapter.adaptRequest({ framework, payload: raw, profile, snapshot: capabilities });
    assert.equal(payload.max_tokens, 512);
    assert.equal('max_completion_tokens' in payload, false);
    assert.equal('strict' in payload.tools[0].function, false);
    assert.equal('store' in payload, false);
    assert.equal('calcifer_fixture' in payload, false);
  });
}

const actual = framework => structuredClone(legacy.frameworks[framework].cases.T1.requests[0].body);
const adapt = (payload, overrides = {}) => adapter.adaptRequest({ framework: 'opencode', payload, profile, snapshot: capabilities, ...overrides });
test('unknown provider, nested tools, conflicting limits and unsupported semantics fail closed', () => {
  const cases = [
    [p => { p.max_tokens = 512; }, /CONFLICTING_TOKEN/],
    [p => { p.parallel_tool_calls = false; }, /UNKNOWN_PROVIDER/],
    [p => { p.tools[0].extra = false; }, /UNKNOWN_TOOL/],
    [p => { p.tools[0].function.extra = false; }, /UNKNOWN_FUNCTION/],
    [p => { p.tools[0].function.strict = true; }, /UNSUPPORTED_STRICT/],
    [p => { p.messages[0].name = 'unsafe'; }, /UNKNOWN_MESSAGE/],
    [p => { p.stream_options.other = false; }, /UNKNOWN_STREAM/],
    [p => { p.model = 'different'; }, /EXACT_MODEL/],
    [p => { p.max_completion_tokens = 513; }, /OUTPUT_LIMIT/],
    [p => { p.tool_choice = 'required'; }, /UNSUPPORTED_TOOL_CHOICE/],
    [p => { p.temperature = 1; }, /PROFILE_PARAMETER_CONFLICT/],
    [p => { p.chat_template_kwargs = { enable_thinking: true }; }, /UNSUPPORTED_THINKING/]
  ];
  for (const [change, error] of cases) { const payload = actual('opencode'); change(payload); assert.throws(() => adapt(payload), error); }
  for (const change of [p => { p.store = true; }, p => { p.calcifer_fixture = 'arbitrary'; }]) {
    const payload = actual('pi'); change(payload);
    assert.throws(() => adapt(payload, { framework: 'pi' }), /UNSUPPORTED_STORE|UNKNOWN_FIXTURE/);
  }
  for (const snapshot of [{ ...capabilities, id: 'different' }, { ...capabilities, max_model_len: 32000 }, { ...capabilities, capabilities: { ...capabilities.capabilities, tools: false } }]) assert.throws(() => adapt(actual('opencode'), { snapshot }), /EXACT_MODEL|CONTEXT_MISMATCH|CAPABILITY_REQUIRED/);
  assert.throws(() => adapt(actual('opencode'), { profile: { ...profile, deploymentDeadlineMs: 10000 } }), /DEADLINE_LIMIT/);
  assert.throws(() => adapt(actual('opencode'), { snapshot: { ...capabilities, capabilities: { ...capabilities.capabilities, unsupported_parameters: ['temperature'] } } }), /BACKEND_UNSUPPORTED/);
});

test('tool history and message constraints match the pinned strict contract', () => {
  const base = actual('opencode');
  const call = { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } }] };
  const result = { role: 'tool', tool_call_id: 'call', content: 'ok' };
  for (const messages of [[{ role: 'user', content: '' }], [result], [call], [call, { role: 'user', content: 'interrupt' }, result], [{ ...call, tool_calls: [...call.tool_calls, ...call.tool_calls] }, result], [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }], [{ role: 'user', content: [{ type: 'text', text: 'x', other: 1 }] }]]) assert.throws(() => adapt({ ...base, messages }));
  assert.doesNotThrow(() => adapt({ ...base, messages: [...base.messages, call, result] }));
  const unknownCall = structuredClone(call); unknownCall.tool_calls[0].function.extra = 1;
  assert.throws(() => adapt({ ...base, messages: [...base.messages, unknownCall, result] }), /UNKNOWN_CALL_FUNCTION/);
});

const sse = (frames, done = true) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
const frame = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
test('SSE requires finish and DONE, rejects error frames, and preserves unknown versus nonzero usage', async () => {
  const good = await adapter.verifyResponse(sse([frame({ content: '中文火' }, 'stop')]));
  assert.deepEqual(good.terminal.usage, { status: 'unknown' });
  assert.match(await good.response.text(), /中文火/);
  await assert.rejects(adapter.verifyResponse(sse([frame({}, 'stop')], false)), /INCOMPLETE_SSE/);
  await assert.rejects(adapter.verifyResponse(sse([frame({}, 'stop'), { error: { code: 'synthetic' } }], false)), /SSE_ERROR/);
  const usage = await adapter.verifyResponse(sse([frame({}, 'length'), { choices: [], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } }]));
  assert.equal(usage.terminal.answer, 'truncated'); assert.equal(usage.terminal.remote, 'terminal_confirmed'); assert.equal(usage.terminal.usage.totalTokens, 22);
  await assert.rejects(adapter.verifyResponse(sse([frame({ tool_calls: [{ index: 0, id: 'call', function: { name: 'fixture_tool', arguments: '{' } }] }, 'tool_calls')]), { tools: ['fixture_tool'] }));
  await assert.rejects(adapter.verifyResponse(sse([frame({}, 'stop'), { choices: [], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 0 } }])), /INVALID_USAGE_TOTAL/);
});
