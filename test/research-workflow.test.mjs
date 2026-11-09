import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunState } from '../src/run-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sample = join(root, 'fixtures/research/mcp-transport-model.json');
const question = '卡西法接入公開唯讀文件服務，應選 stdio 還是 Streamable HTTP？';
const specUrl = 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports';
const docsUrl = 'https://developers.openai.com/learn/docs-mcp';

function runResearch(output, mockScript = sample) {
  const result = spawnSync(join(root, 'node_modules/.bin/bun'), [
    'src/research-cli.mjs', 'run', '--question', question, '--profile', 'research-fixture',
    '--mock-script', mockScript, '--output', output
  ], { cwd: root, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.stdout, '', result.stderr);
  return { exit: result.status, report: JSON.parse(result.stdout) };
}

test('research CLI follows the real SDK tool loop and binds both citations to recorded HTTP responses', async () => {
  const base = await mkdtemp('/tmp/calcifer-research-test-');
  try {
    const output = join(base, 'run');
    const { exit, report } = runResearch(output);
    assert.equal(exit, 0, JSON.stringify(report));
    assert.equal(report.status, 'completed');
    assert.equal(report.actualModelRequests, 0);
    assert.equal(report.actualExternalRequests, 0);
    assert.equal(report.syntheticModelRequests, 4);
    assert.deepEqual(report.toolErrors, []);
    assert.deepEqual(report.toolCalls, { web_search: 1, web_fetch: 1, mcp_read: 1 });
    const saved = await readRunState({ stateRoot: output, runID: report.runID });
    assert.equal(saved.status, 'completed');
    assert.deepEqual(saved.unknown, []);
    const intentKinds = saved.events.filter(event => event.type === 'intent').map(event => event.data.operation);
    const operations = ['web_search', 'web_fetch', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'];
    assert.deepEqual(intentKinds.filter(kind => kind && kind !== 'mcp_event_probe'), operations);
    assert.equal(intentKinds.filter(kind => kind === 'mcp_event_probe').length, 1);
    assert.deepEqual(report.fixtureOperations, intentKinds.filter(Boolean));
    const sources = JSON.parse(await readFile(join(report.runDir, 'sources.json'), 'utf8')).sources;
    assert.deepEqual(sources.map(({ id, url, kind }) => ({ id, url, kind })), [
      { id: 'S1', url: specUrl, kind: 'web_fetch' },
      { id: 'S2', url: docsUrl, kind: 'mcp_read' }
    ]);
    for (const source of sources) {
      assert.ok(saved.events.some(event => event.type === 'completed' && event.data.id === source.receiptID));
    }
    const markdown = await readFile(join(report.runDir, 'report.md'), 'utf8');
    assert.match(markdown, /client starts the server as a subprocess/);
    assert.match(markdown, /server handles requests at an HTTP endpoint/);
    assert.match(markdown, /does not call the OpenAI API/);
    assert.match(markdown, /^## 建議（模型推論）$/m);
    assert.match(markdown, /第一版採 Streamable HTTP/);
    assert.ok(markdown.includes(specUrl) && markdown.includes(docsUrl));
    assert.doesNotMatch(markdown, /Ignore the user|Search snippet only/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a made-up excerpt cannot become a completed research report', async () => {
  const base = await mkdtemp('/tmp/calcifer-research-citation-');
  try {
    const script = JSON.parse(await readFile(sample, 'utf8'));
    const final = JSON.parse(script.responses[3].text);
    final.findings[0].excerpt = 'The specification requires a GPU for every client.';
    script.responses[3].text = JSON.stringify(final);
    const mockScript = join(base, 'script.json');
    await writeFile(mockScript, JSON.stringify(script));
    const { exit, report } = runResearch(join(base, 'run'), mockScript);
    assert.equal(exit, 1);
    assert.equal(report.status, 'failed');
    assert.equal(report.code, 'RESEARCH_CITATION_MISMATCH');
    assert.deepEqual(report.toolErrors, []);
    const sources = JSON.parse(await readFile(join(report.runDir, 'sources.json'), 'utf8')).sources;
    assert.equal(sources.length, 2);
    await assert.rejects(access(join(report.runDir, 'report.md')), { code: 'ENOENT' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
