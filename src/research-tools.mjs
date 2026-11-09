import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DomUtils, parseDocument } from 'htmlparser2';
import { digest, fail, hash } from './workspace-tools.mjs';

const protocolVersion = '2025-11-25';
const mcpSequence = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'];
const skippedTags = new Set(['script', 'style', 'nav', 'footer', 'noscript', 'template']);
const maxBodyBytes = 65536;
export const RESEARCH_LIMITS = Object.freeze({ web_search: 2, web_fetch: 3, mcp_read: 1, windowMs: 90000 });
export const RESEARCH_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['web_search', 'web_fetch', 'mcp_read'] },
    args: { type: 'object' }
  },
  required: ['action', 'args'], additionalProperties: false
};
export const RESEARCH_TOOL_DESCRIPTION = 'Read-only research. web_search takes {query}; web_fetch takes {url} from search; mcp_read takes {query}.';

function hasKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function cleanText(value, maxBytes, code) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maxBytes || /\x00/.test(value)) fail(code);
  return value.trim().replace(/\s+/g, ' ');
}

function parseJson(text, code) {
  try { return JSON.parse(text); } catch { fail(code); }
}

async function readBody(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        fail('RESEARCH_HTTP_BODY_LIMIT');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function hasMediaType(response, type) {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() === type;
}

function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('RESEARCH_INVALID_UTF8'); }
}

function htmlSource(html) {
  const dom = parseDocument(html);
  const title = DomUtils.findOne(node => node.name === 'title', dom.children);
  const main = DomUtils.findOne(node => node.name === 'main' || node.name === 'article', dom.children);
  if (!title || !main) fail('RESEARCH_ARTICLE_MISSING');
  for (const node of DomUtils.findAll(tag => skippedTags.has(tag.name), main.children)) DomUtils.removeElement(node);
  return {
    title: cleanText(DomUtils.textContent(title), 240, 'RESEARCH_BAD_SOURCE_TITLE'),
    text: cleanText(main.children.map(node => DomUtils.getText(node)).join(' '), 8000, 'RESEARCH_SOURCE_TEXT_LIMIT')
  };
}

