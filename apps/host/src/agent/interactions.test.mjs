import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionBroker } from './interactions.mjs';

function createSession() {
  const session = {
    listener: null,
    setInteractionListener(listener) {
      session.listener = listener;
    },
  };
  return session;
}

test('publishes the request and resolves the decision the client returns', async () => {
  const events = [];
  const broker = createInteractionBroker({ hub: { publish: (event) => events.push(event) } });
  const session = createSession();
  broker.attach(session, 'task-1');

  const decisionPromise = session.listener({ requestId: 'req-1', kind: 'permission' });
  await Promise.resolve();
  assert.deepEqual(events[0], {
    type: 'interaction_request',
    sessionId: 'task-1',
    request: { requestId: 'req-1', kind: 'permission' },
  });
  assert.deepEqual(broker.pending('task-1').map((entry) => entry.requestId), ['req-1']);
  assert.equal(broker.respond('another-task', 'req-1', { kind: 'permission', behavior: 'allow' }), false);
  assert.equal(broker.pending('task-1').length, 1);

  assert.equal(
    broker.respond('task-1', 'req-1', { kind: 'permission', behavior: 'allow' }),
    true,
  );
  assert.deepEqual(await decisionPromise, { kind: 'permission', behavior: 'allow' });
  assert.deepEqual(events.at(-1), {
    type: 'interaction_dismissed',
    sessionId: 'task-1',
    requestId: 'req-1',
    reason: 'resolved',
  });
  assert.deepEqual(broker.pending('task-1'), []);
});

test('denies when the turn aborts and reports the dismissal', async () => {
  const events = [];
  const broker = createInteractionBroker({ hub: { publish: (event) => events.push(event) } });
  const session = createSession();
  broker.attach(session, 'task-2');

  const controller = new AbortController();
  const decisionPromise = session.listener({ requestId: 'req-2', kind: 'permission' }, controller.signal);
  await Promise.resolve();
  controller.abort();

  const decision = await decisionPromise;
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.reason, 'aborted');
  assert.deepEqual(broker.pending('task-2'), []);
  assert.equal(events.filter(event => event.type === 'interaction_dismissed').length, 1);
  assert.equal(events.at(-1).reason, 'aborted');
});

test('an answered request removes its abort listener and cannot dismiss a later request', async () => {
  const events = [];
  const broker = createInteractionBroker({ hub: { publish: event => events.push(event) } });
  const session = createSession();
  broker.attach(session, 'task');
  const controller = new AbortController();
  const first = session.listener({ requestId: 'reused', kind: 'permission' }, controller.signal);
  broker.respond('task', 'reused', { kind: 'permission', behavior: 'allow' });
  await first;
  const second = session.listener({ requestId: 'reused', kind: 'permission' });
  controller.abort();
  assert.equal(broker.pending('task').length, 1);
  assert.equal(events.filter(event => event.type === 'interaction_dismissed').length, 1);
  broker.respond('task', 'reused', { kind: 'permission', behavior: 'deny' });
  assert.equal((await second).behavior, 'deny');
});

test('unknown requests are rejected instead of silently accepted', () => {
  const broker = createInteractionBroker({ hub: { publish: () => {} } });
  assert.equal(broker.respond('task-3', 'missing', { kind: 'permission', behavior: 'allow' }), false);
});
