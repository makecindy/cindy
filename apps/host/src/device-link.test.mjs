import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { DeviceLinkClient, PROTOCOL_VERSION, FILE_PEER_CHANNEL, REMOTE_AGENT_CHANNEL, REMOTE_DESKTOP_CHANNEL,
  PROVIDER_SHARE_RELAY_CAPABILITY, isProviderSharePeer, providerShareGuestPeer, providerShareHostPeer } from '@cindy/device-link';
import { readDeviceLinkInvokeSourceDevice } from '../../desktop/src/main/device-link/invoke-context.ts';
import { createHostDeviceLink } from './device-link.ts';
import { createHostService } from './service.mjs';
import { MCP_APPS_INVOKE } from '../../desktop/src/shared/mcpApps.ts';
import { createEventHub } from './events.mjs';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { configureAppDataDir } from '../../desktop/src/main/userDataPath.ts';
import { commitVolatileAppSession } from '../../desktop/src/main/appSessionState.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { sessions, messages, taskTags, sessionTaskTags, botSessionLinks, botProfiles } from '../../desktop/src/main/localDb/schema.ts';
import { readHostSessionList, readHostSession } from './session-reads.ts';
import { publishAgentEvent } from './agent/turn-executor.mjs';
import { redactEventForRenderer } from '../../desktop/src/main/maker-ipc/rendererEventRedaction.ts';

const waitFor = async condition => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the test relay');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

