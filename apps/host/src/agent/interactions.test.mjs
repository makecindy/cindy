import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionBroker } from './interactions.mjs';
import { beginUnattendedTurn } from '../../../desktop/src/main/mcp-integrations/unattendedTurn.ts';

function createSession(id = 'task') {
  const session = {
    id,
    listener: null,
    setInteractionListener(listener) {
      session.listener = listener;
    },
  };
  return session;
}

test('historical App permission uses the shared router and only accepts one client answer', async () => {
  const broker = createInteractionBroker({ hub: { publish() {} } });
  const controller = new AbortController();
  const result = broker.requestHost('history', { kind: 'permission', requestId: 'page-1',
    metadata: { mcpApp: { serverId: 'plugin', scope: 'once' } } }, controller.signal, { isCurrent: () => true });
  assert.equal(broker.pending('history').length, 1);
  assert.equal(broker.respond('other-task', 'page-1', { behavior: 'allow' }), false);
  assert.equal(broker.respond('history', 'page-1', { behavior: 'allow' }), true);
  assert.equal(broker.respond('history', 'page-1', { behavior: 'deny' }), false);
  assert.equal((await result).behavior, 'allow');
  broker.dispose();
});

test('disconnecting the owner cancels pending historical page confirmation', async () => {
  let current = true;
  const broker = createInteractionBroker({ hub: { publish() {} } });
  const result = broker.requestHost('history', { kind: 'permission', requestId: 'page-2' },
    new AbortController().signal, { isCurrent: () => current });
  current = false;
  assert.equal(broker.respond('history', 'page-2', { behavior: 'allow' }), false);
  assert.equal((await result).behavior, 'deny'); broker.dispose();
});

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
    decision: { kind: 'permission', behavior: 'allow' },
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
  assert.equal(decision.reason, 'session_aborted');
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

// Shared-router regressions: a cancellation must retain the request kind, and
// timer-triggered questions must follow Desktop's unattended-turn policy.
test('questions and plan reviews use shared cancellation and unattended rules', async () => {
  const broker = createInteractionBroker({ hub: { publish() {} } });
  const session = createSession('background');
  broker.attach(session, session.id);
  for (const kind of ['ask_user_question', 'plan_review']) {
    const controller = new AbortController();
    const pending = session.listener({ requestId: kind, kind }, controller.signal);
    controller.abort();
    const decision = await pending;
    assert.equal(decision.kind, kind);
    if (kind === 'plan_review') assert.equal(decision.dismissed, true);
    else assert.deepEqual(decision.answers, {});
  }
  const end = beginUnattendedTurn(session.id);
  try {
    assert.deepEqual(await session.listener({ requestId: 'timer', kind: 'ask_user_question' }),
      { kind: 'ask_user_question', answers: {}, dismissed: true });
    assert.deepEqual(broker.pending(session.id), []);
  } finally { end(); broker.dispose(); }
});

// Two clients may answer concurrently. A rejected payload or an editing receipt
// cannot consume the question; only one final answer can resume its provider.
test('rejects mismatched answers and consumes the first valid answer exactly once', async () => {
  const broker = createInteractionBroker({ hub: { publish() {} } });
  const session = createSession();
  broker.attach(session, session.id);
  const answer = session.listener({ requestId: 'q', kind: 'ask_user_question', isBlocking: false });
  assert.equal(broker.respond('task', 'q', { kind: 'permission', behavior: 'allow' }), false);
  assert.equal(broker.respond('task', 'q', { answers: { q: [] } }), false);
  assert.equal(broker.respond('task', 'q', { kind: 'ask_user_question', inProgress: true }), true);
  assert.equal(broker.pending('task').length, 1);
  assert.equal(broker.respond('task', 'q', { answers: { q: 'first' } }), true);
  assert.equal(broker.respond('task', 'q', { answers: { q: 'second' } }), false);
  assert.deepEqual(await answer, { kind: 'ask_user_question', answers: { q: 'first' } });
  broker.dispose();
});

test('an owner change denies a stale answer without publishing into the new account', async () => {
  const events = [];
  const broker = createInteractionBroker({ hub: { publish: event => events.push(event) } });
  const session = createSession();
  let current = true;
  broker.attach(session, session.id, { isCurrent: () => current });
  const answer = session.listener({ requestId: 'private', kind: 'permission' });
  current = false;
  assert.equal(broker.pending('task').length, 0);
  assert.equal(broker.respond('task', 'private', { behavior: 'allow' }), false);
  assert.equal((await answer).behavior, 'deny');
  assert.equal(events.length, 1);
  broker.dispose();
});
