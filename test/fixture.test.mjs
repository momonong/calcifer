import test from 'node:test';
import assert from 'node:assert/strict';
import { MockChat } from '../src/fixture.mjs';

test('an exhausted response script fails instead of fabricating an agent success', async () => {
  const evidence = { requests: [], streams: [], deniedFetch: [] };
  const mock = new MockChat('text_stop', evidence);
  const request = () => new Request('https://calcifer.invalid/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'mock', messages: [], stream: true })
  });
  const first = await mock.fetch(request());
  await first.text();
  await assert.rejects(mock.fetch(request()), /FIXTURE_EXHAUSTED/);
});
