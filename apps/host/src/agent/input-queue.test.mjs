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

function createHarness(overrides = {}) {
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
    ...overrides,
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

// A Host restart drops the in-memory Maker session, not the SDK conversation.
// The queue must hand the stored SDK identity to the real agent startup API.
test('reopens a stored conversation with its SDK identity after a Host restart', async () => {
  const h = createHarness({ readSession: async id => ({ id, agentKind: 'claude-code',
    model: 'stored-model', workingDir: '/tmp', providerId: 'xd', sdkSessionId: 'sdk-existing' }) });
  await h.queue.enqueue('restored-task', { clientId: 'after-restart', text: 'continue' });
  assert.equal(h.maker.sessions.get('restored-task').options.resumeSessionId, 'sdk-existing');
  await h.queue.dispose();
});

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
    h.events.map((event) => event.type).filter((type) => type === 'text').slice(0, 2),
    ['text', 'text'],
  );
});

// PR #9246 review: every assistant message of a tool-use turn keeps its own id.
test('text before a tool call and the final answer are stored as separate messages', async () => {
  const h = createHarness();
  await h.queue.enqueue('task-tools', { clientId: 'u-tools', text: 'use a tool' });
  const session = h.maker.sessions.get('task-tools');

  session.emit({ type: 'text', data: { text: 'let me check', isFinal: true }, agentMeta: { uuid: 'assistant-a' } });
  session.emit({ type: 'text', data: { text: 'all done', isFinal: true }, agentMeta: { uuid: 'assistant-b' } });
  session.emit({ type: 'done', data: {} });

  await waitFor(() => h.persisted.filter((row) => row.role === 'assistant').length === 2);
  const assistants = h.persisted.filter((row) => row.role === 'assistant');
  assert.deepEqual(assistants.map((row) => [row.clientId, row.content]), [
    ['assistant-a', 'let me check'],
    ['assistant-b', 'all done'],
  ]);
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
  session.emit({ type: 'text', data: { text: 'partial answer', isFinal: false } });

  const projection = await h.queue.stop('task-3');
  assert.equal(session.aborted, 1);
  assert.equal(projection.turnInProgress, false);
  assert.deepEqual(projection.pendingQueue.map((item) => item.clientId), ['b']);
  assert.equal(h.persisted.find(row => row.role === 'assistant')?.content, 'partial answer');
});

test('failed abort retains the active turn and does not start a second message', async () => {
  const h = createHarness();
  await h.queue.enqueue('task-stop', { clientId: 'a', text: 'long' });
  const session = h.maker.sessions.get('task-stop');
  session.abort = async () => { throw new Error('abort failed'); };
  await assert.rejects(h.queue.stop('task-stop'), /abort failed/);
  await h.queue.enqueue('task-stop', { clientId: 'b', text: 'later' });
  assert.equal(h.queue.projection('task-stop').turnInProgress, true);
  assert.deepEqual(session.sent, ['long']);
  session.emit({ type: 'text', data: { text: 'finished after failed abort', isFinal: true } });
  session.emit({ type: 'done' });
  await waitFor(() => !h.queue.projection('task-stop').turnInProgress);
  assert.equal(h.persisted.find(row => row.role === 'assistant')?.content, 'finished after failed abort');
  assert.deepEqual(session.sent, ['long']);
});

