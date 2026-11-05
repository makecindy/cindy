import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInputQueue } from './input-queue.mjs';

/** Minimal Maker stand-in: one live session per id, driven by the test. */
function createFakeMaker() {
  const sessions = new Map();
  return {
    sessions,
    getSession(id) {
      return sessions.get(id) ?? null;
    },
    async createSession(opts) {
      const listeners = new Set();
      const session = {
        id: opts.id,
        options: opts,
        sent: [],
        aborted: 0,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        emit(event) {
          for (const listener of [...listeners]) listener(event);
        },
        async send(text) {
          session.sent.push(text);
          return { accepted: true };
        },
        async abort() {
          session.aborted += 1;
        },
        async steer(text) {
          session.sent.push(`steer:${text}`);
          return { accepted: true };
        },
      };
      sessions.set(opts.id, session);
      return session;
    },
  };
}

function createHarness() {
  const maker = createFakeMaker();
  const events = [];
  const persisted = [];
  const queue = createInputQueue({
    getMaker: () => maker,
    hub: { publish: (event) => events.push(event) },
    readSession: async (sessionId) => ({
      id: sessionId,
      agentKind: 'claude-code',
      model: 'stored-model',
      workingDir: '/tmp',
      providerId: 'xd',
    }),
    persistMessage: async (sessionId, input) => {
      persisted.push({ sessionId, ...input });
    },
    sent: () => {},
  });
  return { maker, events, persisted, queue };
}

const waitFor = async (check) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
};

test('dispatches a queued message and stores the user and assistant rows', async () => {
  const h = createHarness();
  const projection = await h.queue.enqueue('task-1', {
    clientId: 'c1',
    text: 'hello',
    model: 'anthropic/claude-sonnet-5-5',
  });

  const session = h.maker.sessions.get('task-1');
  assert.deepEqual(session.sent, ['hello']);
  // The composer's route wins over the stored row.
  assert.equal(session.options.model, 'anthropic/claude-sonnet-5-5');
  await waitFor(() => h.persisted.some((row) => row.role === 'user'));
  assert.equal(projection.turnInProgress, true);

  session.emit({ type: 'text', data: { text: 'hi there', isFinal: false } });
  session.emit({
    type: 'text',
    data: { text: 'hi there', isFinal: true },
    agentMeta: { uuid: 'assistant-1' },
  });
  session.emit({ type: 'done', data: {} });

  await waitFor(() => h.persisted.some((row) => row.role === 'assistant'));
  const assistant = h.persisted.find((row) => row.role === 'assistant');
  assert.equal(assistant.content, 'hi there');
  assert.equal(assistant.clientId, 'assistant-1');
  assert.equal(h.queue.projection('task-1').turnInProgress, false);
  assert.deepEqual(
    h.events.map((event) => event.type).filter((type) => type !== undefined).slice(0, 2),
    ['text', 'text'],
  );
});

test('a second message waits for the running turn instead of interleaving', async () => {
  const h = createHarness();
  await h.queue.enqueue('task-2', { clientId: 'a', text: 'first' });
  const running = h.queue.projection('task-2');
  assert.equal(running.turnInProgress, true);
  assert.equal(running.pendingQueue.length, 0);

  const second = await h.queue.enqueue('task-2', { clientId: 'b', text: 'second' });
  assert.deepEqual(second.pendingQueue.map((item) => item.clientId), ['b']);
  const session = h.maker.sessions.get('task-2');
  assert.deepEqual(session.sent, ['first']);

  session.emit({ type: 'done', data: {} });
  await waitFor(() => session.sent.length === 2);
  assert.deepEqual(session.sent, ['first', 'second']);
});

test('stop aborts the running turn and keeps the queue', async () => {
  const h = createHarness();
  await h.queue.enqueue('task-3', { clientId: 'a', text: 'long' });
  await h.queue.enqueue('task-3', { clientId: 'b', text: 'later' });
  const session = h.maker.sessions.get('task-3');

  const projection = await h.queue.stop('task-3');
  assert.equal(session.aborted, 1);
  assert.equal(projection.turnInProgress, false);
  assert.deepEqual(projection.pendingQueue.map((item) => item.clientId), ['b']);
});

test('the projection carries every field the renderer reads', () => {
  const h = createHarness();
  const projection = h.queue.projection('task-4');
  for (const key of [
    'sessionId',
    'turnInProgress',
    'pendingQueue',
    'clearBoundaryMs',
    'steeringQueueClientIds',
    'queuePaused',
    'queueExpanded',
    'queueInteractionLocks',
    'queueEditLocks',
    'queueAbortPending',
    'error',
    'recovery',
    'errorRetryText',
    'usageLimitWait',
    'credentialSwitchWait',
  ]) {
    assert.ok(key in projection, `missing projection field: ${key}`);
  }
});
