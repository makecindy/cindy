import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';

import { createChatHandler } from './chat.mjs';
import { createEventHub } from './events.mjs';
import { createInteractionBroker } from './agent/interactions.mjs';
import { createInputQueue } from './agent/input-queue.mjs';

/**
 * `POST /chat` must publish tool approvals on the event stream. Without a
 * resolver the session denies every tool call as `no_listener_attached`, which
 * is how file access silently stopped working for API clients.
 */
test('chat uses the durable queue and approvals reach the client once', async (t) => {
  const hub = createEventHub();
  const broker = createInteractionBroker({ hub });
  const published = [];
  let requested, failed;
  const requestPublished = new Promise((resolve, reject) => { requested = resolve; failed = reject; });
  const unsubscribeHub = hub.subscribe((event) => {
    published.push(event);
    if (event.type === 'interaction_request') requested(event);
    if (event.type === 'input_projection' && event.projection.error) failed(new Error(event.projection.error));
  });
  t.after(unsubscribeHub);

  const listeners = [];
  let emitEvent = () => {};
  const session = {
    id: 'session-1',
    instanceId: 'runtime-1', agentKind: 'claude-code', workDir: os.tmpdir(),
    isTurnRunning: () => false,
    onEvent(callback) {
      emitEvent = callback;
      return () => {};
    },
    setInteractionListener(listener) {
      listeners.push(listener);
    },
    async abort() {},
    async send(_text, options) {
      options.onTurnReserved?.(1);
      await options.beforeProviderStart?.();
      await options.onAccepted?.(options.signal);
      options.onDispatching?.();
      const listener = listeners[0];
      assert.ok(listener, 'the broker must be attached before the turn starts');
      const decision = await listener({ kind: 'permission', requestId: 'req-1' });
      emitEvent({ type: 'done', data: {}, source: 'claude-code' });
      return { accepted: decision.behavior === 'allow' };
    },
  };

  const readSession = async () => ({ id: 'session-1', agentKind: 'claude-code', model: 'm', workingDir: os.tmpdir(), providerId: null });
  let live = false;
  const saved = [];
  const queue = createInputQueue({ readSession, hub,
    getMaker: () => ({ getSession: () => live ? session : null, getSessionMeta: async () => ({ title: 'Fixture' }),
      createSession: async () => { live = true; return session; }, closeSession: async () => { live = false; } }),
    persistMessage: async (_id, message) => { saved.push(message); },
    interactions: broker,
  });
  t.after(() => queue.dispose());
  const handler = createChatHandler({ readSession, events: hub,
    enqueue: (id, input) => queue.enqueue(id, input), inputStatus: (id, clientId) => queue.inputStatus(id, clientId) });

  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address();

  const pendingReply = fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'run a tool', sessionId: 'session-1' }),
    signal: AbortSignal.timeout(5_000),
  });

  // The turn blocks until the approval is answered over the broker.
  const request = await requestPublished;
  assert.ok(request, 'the approval request is published on the hub');
  assert.equal(request.sessionId, 'session-1');
  assert.equal(request.request.requestId, 'req-1');
  assert.equal(broker.respond('session-1', 'req-1', { kind: 'permission', behavior: 'allow' }), true);

  const reply = await pendingReply;
  const body = await reply.text();
  assert.match(body, /"type":"done"/);
  assert.equal(saved.filter(row => row.role === 'user').length, 1);
  assert.equal(broker.respond('session-1', 'req-1', { kind: 'permission', behavior: 'allow' }), false,
    'a settled request cannot be answered twice');

});
