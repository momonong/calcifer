// Pinned selfhost-models 45ebfd57 strict text/tools subset. No credentials,
// discovery, network transport, model selection, or live-mode entry point.
const fail = code => { throw new Error(code); };
const object = (value, code) => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code); };
const keys = (value, allowed, code) => { object(value, code); if (Object.keys(value).some(key => !allowed.includes(key))) fail(code); };
const string = (value, min, max, code) => { if (typeof value !== 'string' || value.length < min || value.length > max) fail(code); };
const number = (value, min, max, code, integer = false) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(code); };
const list = (value, min, max, code) => { if (!Array.isArray(value) || value.length < min || value.length > max) fail(code); };
const fnName = value => { if (typeof value !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(value)) fail('INVALID_FUNCTION_NAME'); };

export function validateProfile(profile, snapshot) {
  if (!profile || !snapshot || profile.model !== snapshot.id) fail('EXACT_MODEL_REQUIRED');
  number(profile.context, 1, Number.MAX_SAFE_INTEGER, 'INVALID_CONTEXT', true);
  if (profile.context !== snapshot.max_model_len) fail('CONTEXT_MISMATCH');
  number(profile.maxTokens, 1, 512, 'OUTPUT_LIMIT', true);
  number(profile.temperature, 0, 2, 'INVALID_TEMPERATURE');
  number(profile.topP, Number.MIN_VALUE, 1, 'INVALID_TOP_P');
  // The deployment ceiling is an owner-supplied input, not a /v1/models field.
  number(profile.deploymentDeadlineMs, 1, 30000, 'DEPLOYMENT_DEADLINE_REQUIRED', true);
  number(profile.deadlineMs, 1, Math.min(30000, profile.deploymentDeadlineMs), 'DEADLINE_LIMIT', true);
  const c = snapshot.capabilities;
  if (!c || c.text !== true || c.stream !== true || c.tools !== true || c.cancellation !== 'drain_to_terminal') fail('CAPABILITY_REQUIRED');
  if (!['vllm', 'transformers'].includes(snapshot.backend)) fail('UNKNOWN_BACKEND');
  if (!Array.isArray(c.unsupported_parameters)) fail('CAPABILITY_SNAPSHOT_INCOMPLETE');
}

