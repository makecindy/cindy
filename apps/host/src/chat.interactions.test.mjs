import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createChatHandler } from './chat.mjs';
import { createEventHub } from './events.mjs';
import { createInteractionBroker } from './agent/interactions.mjs';

/**
 * `POST /chat` must publish tool approvals on the event stream. Without a
 * resolver the session denies every tool call as `no_listener_attached`, which
 * is how file access silently stopped working for API clients.
 */
test('chat attaches the interaction broker so tool approvals reach the client', async () => {
  const hub = createEventHub();
  const broker = createInteractionBroker({ hub });
  const published = [];
  const unsubscribeHub = hub.subscribe((event) => published.push(event));

  const listeners = [];
  let emitEvent = () => {};
  const session = {
    id: 'session-1',
    onEvent(callback) {
      emitEvent = callback;
      return () => {};
    },
    setInteractionListener(listener) {
      listeners.push(listener);
    },
    async send() {
      const listener = listeners[0];
      assert.ok(listener, 'the broker must be attached before the turn starts');
      const decision = await listener({ kind: 'permission', requestId: 'req-1' });
      emitEvent({ type: 'done', data: {}, source: 'claude-code' });
      return { accepted: decision.behavior === 'allow' };
    },
  };

  const handler = createChatHandler({
    readSession: async () => ({ id: 'session-1', agentKind: 'claude-code', model: 'm', workingDir: '/tmp', providerId: null }),
    maker: { getSession: () => session, createSession: async () => session },
    defaultWorkDir: '/tmp',
    defaultModel: 'm',
    interactions: broker,
  });

  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const pendingReply = fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'run a tool', sessionId: 'session-1' }),
  });

  // The turn blocks until the approval is answered over the broker.
  let request;
  for (let attempt = 0; attempt < 100 && !request; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    request = published.find((event) => event.type === 'interaction_request');
  }
  assert.ok(request, 'the approval request is published on the hub');
  assert.equal(request.sessionId, 'session-1');
  assert.equal(request.request.requestId, 'req-1');
  assert.equal(broker.respond('session-1', 'req-1', { kind: 'permission', behavior: 'allow' }), true);

  const reply = await pendingReply;
  const body = await reply.text();
  assert.match(body, /"type":"done"/);
  assert.equal(broker.respond('session-1', 'req-1', { kind: 'permission', behavior: 'allow' }), false,
    'a settled request cannot be answered twice');

  unsubscribeHub();
  await new Promise((resolve) => server.close(() => resolve()));
});
