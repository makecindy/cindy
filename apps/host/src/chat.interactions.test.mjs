import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { configureAppDataDir } from '../../desktop/src/main/userDataPath.ts';
import { hostRuntimeLayout } from './runtime-layout.mjs';
import { openOwnerDatabase } from '../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';

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
  // The Host always sends with a signed-in profile and its database: the working-directory check
  // reads the profile's conversation recovery directories (agent/working-directory.ts), and the send
  // reads the task's rows (a fixture profile: the guard against migrating the official shared
  // profile is lifted while it opens).
  const profile = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-chat-interactions-'));
  configureHostOwner({ userDataDir: profile, ownerId: 'chat-interactions' });
  configureAppDataDir(path.join(profile, 'app-data'));
  const sharedProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
  delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId: 'chat-interactions',
    isPackaged: false, drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath })
    .finally(() => { if (sharedProfile !== undefined) process.env.XDT_OFFICIAL_SHARED_PROFILE = sharedProfile; });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, 'chat-interactions');
  t.after(async () => {
    clearCurrentDbClient(); await database.dispose();
    configureHostOwner({ userDataDir: profile, ownerId: null }); rmSync(profile, { recursive: true, force: true });
  });
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
    // Fixture does not test admission (夹具不测准入): the runtime start admission lets every start through.
    admitLocalRoute: async () => {},
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