test('failed reply persistence pauses the queue and resume saves without rerunning the model', async () => {
  let failWrite = true;
  const saved = [];
  const h = createHarness({ persistMessage: async (_id, message) => {
    if (message.role === 'assistant' && failWrite) throw new Error('disk full');
    saved.push(message);
  } });
  await h.queue.enqueue('task-save', { clientId: 'a', text: 'first' });
  await h.queue.enqueue('task-save', { clientId: 'b', text: 'second' });
  const session = h.maker.sessions.get('task-save');
  session.emit({ type: 'text', data: { text: 'completed answer', isFinal: true } });
  session.emit({ type: 'done' });
  await waitFor(() => !h.queue.projection('task-save').turnInProgress);
  assert.equal(h.queue.projection('task-save').error, 'disk full');
  assert.equal(h.queue.projection('task-save').queuePaused, true);
  assert.deepEqual(session.sent, ['first']);
  failWrite = false;
  await h.queue.resume('task-save');
  assert.equal(saved.filter(row => row.role === 'assistant').length, 1);
  assert.equal(saved.find(row => row.role === 'assistant').content, 'completed answer');
  assert.deepEqual(session.sent, ['first', 'second']);
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

test('updateContent updates queued item text and preserves metadata', async () => {
  const h = createHarness();
  await h.queue.enqueue('task-5', { clientId: 'a', text: 'running' });
  await h.queue.enqueue('task-5', { clientId: 'b', text: 'original text', files: [{ id: 'f1' }] });

  const proj = await h.queue.updateContent('task-5', 'b', {
    text: 'updated text',
    files: [{ id: 'f1' }],
    chatMessage: { text: 'updated text' },
  });

  const updatedItem = proj.pendingQueue.find((item) => item.clientId === 'b');
  assert.ok(updatedItem);
  assert.equal(updatedItem.text, 'updated text');
  assert.deepEqual(updatedItem.files, [{ id: 'f1' }]);
  assert.equal(updatedItem.chatMessage.text, 'updated text');
});

test('updateText and move modify pending queue entries', async () => {
  const h = createHarness();
  await h.queue.enqueue('task-6', { clientId: 'a', text: 'running' });
  await h.queue.enqueue('task-6', { clientId: 'b', text: 'first queued' });
  await h.queue.enqueue('task-6', { clientId: 'c', text: 'second queued' });

  const proj1 = await h.queue.updateText('task-6', 'b', 'first queued edited');
  assert.equal(proj1.pendingQueue[0].text, 'first queued edited');

  const proj2 = await h.queue.move('task-6', 'b', 1);
  assert.deepEqual(proj2.pendingQueue.map((item) => item.clientId), ['c', 'b']);
});

test('setExpanded, setInteractionLock, setEditLock, clearSession update projection state', async () => {
  const h = createHarness();
  let proj = await h.queue.setExpanded('task-7', true);
  assert.equal(proj.queueExpanded, true);

  proj = await h.queue.setInteractionLock('task-7', 'lock-1', true);
  assert.deepEqual(proj.queueInteractionLocks, ['lock-1']);

  proj = await h.queue.setInteractionLock('task-7', 'lock-1', false);
  assert.deepEqual(proj.queueInteractionLocks, []);

  proj = await h.queue.setEditLock('task-7', 'msg-1', true);
  assert.deepEqual(proj.queueEditLocks, ['msg-1']);

  await h.queue.enqueue('task-7', { clientId: 'a', text: 'first' });
  await h.queue.enqueue('task-7', { clientId: 'b', text: 'second' });
  assert.equal(proj.pendingQueue.length, 0); // before enqueue was empty
  proj = h.queue.projection('task-7');
  assert.equal(proj.pendingQueue.length, 1); // 'a' was dispatched, 'b' is pending

  proj = await h.queue.clearSession('task-7');
  assert.equal(proj.pendingQueue.length, 0);
});

test('persists error message and updates projection when turn fails', async () => {
  const h = createHarness();
  await h.queue.enqueue('task-err', { clientId: 'u-1', text: 'will fail' });

  const session = h.maker.getSession('task-err');
  assert.ok(session);

  session.emit({ type: 'error', data: { message: 'Auth failed: 403' } });

  await waitFor(() => h.queue.projection('task-err').turnInProgress === false);

  const proj = h.queue.projection('task-err');
  assert.equal(proj.turnInProgress, false);
  assert.equal(proj.error, 'Auth failed: 403');

  const errorMessages = h.persisted.filter((m) => m.role === 'error');
  assert.equal(errorMessages.length, 1);
  assert.match(errorMessages[0].content, /Auth failed: 403/);
});

// PR #9246: concurrent HTTP enqueue calls must not start two turns before either
// completes. Existing coverage awaited enqueue A before submitting B (unit).
test('concurrent enqueue reserves the turn before asynchronous preparation', async () => {
  const h = createHarness();
  await Promise.all([
    h.queue.enqueue('task-1', { clientId: 'a', text: 'A' }),
    h.queue.enqueue('task-1', { clientId: 'b', text: 'B' }),
  ]);
  assert.deepEqual(h.maker.sessions.get('task-1').sent, ['A']);
  assert.deepEqual(h.queue.projection('task-1').pendingQueue.map((item) => item.text), ['B']);
});

test('preparation failure preserves queued input and allows explicit resume', async () => {
  const maker = createFakeMaker();
  let fail = true;
  const queue = createInputQueue({ getMaker: () => maker, hub: { publish() {} }, sent() {},
    readSession: async () => { if (fail) throw new Error('storage unavailable'); return { agentKind: 'claude-code' }; },
  });
  await assert.rejects(queue.enqueue('s', { clientId: 'a', text: 'A' }), /storage unavailable/);
  assert.equal(queue.projection('s').turnInProgress, false);
  assert.equal(queue.projection('s').pendingQueue[0]?.text, 'A');
  fail = false;
  await queue.resume('s');
  assert.deepEqual(maker.sessions.get('s').sent, ['A']);
});

test('stop during preparation waits for creation and prevents a late send', async () => {
  const maker = createFakeMaker();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = createInputQueue({ getMaker: () => maker, hub: { publish() {} }, sent() {},
    readSession: async () => { await gate; return { agentKind: 'cc', workingDir: '/tmp' }; },
  });
  const enqueue = queue.enqueue('s', { clientId: 'a', text: 'first' });
  const stopped = queue.stop('s');
  release();
  await Promise.all([enqueue, stopped]);
  assert.deepEqual(maker.getSession('s').sent, []);
  assert.equal(maker.getSession('s').aborted, 1);
  assert.equal(queue.projection('s').turnInProgress, false);
});

test('deleting a task aborts its turn and prevents queued or later messages', async () => {
  const h = createHarness();
  await h.queue.enqueue('s', { clientId: 'a', text: 'first' });
  await h.queue.enqueue('s', { clientId: 'b', text: 'second' });
  await h.queue.disposeSession('s');
  h.maker.getSession('s').emit({ type: 'done' });
  await h.queue.resume('s');
  assert.deepEqual(h.maker.getSession('s').sent, ['first']);
  assert.equal(h.queue.projection('s').pendingQueue.length, 0);
  await assert.rejects(h.queue.enqueue('s', { text: 'late' }), /closed/);
});

// Regression: cold-start settings must match the persisted task, even when the
// caller sends only text. Existing resume coverage checked only the SDK id.
test('restores persisted execution settings when the composer omits them', async () => {
  const h = createHarness({ readSession: async id => ({ id, agentKind: 'claude-code', model: 'stored',
    permissionMode: 'ask', effort: 'high', fastMode: false, planModeEnabled: true }) });
  await h.queue.enqueue('settings', { clientId: 'next', text: 'continue' });
  const opts = h.maker.sessions.get('settings').options;
  assert.equal(opts.permissionMode, 'ask');
  assert.equal(opts.effort, 'high');
  assert.equal(opts.fastMode, false);
  assert.equal(opts.planMode, true);
  await h.queue.dispose();
});
