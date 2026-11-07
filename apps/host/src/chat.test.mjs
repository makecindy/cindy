import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatHandler } from './chat.mjs';

function fakeSession(events, sendResult = { accepted: true }) {
  const listeners = new Set();
  return {
    id: 's1',
    onEvent(listener) {
      listeners.add(listener);
      for (const event of events) listener(event);
      return () => listeners.delete(listener);
    },
    async send() { return sendResult; },
  };
}

function harness(events, sendResult) {
  const writes = [];
  const session = fakeSession(events, sendResult);
  const handler = createChatHandler({
    maker: { getSession: () => session, createSession: async () => session },
    defaultWorkDir: '/tmp',
    defaultModel: 'm',
  });
  const response = {
    writableEnded: false,
    writeHead() {},
    write(chunk) { writes.push(chunk); },
    end(chunk) { if (chunk) writes.push(String(chunk)); this.writableEnded = true; },
  };
  return { handler, writes, response };
}

function request(body) {
  const chunks = [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return {
    on(event, cb) {
      if (event === 'data') for (const chunk of chunks) cb(chunk);
      if (event === 'end') cb();
      return this;
    },
  };
}

test('forwards agent events verbatim and closes on the terminal event', async () => {
  const { handler, writes, response } = harness([
    { type: 'text', data: { text: 'hi' } },
    { type: 'done', turnScope: 'foreground' },
  ]);
  await handler(request({ prompt: 'hello' }), response);
  const body = writes.join('');
  assert.match(body, /"type":"session"/);
  assert.match(body, /"type":"text"/);
  assert.match(body, /"type":"done"/);
  assert.match(body, /event: end/);
  assert.equal(response.writableEnded, true);
});

test('rejects unknown fields and empty prompts before touching the runtime', async () => {
  for (const body of [{ prompt: '' }, { prompt: 'x', extra: 1 }, 'not json', { nope: true }]) {
    const { handler, writes, response } = harness([]);
    await handler(request(body), response);
    assert.match(writes.join(''), /"error"/);
    assert.equal(response.writableEnded, true);
  }
});

// Same restart invariant as the queue: the direct streaming entry must pass
// native identity and stored permissions to Maker before sending (unit).
test('direct chat resumes the stored SDK conversation and execution settings', async () => {
  let options;
  const { response } = harness([]);
  const handler = createChatHandler({ defaultWorkDir: '/tmp',
    readSession: async () => ({ agentKind: 'claude-code', sdkSessionId: 'native-existing',
      model: 'stored', permissionMode: 'ask', effort: 'high', fastMode: false, planModeEnabled: true }),
    maker: { getSession: () => null, createSession: async opts => {
      options = opts; return fakeSession([{ type: 'done' }]);
    } },
  });
  await handler(request({ sessionId: 's1', prompt: 'continue' }), response);
  assert.equal(options.resumeSessionId, 'native-existing');
  assert.equal(options.permissionMode, 'ask');
  assert.equal(options.effort, 'high');
  assert.equal(options.fastMode, false);
  assert.equal(options.planMode, true);
});