// The only accepted destinations are exact routes of this run's local fixture.
export function createResearchTools({ state, fixture, fetch, signal, admitted = () => true, requestTimeoutMs = 10000 }) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(fixture.origin)) fail('RESEARCH_FIXTURE_ORIGIN_REQUIRED');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10000) fail('RESEARCH_BAD_TIMEOUT');
  const origin = new URL(fixture.origin).origin;
  const pages = new Map(Object.entries(fixture.pages));
  for (const route of pages.values()) {
    if (!/^\/[a-zA-Z0-9_-]+$/.test(route) || route === '/mcp' || route === '/search') fail('RESEARCH_BAD_FIXTURE_ROUTE');
  }
  const discovered = new Set();
  const sources = [];
  const calls = { web_search: 0, web_fetch: 0, mcp_read: 0 };
  let busy = false;
  let stopped = false;

  function isStopped() { return stopped || signal?.aborted || !admitted(); }

  async function send(operation, url, { method = 'GET', body, headers = {}, transportSignal, allowStatus } = {}) {
    if (isStopped()) fail('RESEARCH_TOOL_STOPPED');
    const id = randomUUID();
    await state.append({
      type: 'intent', data: { id, kind: 'research-http', operation, method, targetHash: digest(String(url)),
        ...(body === undefined ? {} : { requestHash: hash(body) }) }
    });
    const complete = data => state.append({ type: 'completed', data: { id, ...data } });
    if (isStopped() || transportSignal?.aborted) {
      await complete({ result: 'not-dispatched' });
      fail('RESEARCH_TOOL_STOPPED');
    }
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const abort = AbortSignal.any([timeout, ...[signal, transportSignal].filter(Boolean)]);
    let response, bytes;
    try {
      response = await fetch(url, {
        method, body, headers: { ...headers, 'x-calcifer-research-run': state.metadata.runID },
        signal: abort, redirect: 'manual', credentials: 'omit'
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        fail('RESEARCH_REDIRECT_DENIED');
      }
      bytes = await readBody(response);
    } catch (error) {
      if (error.known) {
        await complete({ result: 'failed', code: error.message, httpStatus: response?.status });
        throw error;
      }
      if (timeout.aborted) throw new Error('RESEARCH_HTTP_TIMEOUT_UNKNOWN');
      if (abort.aborted) throw new Error('RESEARCH_HTTP_CANCELLED_UNKNOWN');
      throw new Error('RESEARCH_HTTP_OUTCOME_UNKNOWN');
    }
    const bodyHash = hash(bytes);
    await complete({ result: 'response', httpStatus: response.status, bodyHash });
    if (isStopped()) fail('RESEARCH_TOOL_STOPPED');
    if (!response.ok && response.status !== allowStatus) fail('RESEARCH_HTTP_FAILED');
    return { id, bodyHash, bytes, response };
  }

  function remember(kind, url, content, receipt) {
    const source = {
      id: 'S' + (sources.length + 1), kind, url, ...content,
      retrievedAt: new Date().toISOString(), receiptID: receipt.id, bodyHash: receipt.bodyHash
    };
    sources.push(source);
    return source;
  }

  async function webSearch(query) {
    const url = new URL('/search', origin);
    url.search = new URLSearchParams({ q: query, format: 'json' });
    const receipt = await send('web_search', url);
    if (!hasMediaType(receipt.response, 'application/json')) fail('RESEARCH_SEARCH_MEDIA_TYPE');
    const payload = parseJson(decode(receipt.bytes), 'RESEARCH_INVALID_SEARCH_JSON');
    if (!Array.isArray(payload?.results)) fail('RESEARCH_INVALID_SEARCH_RESULTS');
    const results = [];
    for (const entry of payload.results.slice(0, 10)) {
      if (!pages.has(entry?.url)) continue;
      const title = cleanText(entry.title, 240, 'RESEARCH_INVALID_SEARCH_RESULTS');
      const snippet = cleanText(entry.content, 600, 'RESEARCH_INVALID_SEARCH_RESULTS');
      results.push({ url: entry.url, title, snippet });
    }
    for (const result of results) discovered.add(result.url);
    return { results };
  }

  async function mcpRead(query) {
    const endpoint = origin + '/mcp';
    let wireIndex = 0;
    let eventProbed = false;
    let toolReceipt, transportError;
    let pending = Promise.resolve();
    let accepting = true;

    async function mcpFetch(input, init) {
      const request = new Request(input, init);
      if (request.url !== endpoint) fail('RESEARCH_MCP_REQUEST_DENIED');
      // The SDK probes a standalone event stream after initialization. This
      // stateless fixture answers once with 405 and never opens a stream.
      if (request.method === 'GET' && wireIndex >= 2 && !eventProbed) {
        eventProbed = true;
        const receipt = await send('mcp_event_probe', endpoint, {
          transportSignal: request.signal, allowStatus: 405,
          headers: { accept: 'text/event-stream', 'mcp-protocol-version': protocolVersion }
        });
        if (receipt.response.status !== 405) fail('RESEARCH_MCP_EVENT_STREAM_DENIED');
        return new Response(null, { status: 405 });
      }
      if (request.method !== 'POST') fail('RESEARCH_MCP_REQUEST_DENIED');
      const body = await request.text();
      if (Buffer.byteLength(body) > 8192) fail('RESEARCH_MCP_REQUEST_DENIED');
      const message = parseJson(body, 'RESEARCH_MCP_REQUEST_DENIED');
      if (wireIndex >= mcpSequence.length || message?.method !== mcpSequence[wireIndex]) fail('RESEARCH_MCP_REQUEST_DENIED');
      if (message.method === 'tools/call'
        && (message.params?.name !== fixture.mcpTool || !hasKeys(message.params.arguments, ['query'])
          || message.params.arguments.query !== query)) fail('RESEARCH_MCP_TOOL_DENIED');
      wireIndex += 1;
      const receipt = await send(message.method, endpoint, {
        method: 'POST', body, transportSignal: request.signal,
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(wireIndex > 1 ? { 'mcp-protocol-version': protocolVersion } : {})
        }
      });
      if (receipt.response.headers.has('mcp-session-id')) fail('RESEARCH_MCP_SESSION_UNEXPECTED');
      const contentType = receipt.response.headers.get('content-type');
      if (receipt.response.status !== 202 && !hasMediaType(receipt.response, 'application/json')) fail('RESEARCH_MCP_MEDIA_TYPE');
      if (message.method === 'tools/call') toolReceipt = receipt;
      return new Response(receipt.bytes.length ? receipt.bytes : null, {
        status: receipt.response.status, headers: contentType ? { 'content-type': contentType } : {}
      });
    }

    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { redirect: 'manual' },
      fetch(input, init) {
        const next = pending.then(() => {
          if (!accepting) fail('RESEARCH_MCP_CLOSED');
          if (transportError) throw transportError;
          return mcpFetch(input, init);
        });
        pending = next.catch(error => { transportError ??= error; });
        return next;
      }
    });
    const client = new Client({ name: 'calcifer-research', version: '1' }, { versionNegotiation: { mode: 'legacy' } });
    let result, protocolError;
    try {
      const options = { signal, timeout: requestTimeoutMs + 500 };
      await client.connect(transport, options);
      const catalog = await client.listTools(undefined, options);
      if (catalog.nextCursor || !catalog.tools.some(tool => tool.name === fixture.mcpTool)) fail('RESEARCH_MCP_TOOL_UNAVAILABLE');
      result = await client.callTool({ name: fixture.mcpTool, arguments: { query } }, options);
    } catch (error) {
      protocolError = error;
    } finally {
      accepting = false;
      try { await client.close(); }
      finally { await pending; }
    }
    // Closing the SDK can surface a transport error from an already-sent request.
    if (transportError) throw transportError;
    if (protocolError) {
      if (protocolError.known) throw protocolError;
      fail('RESEARCH_MCP_PROTOCOL_FAILED');
    }
    const source = result?.structuredContent;
    if (result?.isError || !toolReceipt || !hasKeys(source, ['title', 'url', 'text']) || source.url !== fixture.mcpSourceUrl) {
      fail('RESEARCH_MCP_INVALID_RESULT');
    }
    return remember('mcp_read', source.url, {
      title: cleanText(source.title, 240, 'RESEARCH_BAD_SOURCE_TITLE'),
      text: cleanText(source.text, 8000, 'RESEARCH_SOURCE_TEXT_LIMIT')
    }, toolReceipt);
  }

  return {
    calls, sources,
    async dispatch(input) {
      if (isStopped()) fail('RESEARCH_TOOL_STOPPED');
      if (busy) fail('RESEARCH_TOOL_BUSY');
      if (!hasKeys(input, ['action', 'args']) || typeof input.action !== 'string' || !Object.hasOwn(calls, input.action)) {
        fail('RESEARCH_TOOL_DENIED');
      }
      const { action, args } = input;
      const key = action === 'web_fetch' ? 'url' : 'query';
      if (!hasKeys(args, [key]) || typeof args[key] !== 'string') fail('RESEARCH_TOOL_ARGUMENTS_DENIED');
      const value = key === 'query' ? cleanText(args[key], 512, 'RESEARCH_TOOL_ARGUMENTS_DENIED') : args[key];
      if (action === 'web_fetch' && (!pages.has(value) || !discovered.has(value))) fail('RESEARCH_SOURCE_URL_DENIED');
      if (calls[action] >= RESEARCH_LIMITS[action]) fail('RESEARCH_TOOL_BUDGET_EXHAUSTED');
      calls[action] += 1;
      busy = true;
      try {
        if (action === 'web_search') return await webSearch(value);
        if (action === 'mcp_read') return await mcpRead(value);
        const receipt = await send('web_fetch', new URL(pages.get(value), origin));
        if (!hasMediaType(receipt.response, 'text/html')) fail('RESEARCH_PAGE_MEDIA_TYPE');
        return remember('web_fetch', value, htmlSource(decode(receipt.bytes)), receipt);
      } catch (error) {
        if (!error.known) stopped = true;
        throw error;
      } finally {
        busy = false;
      }
    }
  };
}
