import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { DeviceLinkClient, PROTOCOL_VERSION } from '@cindy/device-link';
import { AgentNetWorkerSocket } from '@cindy/agent-net';
import { createPrivateNetwork, generateIdentity, issueCertificate } from '@cindy/agent-net-relay';
import { readDeviceLinkInvokeSourceDevice, readDeviceLinkModelSelectionOrigin } from '../../desktop/src/main/device-link/invoke-context.ts';
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
  sqlite.exec(`CREATE TABLE im_bindings (target_session_id TEXT);
    CREATE TABLE shared_task_events (shared_task_id TEXT, session_id TEXT, revision INTEGER,
      kind TEXT, terminal INTEGER, snapshot TEXT, recorded_at INTEGER,
      PRIMARY KEY (shared_task_id, kind, revision));
    INSERT INTO sessions(id,title,source,status,working_dir,workspace_kind,created_at,updated_at)
    VALUES ('task','Shared task','desktop','active','/project','project',1,1)`);
  const db = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  setCurrentDbClient(db, 'test-headless-owner');
  const hub = createEventHub();
  const sockets = new Map();
  const platforms = new Map();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const clients = [];
  let host, hold, release, writes = 0, duplicateNext = false;
  let source;
  const modelChoices = [];
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
    updateSession: async (id, patch) => {
      modelChoices.push({ id, patch, origin: readDeviceLinkModelSelectionOrigin() });
      return { deferred: true };
    },
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
    isBusyForProjectArchive: () => false,
    onProjectTaskStatus: (sessionId, status) => hub.publish({ type: 'session_changed', sessionId, status, patch: { status } }),
    preparePiSkillRuntime: async (id, dir, route) => {
      assert.equal(id, 'task'); assert.equal(dir, '/project');
      if (route) assert.deepEqual(route, { model: 'pi-test', nextInputChars: 45_000 });
    },
    createRuntimeSession: async () => { throw new Error('Not part of this transport test'); },
    disableShareAvailability: async () => { throw new Error('This fixture owns no standby grants'); },
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
  // A full round trip from the desktop controller must preview and mutate the Host's project.
  const projectArchive = input => clients[2].invoke('host', { channel: 'local-db:sessions:project-archive',
    args: [{ directory: '/project', ...input }] });
  const removal = await projectArchive({ action: 'archiveOnRemoval', operation: 'apply', sessionId: 'task' });
  assert.equal(removal.ok, false, 'project removal is local to the owning desktop');
  const preview = await projectArchive({ action: 'archive', operation: 'preview' });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.result, [{ id: 'task', hasWorktree: false, blocked: null }]);
  for (const [action, expected] of [['archive', 'archived'], ['unarchive', 'active']]) {
    const result = await projectArchive({ action, operation: 'apply', sessionId: 'task' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result, 'updated');
    assert.equal(sqlite.prepare("SELECT status FROM sessions WHERE id='task'").pluck().get(), expected);
  }
  // 2026-11-18: exercise the real Host registry over the existing integration relay.
  // A positive controller window on either picker channel or Skill preparation must fail before applying it.
  const numericSelections = [
    { channel: 'maker:set-model', args: ['task', 'small', null, null, { effort: null, fastMode: false, confirmedContextWindow: 100 }] },
    { channel: 'maker:switch-session-agent', args: ['task', 'claude-code', 'small', null, null, false, { confirmedContextWindow: 100 }] },
    { channel: 'maker:session:prewarm', args: ['task', { purpose: 'pi-skill-dispatch', workingDir: '/project', model: 'pi-test', pendingPiRoute: {}, confirmedContextWindow: 100 }] },
  ];
  for (const selection of numericSelections) {
    const rejected = await clients[0].invoke('host', selection);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /PRECONDITION_FAILED/);
  }
  assert.deepEqual(modelChoices, []);
  const stage = await clients[0].invoke('host', { channel: 'maker:set-model', args: ['task', 'small'] });
  assert.deepEqual(stage.result, { deferred: true });
  assert.deepEqual(modelChoices, [{ id: 'task', patch: { model: 'small' }, origin: 'owner' }]);

  const prepared = await clients[2].invoke('host', { channel: 'maker:session:prewarm',
    args: ['task', { purpose: 'pi-skill-dispatch', workingDir: '/project' }] });
  assert.deepEqual(prepared.result, { accepted: true, piRuntimePrepared: true }, JSON.stringify(prepared));
  const switched = await clients[2].invoke('host', { channel: 'maker:session:prewarm',
    args: ['task', { purpose: 'pi-skill-dispatch', workingDir: '/project', model: 'pi-test', pendingPiRoute: { nextInputChars: 45_000 } }] });
  assert.deepEqual(switched.result, { accepted: true, piRuntimePrepared: true, pendingRouteApplied: true });
  const unsupported = await clients[2].invoke('host', { channel: 'maker:session:prewarm',
    args: ['task', { purpose: 'pi-skill-dispatch', workingDir: '/project', model: 'pi-test', pendingPiRoute: { agentDeviceId: 'other' } }] });
  assert.equal(unsupported.ok, false);
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
  const startedAt = Date.now() - 252000;
  sqlite.prepare('UPDATE sessions SET active_turn_started_at=? WHERE id=?').run(startedAt, 'task');
  clients[2].stop();
  await waitFor(() => !sockets.has('desktop'));
  release();
  assert.equal((await mobileWrite).ok, true);
  await waitFor(() => received[0].some(frame => frame.payload.channel === 'maker:input:projection'
    && frame.payload.payload.pendingQueue?.[0]?.clientId === 'during-handoff'));
  assert.equal(host.state().status, 'online');
  assert.equal(clients[0].getStatus(), 'online');
  clients[2] = await connect('desktop');
  const clock = await clients[2].invoke('host', { channel: 'local-db:sessions:get', args: ['task'] });
  assert.equal(clock.result.activeTurnStartedAt, startedAt);
  assert.ok(clock.result.turnElapsedMs >= 252000 && clock.result.turnElapsedMs <= Date.now() - startedAt);
  sqlite.prepare('UPDATE sessions SET last_turn_ended_at=? WHERE id=?').run(startedAt + 252731, 'task');
  assert.equal(writes, 2, 'reattaching the desktop must not replay mobile writes');
  hold = undefined;
  await host.revoke('ios');
  const denied = await clients[0].invoke('host', { channel: 'local-db:sessions:get', args: ['task'] }).catch(error => ({ denied: error }));
  assert.ok(denied.denied || denied.ok === false);
  const neighbor = await clients[1].invoke('host', { channel: 'local-db:sessions:get', args: ['task'] });
  assert.equal(neighbor.ok, true);
  assert.equal(neighbor.result.id, 'task');
  assert.equal(neighbor.result.turnElapsedMs, 252731);
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