// Real Node WebSockets + shared production client/dispatcher + SQLite. The local
// relay authenticates synthetic tokens and stamps src; it is NOT official-relay
// or physical iOS/Android acceptance, and does not make a model call.
test('headless dispatcher serves multiple clients and enforces owner and per-device revocation', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-remote-'));
  configureAppDataDir(profile);
  configureHostOwner({ userDataDir: profile, ownerId: 'test-headless-owner' });
  const sqlite = new Database(':memory:');
  for (const table of [sessions, messages, taskTags, sessionTaskTags, botSessionLinks, botProfiles]) {
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table)).map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  }
  sqlite.exec("INSERT INTO sessions(id,title,source,status,created_at,updated_at) VALUES ('task','Shared task','desktop','active',1,1)");
  const db = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  setCurrentDbClient(db, 'test-headless-owner');
  const hub = createEventHub();
  const sockets = new Map();
  const platforms = new Map();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const clients = [];
  let host, hold, release, writes = 0, duplicateNext = false;
  let source;
  // Coexistence plan A: the refusal while a desktop uses the profile (null: not held).
  let held = null;
  let created = 0, appCalls = 0;
  t.after(async () => {
    clients.forEach(client => client.stop());
    await host?.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    clearCurrentDbClient(db); sqlite.close();
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  wss.on('connection', (socket, request) => {
    const match = /^Bearer synthetic-(host|ios|android|desktop)$/.exec(request.headers.authorization ?? '');
    if (!match) { socket.close(1008); return; }
    const id = match[1]; sockets.set(id, socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === 'hello') {
        platforms.set(id, frame.payload.platform);
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
          serverProtocolVersion: PROTOCOL_VERSION, deviceId: id, userId: 'synthetic-user', capabilities: [],
        } }));
        for (const [peer, target] of sockets) for (const [deviceId, platform] of platforms) {
          if (peer !== deviceId && target.readyState === WebSocket.OPEN) target.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: { deviceId, platform, online: true, remoteControlEnabled: true } }));
        }
      } else if (frame.kind === 'ping') socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'pong' }));
      else if (frame.dst && sockets.get(frame.dst)?.readyState === WebSocket.OPEN) {
        sockets.get(frame.dst).send(JSON.stringify({ ...frame, src: id }));
        if (duplicateNext && frame.kind === 'invoke') {
          duplicateNext = false;
          sockets.get(frame.dst).send(JSON.stringify({ ...frame, src: id }));
        }
      }
    });
    socket.once('close', () => { if (sockets.get(id) === socket) sockets.delete(id); });
  });
  await once(wss, 'listening');
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const service = createHostService({
    profileHold: () => held,
    // One USD and one CNY quote: the device-link v1 projection keeps only USD (usageHandlers.ts).
    modelPricing: async () => ({ xd: {
      'usd-model': { providerId: 'xd', modelId: 'usd-model', currency: 'USD', source: 'gateway', approximate: false, inputPerMtok: 3, outputPerMtok: 15 },
      'cny-model': { providerId: 'xd', modelId: 'cny-model', currency: 'CNY', source: 'gateway', approximate: false, inputPerMtok: 20, outputPerMtok: 80 },
    } }),
    listSessions: options => readHostSessionList(db.drizzle, options),
    getSession: id => readHostSession(db.drizzle, id),
    input: { enqueue: async (sessionId, item) => {
      writes++; source = readDeviceLinkInvokeSourceDevice();
      await hold;
      const projection = { sessionId, pendingQueue: [item], turnInProgress: false };
      hub.publish({ type: 'input_projection', sessionId, projection });
      return projection;
    } },
  });
  host = createHostDeviceLink({ profileDir: profile, version: 'test', getWsUrl: () => url,
    getToken: async () => 'synthetic-host', canRegister: () => true,
    invoke: service, subscribe: hub.subscribe,
    createRuntimeSession: async () => { created++; throw new Error('Not part of this transport test'); },
    disableShareAvailability: async () => { throw new Error('This fixture owns no standby grants'); },
    profileHold: () => held,
    mcpApps: { invoke: async () => { appCalls++; return {}; }, releaseCaller: async () => {} },
  });
  assert.equal(host.state().enabled, false);
  assert.equal(sockets.has('host'), false);
  await host.setEnabled(true);
  await waitFor(() => host.state().status === 'online');
  async function connect(id) {
    const client = new DeviceLinkClient({ getWsUrl: () => url, getToken: async () => `synthetic-${id}`,
      getHello: () => ({ deviceName: id, platform: id === 'desktop' ? 'darwin' : id, appVersion: 'test', remoteControlEnabled: false }),
      createWebSocket: (address, headers) => new WebSocket(address, { headers }),
    });
    client.start();
    await waitFor(() => client.getStatus() === 'online');
    await client.openLink('host', { controllerName: id, protocolVersion: PROTOCOL_VERSION, appVersion: 'test' });
    const reply = await client.invoke('host', { channel: 'local-db:sessions:list', args: [] });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.result.map(row => row.id), ['task']);
    return client;
  }
  for (const id of ['ios', 'android', 'desktop']) clients.push(await connect(id));
  // A phone asks the v1 channel, as the desktop answers it: flat USD fields, CNY quotes left out.
  const v1 = await clients[0].invoke('host', { channel: 'maker:usage:model-pricing', args: [] });
  assert.deepEqual(v1.result, { 'usd-model': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 } }, JSON.stringify(v1));
  const received = clients.map(() => []);
  clients.forEach((client, i) => client.onFrame(frame => { if (frame.kind === 'push') received[i].push(frame); }));
  duplicateNext = true;
  const queued = await clients[0].invoke('host', { channel: 'maker:input:enqueue', args: ['task', { clientId: 'single', text: 'one' }] });
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(writes, 1, 'a retransmitted frame must not execute twice');
  assert.equal(source.deviceId, 'ios');
  assert.equal(source.platform, 'mobile');
  await waitFor(() => received.every(frames => frames.some(frame => frame.payload.channel === 'maker:input:projection')));
  // Saved error rows must reach the channel desktop and mobile already listen on.
  hub.publish({ type: 'error_persisted', sessionId: 'task', persistId: 'err' });
  await waitFor(() => received.every(frames => frames.some(frame => frame.payload.channel === 'local-db:session:error-persisted')));
  // An agent event reaches every controller as the Host publishes it for its clients: the desktop's
  // renderer-boundary projection, without the proxy credential or Host lifecycle fields.
  const browserEvent = { type: 'tool_use', sessionTurnGeneration: 3, sessionInstanceId: 'fixture-runtime', turnAttemptToken: 'fixture-attempt',
    data: { toolUseId: 'browse-remote', toolName: 'mcp__cindy_browser__call_tool',
      input: { name: 'browser', args: { action: 'open', proxyServer: 'http://fixture-user:fixture-pass@proxy.test:8080' } } } };
  publishAgentEvent(hub, 'task', browserEvent, { inputClientId: 'single' });
  const carries = frame => JSON.stringify(frame).includes('browse-remote');
  await waitFor(() => received.every(frames => frames.some(carries)));
  for (const frames of received) {
    const pushed = frames.filter(carries);
    assert.equal(JSON.stringify(pushed).includes('fixture-pass'), false);
    assert.equal(JSON.stringify(pushed).includes('fixture-attempt'), false);
    assert.ok(JSON.stringify(pushed).includes(JSON.stringify(redactEventForRenderer(browserEvent).data)));
  }
  // Desktop connection lifetime must not own the Host/mobile connection. Keep a
  // mobile write admitted while the old desktop disconnects; the replacement
  // reads the same Host without replaying the mobile operation.
  hold = new Promise(resolve => { release = resolve; });
  const mobileWrite = clients[0].invoke('host', { channel: 'maker:input:enqueue', args: ['task', { clientId: 'during-handoff', text: 'still connected' }] });
  await waitFor(() => writes === 2);
  clients[2].stop();
  await waitFor(() => !sockets.has('desktop'));
  release();
  assert.equal((await mobileWrite).ok, true);
  await waitFor(() => received[0].some(frame => frame.payload.channel === 'maker:input:projection'
    && frame.payload.payload.pendingQueue?.[0]?.clientId === 'during-handoff'));
  assert.equal(host.state().status, 'online');
  assert.equal(clients[0].getStatus(), 'online');
  clients[2] = await connect('desktop');
  assert.equal(writes, 2, 'reattaching the desktop must not replay mobile writes');
  hold = undefined;
  // Coexistence plan A: while a desktop uses the profile, a phone's send, a new task and a plugin
  // page's call are refused with the typed reason, and none reaches its handler; reads still answer.
  held = 'HOST_PROFILE_IN_USE_BY_DESKTOP: held for this test';
  for (const [channel, args] of [['maker:input:enqueue', ['task', { clientId: 'held', text: 'refused' }]],
    ['maker:create-session', [{}]], [MCP_APPS_INVOKE, ['task', {}]]]) {
    const reply = await clients[0].invoke('host', { channel, args });
    assert.equal(reply.ok, false, `${channel}: ${JSON.stringify(reply)}`);
    assert.ok(JSON.stringify(reply.error).includes('HOST_PROFILE_IN_USE_BY_DESKTOP'), `${channel}: ${JSON.stringify(reply)}`);
  }
  assert.deepEqual([writes, created, appCalls], [2, 0, 0], 'nothing reached a handler');
  assert.equal((await clients[0].invoke('host', { channel: 'local-db:sessions:get', args: ['task'] })).ok, true, 'reads still answer');
  held = null;
  await host.revoke('ios');
  const denied = await clients[0].invoke('host', { channel: 'local-db:sessions:get', args: ['task'] }).catch(error => ({ denied: error }));
  assert.ok(denied.denied || denied.ok === false);
  const neighbor = await clients[1].invoke('host', { channel: 'local-db:sessions:get', args: ['task'] });
  assert.equal(neighbor.ok, true);
  assert.equal(neighbor.result.id, 'task');
  const forbidden = await clients[2].invoke('host', { channel: 'host:execute-arbitrary', args: [] }).catch(error => ({ denied: error }));
  assert.ok(forbidden.denied || forbidden.ok === false);
  await host.setEnabled(false);
  assert.equal(host.state().status, 'stopped');
  assert.equal(host.state().controllers.length, 0);
  await host.setEnabled(true);
  await waitFor(() => host.state().status === 'online');
  await clients[1].openLink('host', { controllerName: 'android', protocolVersion: PROTOCOL_VERSION, appVersion: 'test' });
  hold = new Promise(resolve => { release = resolve; });
  const inFlight = clients[1].invoke('host', { channel: 'maker:input:enqueue', args: ['task', { clientId: 'pending', text: 'wait' }] }).catch(() => null);
  await waitFor(() => writes === 3);
  commitVolatileAppSession('cloud', 'another-test-owner', true);
  await assert.rejects(host.setEnabled(true), /account changed/);
  let stopped = false;
  const stopping = host.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(stopped, false, 'shutdown must retain storage while an admitted write settles');
  release();
  await stopping;
  clients[1].stop(); await inFlight;
});

