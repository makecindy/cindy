import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createChatHandler } from './chat.mjs';
import { createEventHub } from './events.mjs';

function harness(overrides = {}) {
  const writes = [];
  const enqueued = [];
  const created = [];
  const events = createEventHub();
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false, headersSent: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(chunk) { writes.push(String(chunk)); },
    end(chunk) { if (chunk) writes.push(String(chunk)); this.writableEnded = true; this.emit('close'); },
  });
  const handler = createChatHandler({ events,
    readSession: async () => ({ id: 's1', status: 'active', sdkSessionId: 'existing-native-id' }),
    createSession: async body => { created.push(body); },
    enqueue: async (id, input) => { enqueued.push({ id, ...input }); return { pendingQueue: [] }; },
    inputStatus: async () => 'running',
    ...overrides,
  });
  return { handler, writes, response, events, enqueued, created };
}
const request = body => Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);

// Unit transport contract: every streaming input enters the durable service;
// Maker restore, permissions and history are covered at that service's entry.
test('streams only its own queued turn and disconnect does not cancel execution', async () => {
  const h = harness();
  await h.handler(request({ sessionId: 's1', clientId: 'c1', prompt: 'hello' }), h.response);
  assert.deepEqual(h.enqueued, [{ id: 's1', clientId: 'c1', text: 'hello' }]);
  assert.equal(h.response.writableEnded, false);
  h.events.publish({ sessionId: 's1', inputClientId: 'prior', type: 'done' });
  assert.equal(h.response.writableEnded, false);
  h.events.publish({ sessionId: 's1', inputClientId: 'c1', type: 'text', data: { text: 'hi' } });
  h.events.publish({ sessionId: 's1', inputClientId: 'c1', type: 'done', turnScope: 'background' });
  assert.equal(h.response.writableEnded, false);
  h.events.publish({ sessionId: 's1', inputClientId: 'c1', type: 'done' });
  assert.match(h.writes.join(''), /"text":"hi"/);
  assert.match(h.writes.join(''), /event: end/);
  assert.equal(h.response.writableEnded, true);
  assert.equal(h.events.size(), 0);

  const disconnected = harness();
  await disconnected.handler(request({ sessionId: 's1', prompt: 'continue' }), disconnected.response);
  disconnected.response.destroyed = true;
  disconnected.response.emit('close');
  assert.equal(disconnected.enqueued.length, 1);
  assert.equal(disconnected.events.size(), 0);
});

test('a dispatch that fails after admission releases the stream and keeps the input queued', async () => {
  const h = harness();
  await h.handler(request({ sessionId: 's1', clientId: 'c1', prompt: 'hello' }), h.response);
  // Another input's recovery is not this input's outcome.
  h.events.publish({ sessionId: 's1', type: 'input_projection',
    projection: { recovery: { kind: 'queue-head', clientId: 'other' }, error: 'boom' } });
  assert.equal(h.response.writableEnded, false);
  h.events.publish({ sessionId: 's1', type: 'input_projection',
    projection: { recovery: { kind: 'queue-head', clientId: 'c1' }, error: 'could not start' } });
  assert.match(h.writes.join(''), /"type":"input_receipt"[^}]*"status":"interrupted"/);
  assert.equal(h.response.writableEnded, true);
  assert.equal(h.events.size(), 0);
});

// Native Codex can settle abort without publishing done. The queue's settled
// receipt must release only this input's stream, without inventing success.
// Unit transport regression for the isolated native stop timeout.
test('an interrupted input receipt releases its stream without a provider done', async () => {
  const h = harness();
  await h.handler(request({ sessionId: 's1', clientId: 'c1', prompt: 'hello' }), h.response);
  h.events.publish({ type: 'input_receipt', sessionId: 's1', inputClientId: 'other', clientId: 'other', status: 'interrupted' });
  assert.equal(h.response.writableEnded, false);
  h.events.publish({ type: 'input_receipt', sessionId: 's1', inputClientId: 'c1', clientId: 'c1', status: 'interrupted' });
  assert.equal(h.response.writableEnded, true);
  assert.match(h.writes.join(''), /"status":"interrupted"/);
  assert.doesNotMatch(h.writes.join(''), /"type":"done"/);
  assert.equal(h.events.size(), 0);
});

test('invalid input never creates a task or enters the queue', async () => {
  for (const body of [{ prompt: '' }, { prompt: 'x', extra: 1 }, 'not json', { nope: true },
    { prompt: 'x', sessionId: '../other' }, { prompt: 'x', sessionId: 'a\\b' },
    { prompt: 'x', workDir: './relative' }, { prompt: 'x', clientId: {} }]) {
    const h = harness();
    await h.handler(request(body), h.response);
    assert.equal(h.response.statusCode, 400);
    assert.equal(h.enqueued.length, 0);
    assert.equal(h.created.length, 0);
    assert.equal(h.events.size(), 0);
  }
});

test('new streaming tasks use ordinary creation and keep account data out of the working directory', async () => {
  const h = harness({ readSession: async () => null });
  await h.handler(request({ sessionId: 'new', prompt: 'hello', model: 'selected', agentKind: 'codex' }), h.response);
  assert.deepEqual(h.created, [{ id: 'new', workspaceKind: 'dialogue', model: 'selected', agentKind: 'codex', title: undefined }]);
  assert.equal(h.enqueued[0].id, 'new');
  h.response.end();
});

test('recorded client IDs return a receipt and release the stream without claiming completion', async () => {
  const h = harness({ inputStatus: async () => 'recorded' });
  await h.handler(request({ sessionId: 's1', clientId: 'already-sent', prompt: 'retry' }), h.response);
  assert.equal(h.enqueued[0].clientId, 'already-sent');
  assert.match(h.writes.join(''), /"status":"recorded"/);
  assert.equal(h.response.writableEnded, true);
  assert.equal(h.events.size(), 0);
});

test('a rejected durable enqueue closes the stream and leaves no subscription', async () => {
  const h = harness({ enqueue: async () => { throw new Error('disk full'); } });
  await h.handler(request({ sessionId: 's1', prompt: 'hello' }), h.response);
  assert.match(h.writes.join(''), /disk full/);
  assert.equal(h.events.size(), 0);
  assert.equal(h.response.writableEnded, true);
});

test('a rejection that is not an error is reported without echoing the thrown value', async () => {
  const h = harness({ enqueue: async () => { throw { toString: () => 'at internal (/private/host/internal.js:1:1)' }; } });
  await h.handler(request({ sessionId: 's1', prompt: 'hello' }), h.response);
  const stream = h.writes.join('');
  assert.match(stream, /"reason":"chat_failed"/);
  assert.match(stream, /"message":"Unexpected error"/);
  assert.doesNotMatch(stream, /internal\.js/);
});
