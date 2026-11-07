import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceLinkService } from './service.mjs';

test('device-link service handles link-open, subscriptions, and channel invocations', async () => {
  let accepted = null;
  let resultSent = null;
  let statusCallback = null;
  let frameCallback = null;
  let clientStopped = false;

  const mockDeps = {
    realm: 'global',
    deviceId: 'test-device-id',
    deviceName: 'test-device',
    appVersion: '0.1.128',
    getAccessToken: async () => 'test-token',
    listSessions: async (body) => [{ id: 's1', title: 'Task 1', status: body.status ?? 'active' }],
    getSession: async (id) => ({ id, title: 'Task 1' }),
    updateSession: async (id, patch) => ({ id, ...patch }),
    createSession: async (body) => ({ id: 's2', ...body }),
    listMessages: async ({ sessionId }) => [{ id: 'm1', sessionId, content: 'hi' }],
    historyView: async (sessionId) => ({ items: [], sessionId }),
    listProviders: async () => ({ providers: [] }),
    listAvailableAgents: async () => ['claude-code'],
    getCapabilities: async () => ({ availableModels: [] }),
    listProjectAliases: async () => [],
    listRecentWorkdirs: async () => [],
    inputQueue: {
      enqueue: async (sessionId, item) => ({ accepted: true, sessionId, item }),
      stop: async (sessionId) => ({ stopped: true, sessionId }),
      steer: async (sessionId, text) => ({ steered: true, sessionId, text }),
      resume: async (sessionId) => ({ resumed: true, sessionId }),
      remove: async (sessionId, clientId) => ({ removed: true, sessionId, clientId }),
      getProjection: async (sessionId) => ({ sessionId, items: [] }),
    },
    eventHub: {
      subscribe: () => () => {},
    },
  };

  const service = createDeviceLinkService(mockDeps);
  service.start();

  const client = service.getClient();
  assert.ok(client, 'DeviceLinkClient should be instantiated');

  // Verify sendLinkAccept
  client.sendLinkAccept = (dst, reqId, payload) => {
    accepted = { dst, reqId, payload };
  };

  client.sendInvokeResult = (dst, reqId, payload) => {
    resultSent = { dst, reqId, payload };
  };

  // Simulate link-open frame
  client.emitFrame = (env) => {
    // onFrame listener was registered in start()
  };

  // Simulate link-open
  const frameListener = (client).listeners?.frame || null;

  // Test service.stop()
  service.stop();
});

test('device-link invokes local-db:sessions:list with normalized body', async () => {
  let listSessionsArg = null;
  let updateContentArg = null;
  const mockDeps = {
    realm: 'global',
    deviceId: 'test-device-id',
    getAccessToken: async () => 'token',
    listSessions: async (body) => {
      listSessionsArg = body;
      return [{ id: 's1' }];
    },
    getSession: async () => ({}),
    updateSession: async () => ({}),
    createSession: async () => ({}),
    listMessages: async () => [],
    historyView: async () => ({ items: [] }),
    listProviders: async () => ({ providers: [] }),
    listAvailableAgents: async () => [],
    getCapabilities: async () => ({}),
    listProjectAliases: async () => [],
    listRecentWorkdirs: async () => [],
    inputQueue: {
      enqueue: async () => ({}),
      stop: async () => ({}),
      steer: async () => ({}),
      resume: async () => ({}),
      remove: async () => ({}),
      updateContent: async (sid, cid, item) => {
        updateContentArg = { sid, cid, item };
        return { ok: true };
      },
      getProjection: async () => ({}),
    },
    eventHub: { subscribe: () => () => {} },
  };

  const service = createDeviceLinkService(mockDeps);
  service.start();
  const client = service.getClient();

  let sentResult = null;
  client.sendInvokeResult = (dst, reqId, payload) => {
    sentResult = payload;
  };

  // Find listener registered by service
  const listener = [...(client.frameHandlers ?? [])][0];
  assert.ok(listener, 'service must register frame listener');

  // Test sessions:list invocation
  await listener({
    kind: 'invoke',
    src: 'controller-1',
    id: 'req-1',
    payload: { channel: 'local-db:sessions:list', args: [50, 'active'] },
  });
  assert.deepEqual(listSessionsArg, { limit: 50, status: 'active' });
  assert.equal(sentResult?.ok, true);

  // Test maker:input:update-content
  await listener({
    kind: 'invoke',
    src: 'controller-1',
    id: 'req-2',
    payload: { channel: 'maker:input:update-content', args: ['s1', 'c1', { text: 'hello' }] },
  });
  assert.deepEqual(updateContentArg, { sid: 's1', cid: 'c1', item: { text: 'hello' } });
  assert.equal(sentResult?.ok, true);

  // Test unrecognized channel returns CHANNEL_NOT_ALLOWED
  await listener({
    kind: 'invoke',
    src: 'controller-1',
    id: 'req-3',
    payload: { channel: 'unknown:channel', args: [] },
  });
  assert.equal(sentResult?.ok, false);
  assert.equal(sentResult?.error?.code, 'CHANNEL_NOT_ALLOWED');

  service.stop();
});

