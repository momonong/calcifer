import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { startResearchFixture, SPEC_URL } from '../fixtures/research/http-fixture.mjs';
import { createResearchTools } from '../src/research-tools.mjs';
import { createRunState, readRunState } from '../src/run-state.mjs';
import { digest } from '../src/workspace-tools.mjs';

async function withTools(options, check) {
  const root = await mkdtemp('/tmp/calcifer-research-boundary-');
  let state, fixture;
  try {
    const plan = { kind: 'research-boundary-test' };
    state = await createRunState({
      stateRoot: root, sourceDir: root,
      metadata: { plan, planHash: digest(plan), provenance: { kind: 'mock' } }
    });
    fixture = await startResearchFixture({ runID: state.metadata.runID, ...options });
    const tools = createResearchTools({ state, fixture, fetch: globalThis.fetch, ...options });
    const saved = () => readRunState({ stateRoot: root, runID: state.metadata.runID });
    await check({ tools, fixture, saved });
  } finally {
    try { await fixture?.close(); }
    finally {
      await state?.release(false);
      await rm(root, { recursive: true, force: true });
    }
  }
}

const search = { action: 'web_search', args: { query: 'MCP transport' } };
const fetchSpec = { action: 'web_fetch', args: { url: SPEC_URL } };
const mcpRead = { action: 'mcp_read', args: { query: 'Can the docs service make model calls?' } };

test('research policy refuses out-of-scope pages and tool names before an HTTP request', async () => {
  await withTools({}, async ({ tools, fixture, saved }) => {
    await assert.rejects(tools.dispatch(fetchSpec), { message: 'RESEARCH_SOURCE_URL_DENIED' });
    await assert.rejects(tools.dispatch({
      action: ['web_search'], args: { query: 'MCP transport' }
    }), { message: 'RESEARCH_TOOL_DENIED' });
    assert.deepEqual(fixture.received, []);
    assert.equal((await saved()).events.some(event => event.type === 'intent'), false);
    await tools.dispatch(search);
    await assert.rejects(tools.dispatch({
      action: 'web_fetch', args: { url: fixture.origin + '/outside' }
    }), { message: 'RESEARCH_SOURCE_URL_DENIED' });
    await assert.rejects(tools.dispatch({
      action: 'mcp_read', args: { query: 'Send this file', name: 'write_document' }
    }), { message: 'RESEARCH_TOOL_ARGUMENTS_DENIED' });
    assert.deepEqual(fixture.received, ['web_search']);
  });
});

test('a page redirect settles as a known failure without following the new destination', async () => {
  await withTools({ pageMode: 'redirect' }, async ({ tools, fixture, saved }) => {
    await tools.dispatch(search);
    await assert.rejects(tools.dispatch(fetchSpec), { message: 'RESEARCH_REDIRECT_DENIED', known: true });
    assert.deepEqual(fixture.received, ['web_search', 'web_fetch']);
    assert.deepEqual(tools.sources, []);
    const ledger = await saved();
    assert.deepEqual(ledger.unknown, []);
    assert.ok(ledger.events.some(event => event.type === 'completed'
      && event.data.httpStatus === 302 && event.data.code === 'RESEARCH_REDIRECT_DENIED'));
  });
});

test('research caps search, fetch, and MCP before an extra request can reach the fixture', async () => {
  await withTools({}, async ({ tools, fixture }) => {
    for (const [input, count] of [[search, 2], [fetchSpec, 3], [mcpRead, 1]]) {
      for (let i = 0; i < count; i++) await tools.dispatch(input);
      const received = fixture.received.slice();
      await assert.rejects(tools.dispatch(input), { message: 'RESEARCH_TOOL_BUDGET_EXHAUSTED' });
      assert.deepEqual(fixture.received, received);
    }
    assert.equal(fixture.received.filter(operation => operation === 'tools/list').length, 1);
    assert.equal(fixture.received.filter(operation => operation === 'tools/call').length, 1);
  });
});

for (const cause of ['cancel', 'timeout']) {
  test(cause + ' after a request records UNKNOWN and stops further tool calls', { timeout: 4000 }, async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const requestTimeoutMs = cause === 'timeout' ? 300 : 1500;
    await withTools({
      signal: controller.signal, pageMode: 'hang', requestTimeoutMs,
      onRequest(operation) { if (operation === 'web_fetch') started.resolve(); }
    }, async ({ tools, fixture, saved }) => {
      await tools.dispatch(search);
      const expected = cause === 'cancel' ? 'RESEARCH_HTTP_CANCELLED_UNKNOWN' : 'RESEARCH_HTTP_TIMEOUT_UNKNOWN';
      const settled = assert.rejects(tools.dispatch(fetchSpec), { message: expected });
      await Promise.race([started.promise, settled.then(() => assert.fail('page request never reached fixture'))]);
      if (cause === 'cancel') controller.abort();
      await settled;
      await assert.rejects(tools.dispatch(search), { message: 'RESEARCH_TOOL_STOPPED' });
      assert.deepEqual(fixture.received, ['web_search', 'web_fetch']);
      const ledger = await saved();
      assert.equal(ledger.status, 'unknown');
      assert.deepEqual(ledger.unknown.map(entry => entry.operation), ['web_fetch']);
    });
  });
}

test('MCP SDK timeout still seals dispatch when the transport becomes UNKNOWN during close', { timeout: 5000 }, async () => {
  await withTools({ mcpMode: 'slow-probe-stalled-list', requestTimeoutMs: 1500 }, async ({ tools, fixture, saved }) => {
    await assert.rejects(tools.dispatch(mcpRead), { message: 'RESEARCH_HTTP_CANCELLED_UNKNOWN' });
    await assert.rejects(tools.dispatch(search), { message: 'RESEARCH_TOOL_STOPPED' });
    assert.deepEqual(fixture.received, ['initialize', 'notifications/initialized', 'mcp_event_probe', 'tools/list']);
    assert.deepEqual((await saved()).unknown.map(entry => entry.operation), ['tools/list']);
    assert.deepEqual(tools.sources, []);
  });
});