export function adaptRequest({ framework, payload: input, profile, snapshot }) {
  if (!['opencode', 'pi'].includes(framework)) fail('UNKNOWN_FRAMEWORK');
  validateProfile(profile, snapshot);
  const payload = structuredClone(input), transforms = [];
  object(payload, 'INVALID_PAYLOAD');
  if ('max_completion_tokens' in payload) {
    if ('max_tokens' in payload) fail('CONFLICTING_TOKEN_LIMITS');
    payload.max_tokens = payload.max_completion_tokens; delete payload.max_completion_tokens;
    transforms.push('max_completion_tokens_to_max_tokens');
  }
  if ('store' in payload) {
    if (framework !== 'pi' || payload.store !== false) fail('UNSUPPORTED_STORE');
    delete payload.store; transforms.push('remove_pi_store_false');
  }
  if ('calcifer_fixture' in payload) {
    if (framework !== 'pi' || payload.calcifer_fixture !== 'v1') fail('UNKNOWN_FIXTURE_MARKER');
    delete payload.calcifer_fixture; transforms.push('remove_pi_fixture_v1');
  }
  keys(payload, ['model','messages','stream','max_tokens','temperature','top_p','seed','stop','presence_penalty','frequency_penalty','stream_options','tools','tool_choice','chat_template_kwargs'], 'UNKNOWN_PROVIDER_FIELD');
  if (payload.model !== profile.model) fail('EXACT_MODEL_REQUIRED');
  if (payload.stream !== true) fail('STREAM_REQUIRED');
  number(payload.max_tokens, 1, profile.maxTokens, 'OUTPUT_LIMIT', true);
  for (const [key, fixed] of [['temperature', profile.temperature], ['top_p', profile.topP]]) {
    if (key in payload && payload[key] !== fixed) fail('PROFILE_PARAMETER_CONFLICT');
    payload[key] = fixed;
  }
  if ('seed' in payload) number(payload.seed, 0, 2 ** 32 - 1, 'INVALID_SEED', true);
  for (const key of ['presence_penalty','frequency_penalty']) if (key in payload) number(payload[key], -2, 2, 'INVALID_PENALTY');
  if ('stop' in payload && payload.stop !== null) {
    const stop = typeof payload.stop === 'string' ? [payload.stop] : payload.stop;
    list(stop, 1, 4, 'INVALID_STOP'); for (const value of stop) string(value, 1, 200, 'INVALID_STOP');
  }
  if (payload.stream_options != null) { keys(payload.stream_options, ['include_usage'], 'UNKNOWN_STREAM_OPTION'); if (typeof payload.stream_options.include_usage !== 'boolean') fail('INVALID_USAGE_OPTION'); }
  if (payload.chat_template_kwargs != null) {
    keys(payload.chat_template_kwargs, ['enable_thinking'], 'UNKNOWN_TEMPLATE_OPTION');
    if (typeof payload.chat_template_kwargs.enable_thinking !== 'boolean' || (payload.chat_template_kwargs.enable_thinking && !snapshot.capabilities.thinking)) fail('UNSUPPORTED_THINKING');
  }
  if (payload.tools != null) {
    list(payload.tools, 1, 8, 'INVALID_TOOLS');
    for (const tool of payload.tools) {
      keys(tool, ['type','function'], 'UNKNOWN_TOOL_FIELD'); if (tool.type !== 'function') fail('INVALID_TOOL_TYPE');
      object(tool.function, 'INVALID_FUNCTION');
      if ('strict' in tool.function) {
        if (framework !== 'opencode' || tool.function.strict !== false) fail('UNSUPPORTED_STRICT');
        delete tool.function.strict; if (!transforms.includes('remove_opencode_strict_false')) transforms.push('remove_opencode_strict_false');
      }
      keys(tool.function, ['name','description','parameters'], 'UNKNOWN_FUNCTION_FIELD'); fnName(tool.function.name);
      if ('description' in tool.function) string(tool.function.description, 0, 4096, 'INVALID_DESCRIPTION');
      object(tool.function.parameters, 'INVALID_PARAMETERS'); // JSON Schema is intentionally an opaque dict in the service contract.
    }
  }
  if (payload.tool_choice != null && (!payload.tools || !['auto','none'].includes(payload.tool_choice))) fail('UNSUPPORTED_TOOL_CHOICE');
  list(payload.messages, 1, 64, 'INVALID_MESSAGES');
  const pending = new Set();
  for (const message of payload.messages) {
    keys(message, ['role','content','tool_calls','tool_call_id'], 'UNKNOWN_MESSAGE_FIELD');
    if (!['system','user','assistant','tool'].includes(message.role)) fail('INVALID_ROLE');
    if ((message.role === 'tool') !== (message.tool_call_id != null)) fail('INVALID_TOOL_RESULT');
    if (message.tool_call_id != null) {
      string(message.tool_call_id, 1, 200, 'INVALID_CALL_ID');
      if (!pending.delete(message.tool_call_id)) fail('ORPHAN_TOOL_RESULT');
    } else if (pending.size) fail('MISSING_TOOL_RESULTS');
    if (message.content == null) { if (message.role !== 'assistant' || !message.tool_calls?.length) fail('CONTENT_REQUIRED'); }
    else if (typeof message.content === 'string') string(message.content, 1, 32768, 'INVALID_CONTENT');
    else {
      if (message.role !== 'user') fail('CONTENT_PARTS_REQUIRE_USER');
      list(message.content, 1, 8, 'INVALID_CONTENT_PARTS');
      for (const part of message.content) { keys(part, ['type','text'], 'UNSUPPORTED_CONTENT_PART'); if (part.type !== 'text') fail('TEXT_ONLY_PROFILE'); string(part.text, 1, 32768, 'INVALID_TEXT_PART'); }
    }
    if (message.tool_calls != null) {
      if (message.role !== 'assistant') fail('CALLS_REQUIRE_ASSISTANT');
      list(message.tool_calls, 1, 8, 'INVALID_CALLS');
      for (const call of message.tool_calls) {
        keys(call, ['id','type','function'], 'UNKNOWN_CALL_FIELD'); string(call.id, 1, 200, 'INVALID_CALL_ID');
        if (call.type !== 'function' || pending.has(call.id)) fail('INVALID_OR_DUPLICATE_CALL');
        keys(call.function, ['name','arguments'], 'UNKNOWN_CALL_FUNCTION_FIELD'); fnName(call.function.name); string(call.function.arguments, 0, 32768, 'INVALID_ARGUMENTS'); pending.add(call.id);
      }
    }
  }
  if (pending.size) fail('MISSING_TOOL_RESULTS');
  for (const key of snapshot.capabilities.unsupported_parameters) if (key in payload) fail('BACKEND_UNSUPPORTED_PARAMETER');
  if (snapshot.backend === 'transformers' && (payload.tools || payload.messages.some(m => m.tool_calls || m.role === 'tool') || payload.stop || payload.presence_penalty || payload.frequency_penalty || payload.chat_template_kwargs?.enable_thinking || (payload.temperature === 0 && payload.top_p !== 1))) fail('BACKEND_UNSUPPORTED_FEATURE');
  return { payload, transforms };
}