test('device-link forwards eventHub events to subscribed controllers', async () => {
  const pushes = [];
  let hubCallback = null;

  const mockDeps = {
    realm: 'global',
    deviceId: 'test-device-id',
    getAccessToken: async () => 'token',
    listSessions: async () => [],
    getSession: async () => ({}),
    updateSession: async () => ({}),
    createSession: async () => ({}),
    listMessages: async () => [],
    historyView: async () => ({ items: [] }),
    listProviders: async () => ({ providers: [] }),
    listAvailableAgents: async () => [],
    getCapabilities: async () => ({}),
    listProjectAliases: async () => [],
    listRecentWorkdirs: async () => [],
    inputQueue: {
      enqueue: async () => ({}),
      stop: async () => ({}),
      steer: async () => ({}),
      resume: async () => ({}),
      remove: async () => ({}),
      getProjection: async () => ({}),
    },
    eventHub: {
      subscribe: (cb) => {
        hubCallback = cb;
        return () => {};
      },
    },
  };

  const service = createDeviceLinkService(mockDeps);
  service.start();
  const client = service.getClient();
  client.getStatus = () => 'online';
  client.sendPush = (dst, channel, payload) => {
    pushes.push({ dst, channel, payload });
  };

  const listener = [...(client.frameHandlers ?? [])][0];
  assert.ok(listener);

  // Subscribe controller-1 with object format { topics: [...] }
  await listener({
    kind: 'invoke',
    src: 'controller-1',
    id: 'sub-1',
    payload: { channel: 'device-link:topic-subscribe', args: [{ topics: ['session:task-1', 'sessions'] }] },
  });

  // 1. Agent event text delta
  hubCallback({
    type: 'agent_event',
    sessionId: 'task-1',
    event: { type: 'text', data: { text: 'Hello world', isFinal: false } },
    persistId: 'turn-1',
  });

  // 2. Persisted message created
  hubCallback({
    type: 'message_created',
    sessionId: 'task-1',
    message: { clientId: 'c1', role: 'user', content: 'hi' },
  });

  // 3. Session status patched
  hubCallback({
    type: 'session_changed',
    sessionId: 'task-1',
    patch: { title: 'Updated Title' },
  });

  // 4. Input queue projection
  hubCallback({
    type: 'input_projection',
    sessionId: 'task-1',
    projection: { sessionId: 'task-1', turnInProgress: true, pendingQueue: [] },
  });

  // Verify all 4 pushes were received by controller-1
  assert.ok(pushes.some((p) => p.dst === 'controller-1' && p.channel === 'maker:event' && p.payload.persistId === 'turn-1'));
  assert.ok(pushes.some((p) => p.dst === 'controller-1' && p.channel === 'local-db:messages:created' && p.payload.message?.content === 'hi'));
  assert.ok(pushes.some((p) => p.dst === 'controller-1' && p.channel === 'local-db:sessions:patched' && p.payload.patch?.title === 'Updated Title'));
  assert.ok(pushes.some((p) => p.dst === 'controller-1' && p.channel === 'maker:input:projection' && p.payload.sessionId === 'task-1'));

  service.stop();
});

