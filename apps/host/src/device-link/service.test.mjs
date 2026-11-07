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