// Buffer before exposing any bytes to the SDK. A valid function call followed by
// a missing DONE or an error must never trigger local tool execution.
export async function verifyResponse(response, { signal, deadlineMs = 30000, tools = [], maxBytes = 1024 * 1024 } = {}) {
  if (!response.ok) fail(`HTTP_${response.status}_RESULT_UNKNOWN`);
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) fail('SSE_REQUIRED');
  const reader = response.body.getReader(), chunks = []; let bytes = 0, firstByteMs = null;
  const started = performance.now(); let timer, abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => { void reader.cancel().catch(() => {}); reject(new Error('CLIENT_ABORT_RESULT_UNKNOWN')); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Error('STREAM_DEADLINE_RESULT_UNKNOWN')); }, deadlineMs + 1000);
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), interrupted]);
      if (item.done) break;
      if (firstByteMs === null) firstByteMs = performance.now() - started;
      bytes += item.value.byteLength; if (bytes > maxBytes) { await reader.cancel(); fail('SSE_BYTE_LIMIT'); }
      chunks.push(item.value);
    }
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  const data = Buffer.concat(chunks.map(value => Buffer.from(value)));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  let done = false, finish = null, usage = null; const calls = new Map();
  for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
    if (!block.trim() || block.startsWith(':')) continue;
    const lines = block.split('\n').filter(line => line.startsWith('data:'));
    if (!lines.length) fail('INVALID_SSE_FRAME');
    const value = lines.map(line => line.slice(5).trimStart()).join('\n');
    if (done) fail('DATA_AFTER_DONE');
    if (value === '[DONE]') { done = true; continue; }
    const frame = JSON.parse(value); if (frame.error) fail('SSE_ERROR_RESULT_UNKNOWN');
    if (frame.usage != null) {
      const u = frame.usage;
      for (const key of ['prompt_tokens','completion_tokens','total_tokens']) number(u[key], 0, Number.MAX_SAFE_INTEGER, 'INVALID_USAGE', true);
      if (u.total_tokens !== u.prompt_tokens + u.completion_tokens) fail('INVALID_USAGE_TOTAL');
      usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? null };
    }
    if (!Array.isArray(frame.choices) || frame.choices.length > 1) fail('INVALID_SSE_CHOICES');
    for (const choice of frame.choices) {
      if (choice.index !== 0) fail('INVALID_CHOICE_INDEX');
      if (choice.finish_reason != null) { if (finish || !['stop','length','tool_calls'].includes(choice.finish_reason)) fail('INVALID_FINISH'); finish = choice.finish_reason; }
      for (const call of choice.delta?.tool_calls ?? []) {
        if (!Number.isInteger(call.index) || call.index < 0 || call.index > 7) fail('INVALID_TOOL_INDEX');
        const current = calls.get(call.index) ?? { name: '', arguments: '', id: '' };
        if (call.id) current.id += call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        calls.set(call.index, current);
      }
    }
  }
  if (!done || !finish) fail('INCOMPLETE_SSE_RESULT_UNKNOWN');
  if (calls.size && finish !== 'tool_calls') fail('TOOL_FINISH_REQUIRED');
  for (const call of calls.values()) {
    if (!tools.includes(call.name) || !call.id) fail('UNDECLARED_TOOL_CALL');
    object(JSON.parse(call.arguments), 'INVALID_TOOL_ARGUMENTS');
  }
  const terminal = { remote: 'terminal_confirmed', streamDrained: true, done: true, finish, answer: finish === 'length' ? 'truncated' : 'complete', usage: usage ? { status: 'reported', ...usage } : { status: 'unknown' }, firstByteMs, bufferedCompleteMs: performance.now() - started, bufferedBytes: bytes };
  return { response: new Response(data, { status: response.status, headers: response.headers }), terminal };
}