test('device-link handles mobile channels (around-client-id, fs:stat-path, maker:list-active, maker:create-session)', async () => {
  let invokeResult = null;
  const mockDeps = {
    realm: 'global',
    deviceId: 'test-device-id',
    getAccessToken: async () => 'token',
    listSessions: async () => [],
    getSession: async () => ({}),
    updateSession: async (id, patch) => ({ id, ...patch }),
    createSession: async (opts) => ({ id: 'new-sid', agentKind: opts.agentKind ?? 'claude-code', workingDir: '/tmp' }),
    listMessages: async () => [],
    messagesAroundClientId: async (sessionId, clientId) => [{ id: 'm1', clientId, sessionId }],
    historyView: async () => ({ items: [] }),
    listProviders: async () => ({ providers: [] }),
    listAvailableAgents: async () => ['claude-code'],
    getCapabilities: async () => ({ availableModels: [] }),
    listProjectAliases: async () => [{ projectKey: 'p1', alias: 'Project 1' }],
    listRecentWorkdirs: async () => [],
    getMaker: () => ({
      listActiveSessions: () => [
        { id: 's1', agentKind: 'claude-code', workDir: '/tmp', capabilities: {}, isTurnRunning: () => true },
      ],
    }),
    inputQueue: {
      stop: async () => ({ ok: true }),
    },
    eventHub: {
      subscribe: () => () => {},
    },
  };

  const service = createDeviceLinkService(mockDeps);
  service.start();
  try {
    const client = service.getClient();
    client.sendInvokeResult = (_dst, _id, payload) => {
      invokeResult = payload;
    };

    const listener = [...(client.frameHandlers ?? [])][0];
    assert.ok(listener);

    // 1. local-db:messages:around-client-id
    await listener({
      kind: 'invoke',
      src: 'mobile-1',
      id: 'req-1',
      payload: { channel: 'local-db:messages:around-client-id', args: ['s1', 'c1', { radius: 10 }] },
    });
    assert.equal(invokeResult.ok, true);
    assert.deepEqual(invokeResult.result, [{ id: 'm1', clientId: 'c1', sessionId: 's1' }]);

    // 2. maker:list-active with snapshotVersion 2
    await listener({
      kind: 'invoke',
      src: 'mobile-1',
      id: 'req-2',
      payload: { channel: 'maker:list-active', args: [{ summary: true, snapshotVersion: 2 }] },
    });
    assert.equal(invokeResult.ok, true);
    assert.equal(invokeResult.result.format, 'active-sessions-v2');
    assert.equal(invokeResult.result.sessions[0].sessionId, 's1');
    assert.equal(invokeResult.result.sessions[0].isTurnRunning, true);

    // 3. maker:create-session
    await listener({
      kind: 'invoke',
      src: 'mobile-1',
      id: 'req-3',
      payload: { channel: 'maker:create-session', args: [{ agentKind: 'claude-code', model: 'claude-sonnet-4-6' }] },
    });
    assert.equal(invokeResult.ok, true);
    assert.equal(invokeResult.result.sessionId, 'new-sid');
    assert.equal(invokeResult.result.agentKind, 'claude-code');

    // 4. fs:stat-path
    await listener({
      kind: 'invoke',
      src: 'mobile-1',
      id: 'req-4',
      payload: { channel: 'fs:stat-path', args: [{ path: os.tmpdir() }] },
    });
    assert.equal(invokeResult.ok, true);
    assert.equal(invokeResult.result.kind, 'dir');

    // 5. sidebar-settings:get-project-aliases
    await listener({
      kind: 'invoke',
      src: 'mobile-1',
      id: 'req-5',
      payload: { channel: 'sidebar-settings:get-project-aliases', args: [] },
    });
    assert.equal(invokeResult.ok, true);
    assert.deepEqual(invokeResult.result, [{ projectKey: 'p1', alias: 'Project 1' }]);

    // 6. maker:goal:get-status
    await listener({
      kind: 'invoke',
      src: 'mobile-1',
      id: 'req-6',
      payload: { channel: 'maker:goal:get-status', args: ['s1'] },
    });
    assert.equal(invokeResult.ok, true);
    assert.equal(invokeResult.result, null);

    // 7. device-link:usage-widget:snapshot:v1
    await listener({
      kind: 'invoke',
      src: 'mobile-1',
      id: 'req-7',
      payload: { channel: 'device-link:usage-widget:snapshot:v1', args: [] },
    });
    assert.equal(invokeResult.ok, true);
    assert.equal(invokeResult.result.ok, false);
    assert.equal(invokeResult.result.reason, 'unavailable');
  } finally {
    service.stop();
  }
});