// An outage on the main connection must release only its own MCP App views and OAuth callers.
test('keeps compatibility app callers alive when only the Agent-Net connection drops', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-app-routes-'));
  configureAppDataDir(profile);
  configureHostOwner({ userDataDir: profile, ownerId: 'test-app-routes' });
  const sqlite = new Database(':memory:');
  for (const table of [sessions, botSessionLinks, botProfiles]) {
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table)).map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  }
  sqlite.exec("INSERT INTO sessions(id,title,source,status,created_at,updated_at) VALUES ('session','Fixture','desktop','active',1,1)");
  const db = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  setCurrentDbClient(db, 'test-app-routes');

  class Wire extends EventEmitter {
    sent = [];
    bufferedAmount = 0;
    send(data) {
      const frame = JSON.parse(data);
      this.sent.push(frame);
      if (frame.kind === 'hello') queueMicrotask(() => this.push({ kind: 'hello-ack', payload: {
        serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'host', userId: 'test-app-routes',
      } }));
    }
    push(frame) { this.emit('message', JSON.stringify({ v: PROTOCOL_VERSION, ...frame })); }
    close(code = 1000) { this.emit('close', code); }
    knowsPeer(peer) { return peer === 'desktop'; }
    supports(peer) { return this.knowsPeer(peer); }
  }
  const wire = () => {
    const socket = new Wire();
    setImmediate(() => socket.emit('open'));
    return socket;
  };
  const { root, bootstrap } = createPrivateNetwork('Test Host network', generateIdentity('root-test'));
  const secrets = new Map();
  const releasedApps = [], releasedAuth = [];
  let primary, compatibility;
  t.mock.method(AgentNetWorkerSocket, 'open', async () => (primary = wire()));
  const host = createHostDeviceLink({
    profileDir: profile, version: 'test', getWsUrl: () => 'ws://127.0.0.1:9',
    getToken: async () => 'synthetic-host', canRegister: () => true,
    invoke: async () => ({ status: 200, body: {} }), subscribe: () => () => {},
    createRuntimeSession: async () => ({}), disableShareAvailability: async () => {},
    createWebSocket: () => (compatibility = wire()),
    releaseAuthCaller: caller => releasedAuth.push(caller),
    mcpApps: { invoke: async caller => caller, releaseCaller: async caller => { releasedApps.push(caller); } },
    agentNet: {
      base: () => 'https://test-agent-net.invalid', subject: () => 'test-app-routes',
      deviceId: () => 'host', deviceName: () => 'Test Host',
      readSecret: async key => secrets.get(key) ?? null,
      writeSecret: async (key, value) => { secrets.set(key, value); },
      enroll: async (_base, identity) => ({ rootPublicKey: bootstrap.rootPublicKey,
        certificate: issueCertificate(root, { networkId: 'account:test', subject: 'test-app-routes', identity, role: 'member' }) }),
      fetch: async () => new Response(null, { status: 404 }),
      createWebSocket: async () => { throw new Error('No real Agent-Net relay in this test'); },
      workerFile: () => 'fixture-worker.mjs', coreModule: async () => ({}), log: { info() {}, warn() {} },
    },
  });
  t.after(async () => {
    await host.stop();
    clearCurrentDbClient(db); sqlite.close();
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  await host.setAgentNetEnabled(true);
  await host.setEnabled(true);
  await waitFor(() => host.state().status === 'online' && compatibility?.sent.some(frame => frame.kind === 'hello'));
  for (const [socket, peer] of [[primary, 'desktop'], [compatibility, 'phone']]) {
    socket.push({ kind: 'link-open', src: peer, id: 'link-' + peer,
      payload: { controllerName: peer, protocolVersion: PROTOCOL_VERSION, appVersion: 'test' } });
    await waitFor(() => socket.sent.some(frame => frame.kind === 'link-accept'));
    socket.push({ kind: 'invoke', src: peer, id: 'app-' + peer,
      payload: { channel: 'maker:mcp-apps:v1', args: ['session', {}] } });
    await waitFor(() => socket.sent.some(frame => frame.kind === 'invoke-result'));
    assert.deepEqual(socket.sent.find(frame => frame.kind === 'invoke-result')?.payload, { ok: true, result: 'device:' + peer });
  }
  primary.close(1006);
  assert.deepEqual(releasedApps, ['device:desktop']);
  assert.deepEqual(releasedAuth, ['device:desktop']);

  await host.setEnabled(false);
  assert.deepEqual(releasedApps, ['device:desktop', 'device:phone']);
  assert.deepEqual(releasedAuth, ['device:desktop', 'device:phone']);
});

// Unit: the authenticated transport determines who can ask Desktop Main for project
// evidence. Persisted profile fields never select the privileged write adapter.
test('routes project writes by their authenticated caller', async () => {
  const writes = [];
  const service = createHostService({ updateProjectInfo: (...args) => { writes.push(args); return {}; } });
  const input = { create: true, projectKey: 'local:', repositoryUrl: 'https://gitlab.com/team/demo' };
  const envelope = { requestId: 'from-main', input };
  for (const caller of ['web:paired', 'device:phone']) {
    assert.equal((await service('/api/project-info/desktop-set', envelope, { caller })).status, 403);
    assert.equal((await service('/api/project-info/set', input, { caller })).status, 200);
    assert.deepEqual(writes.pop(), [input, { legacyDesktop: false }]);
  }
  const local = { caller: 'local-api:host' };
  await service('/api/project-info/set', input, local);
  assert.deepEqual(writes.pop(), [input, { legacyDesktop: true }]);
  await service('/api/project-info/desktop-set', envelope, local);
  assert.deepEqual(writes.pop(), [input, { desktopRequest: 'from-main' }]);
});
