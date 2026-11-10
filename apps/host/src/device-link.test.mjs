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
import { DeviceLinkClient, PROTOCOL_VERSION } from '@cindy/device-link';
import { readDeviceLinkInvokeSourceDevice } from '../../desktop/src/main/device-link/invoke-context.ts';
import { createHostDeviceLink } from './device-link.ts';
import { createHostService } from './service.mjs';
import { createEventHub } from './events.mjs';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { configureAppDataDir } from '../../desktop/src/main/userDataPath.ts';
import { commitVolatileAppSession } from '../../desktop/src/main/appSessionState.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { sessions, messages, taskTags, sessionTaskTags, botSessionLinks, botProfiles } from '../../desktop/src/main/localDb/schema.ts';
import { readHostSessionList, readHostSession } from './session-reads.ts';

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
    createRuntimeSession: async () => { throw new Error('Not part of this transport test'); },
    disableShareAvailability: async () => { throw new Error('This fixture owns no standby grants'); },
  });
  assert.equal(host.state().enabled, false);
  assert.equal(sockets.has('host'), false);
  await host.setEnabled(true);
  await waitFor(() => host.state().status === 'online');
  for (const id of ['ios', 'android', 'desktop']) {
    const client = new DeviceLinkClient({ getWsUrl: () => url, getToken: async () => `synthetic-${id}`,
      getHello: () => ({ deviceName: id, platform: id === 'desktop' ? 'darwin' : id, appVersion: 'test', remoteControlEnabled: false }),
      createWebSocket: (address, headers) => new WebSocket(address, { headers }),
    });
    clients.push(client); client.start();
    await waitFor(() => client.getStatus() === 'online');
    await client.openLink('host', { controllerName: id, protocolVersion: PROTOCOL_VERSION, appVersion: 'test' });
    const reply = await client.invoke('host', { channel: 'local-db:sessions:list', args: [] });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.result.map(row => row.id), ['task']);
  }
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
  await waitFor(() => writes === 2);
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