// Test value (engineering-conventions §3.2)
// - Production entry and observable result: createHostDeviceLink (the dispatcher the Host starts
//   after sign-in, main.ts startDeviceLink), reached by real DeviceLinkClients through a local
//   relay. A provider-share guest gets the typed ACCESS_REVOKED result on any channel and never
//   reaches the Host service; a same-account controller asking for a file peer or remote desktop
//   gets a typed refusal instead of a session.
// - Rule: release table row 乙 6. The Host never calls setProviderShareAccess, so the first gate of
//   runProviderShareInvoke (dispatch.ts providerShareGuestAccess) is always empty; requestFilePeer and
//   requestRemoteDesktop are not passed, so the dispatcher's unavailable() defaults apply
//   (dispatch.ts:494-496). Passing either port later must be a decision, not an accident.
// - Coverage gap: the test above only drives same-account controllers on the contract channels;
//   nothing ran a share-guest peer or these two platform channels against the Host assembly.
// - Minimal failing input: a share access port that admits the guest, or a requestRemoteDesktop
//   that resolves, in the Host's createInboundDispatch ports.
// - Tier: unit with loopback sockets in-process, as the test above (no relay, no network, no model).
test('Host device-link refuses provider-share guests and the platform features it does not wire', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-remote-refusals-'));
  configureAppDataDir(profile);
  configureHostOwner({ userDataDir: profile, ownerId: 'test-refusal-owner' });
  const hostKey = providerShareHostPeer('share-fixture', 'host');
  const guestKey = providerShareGuestPeer('share-fixture', 'member-fixture', 'guest');
  assert.ok(isProviderSharePeer(guestKey));
  const sockets = new Map();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const reached = [];
  let host, desktop, guest;
  t.after(async () => {
    desktop?.stop(); guest?.stop();
    await host?.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  // The relay stamps src (and the share source for scoped frames); the guest belongs to another account.
  wss.on('connection', (socket, request) => {
    const id = /^Bearer synthetic-(host|desktop|guest)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!id) { socket.close(1008); return; }
    sockets.set(id, socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === 'hello') {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
          serverProtocolVersion: PROTOCOL_VERSION, deviceId: id, userId: `synthetic-${id === 'guest' ? 'other' : 'same'}-user`,
          capabilities: [PROVIDER_SHARE_RELAY_CAPABILITY],
        } }));
        if (id === 'desktop') sockets.get('host')?.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'presence-changed',
          payload: { deviceId: 'desktop', platform: 'darwin', online: true, remoteControlEnabled: true } }));
      } else if (frame.kind === 'ping') socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'pong' }));
      else if (frame.dst && sockets.get(frame.dst)?.readyState === WebSocket.OPEN) {
        // Like the relay, author the share source from the sender's identity; never trust the client's.
        const providerShare = frame.providerShare && { ...frame.providerShare,
          source: id === 'guest' ? { role: 'guest', memberId: 'member-fixture' } : { role: 'host' } };
        sockets.get(frame.dst).send(JSON.stringify({ ...frame, src: id, ...(providerShare ? { providerShare } : {}) }));
      }
    });
  });
  await once(wss, 'listening');
  const url = `ws://127.0.0.1:${wss.address().port}`;
  host = createHostDeviceLink({ profileDir: profile, version: 'test', getWsUrl: () => url,
    getToken: async () => 'synthetic-host', canRegister: () => true,
    invoke: async route => { reached.push(route); return { status: 404, body: { message: `unexpected ${route}` } }; },
    subscribe: () => () => {},
    createRuntimeSession: async () => { throw new Error('Not part of this test'); },
    disableShareAvailability: async () => { throw new Error('This fixture owns no standby grants'); },
  });
  await host.setEnabled(true);
  await waitFor(() => host.state().status === 'online');
  const client = id => {
    const value = new DeviceLinkClient({ getWsUrl: () => url, getToken: async () => `synthetic-${id}`,
      getHello: () => ({ deviceName: id, platform: 'darwin', appVersion: 'test', remoteControlEnabled: false }),
      createWebSocket: (address, headers) => new WebSocket(address, { headers }),
    });
    value.start();
    return value;
  };
  desktop = client('desktop');
  guest = client('guest');
  await waitFor(() => desktop.getStatus() === 'online' && guest.getStatus() === 'online');
  await desktop.openLink('host', { controllerName: 'desktop', protocolVersion: PROTOCOL_VERSION, appVersion: 'test' });

  const filePeer = await desktop.invoke('host', { channel: FILE_PEER_CHANNEL, args: [{}] });
  assert.deepEqual(filePeer, { ok: false, error: { code: 'IPC_ERROR', message: 'FILE_PEER_UNAVAILABLE' } });
  const remoteDesktop = await desktop.invoke('host', { channel: REMOTE_DESKTOP_CHANNEL, args: [{}] });
  assert.equal(remoteDesktop.ok, false, JSON.stringify(remoteDesktop));
  assert.equal(remoteDesktop.error.code, 'IPC_ERROR');
  assert.match(remoteDesktop.error.message, /^\[NOT_SUPPORTED\] requestRemoteDesktop /);

  for (const channel of [REMOTE_AGENT_CHANNEL, 'local-db:sessions:list', 'host:execute-arbitrary']) {
    const reply = await guest.invoke(hostKey, { channel, args: [] });
    assert.equal(reply.ok, false, `${channel}: ${JSON.stringify(reply)}`);
    assert.equal(reply.error.code, 'ACCESS_REVOKED', `${channel}: ${JSON.stringify(reply)}`);
  }
  assert.deepEqual(reached, [], 'neither refusal may reach the Host service');
});
