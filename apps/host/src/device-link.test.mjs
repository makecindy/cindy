import { holdError, releaseFailure } from './agent/profile-hold.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { DeviceLinkClient, PROTOCOL_VERSION, FILE_PEER_CHANNEL, REMOTE_AGENT_CHANNEL, REMOTE_DESKTOP_CHANNEL,
  PROVIDER_SHARE_RELAY_CAPABILITY, isProviderSharePeer, providerShareGuestPeer, providerShareHostPeer, PLUGIN_OAUTH_CHANNEL } from '@cindy/device-link';
import { AgentNetWorkerSocket } from '@cindy/agent-net';
import { createPrivateNetwork, generateIdentity, issueCertificate } from '@cindy/agent-net-relay';
import { readDeviceLinkInvokeSourceDevice, readDeviceLinkModelSelectionOrigin } from '../../desktop/src/main/device-link/invoke-context.ts';
import { createHostDeviceLink, HOST_DISPATCH_PORTS_WHILE_HELD } from './device-link.ts';
import { createHostWorktreeLifecycle } from './agent/worktree-lifecycle.ts';
import { createHostService } from './service.mjs';
import { createHostServer } from './server.mjs';
import { MCP_APPS_INVOKE } from '../../desktop/src/shared/mcpApps.ts';
import { createEventHub } from './events.mjs';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { configureAppDataDir } from '../../desktop/src/main/userDataPath.ts';
import { commitVolatileAppSession } from '../../desktop/src/main/appSessionState.ts';
import { getCurrentDbClientSnapshot, setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { messageToCamel } from '../../desktop/src/main/localDb/mapper.ts';
import { startHostEventBridge } from '../../desktop/src/main/host-delegation.ts';
import { sessions, messages, taskTags, sessionTaskTags, orcaWorkers, orcaTeams, botSessionLinks, botProfiles } from '../../desktop/src/main/localDb/schema.ts';
import { readHostSessionList, readHostSession } from './session-reads.ts';
import { publishAgentEvent } from './agent/turn-executor.mjs';
import { createHostContextRecoveryRollover } from './agent/context-recovery-assembly.ts';
import { readMessagesList } from './agent/history.ts';
import * as broadcastTap from '../../desktop/src/main/device-link/broadcast-tap.ts';
import { PHASE1_UNFORWARDED_USAGE_CHANNELS } from './agent/usage-push-channels.ts';
import { redactEventForRenderer } from '../../desktop/src/main/maker-ipc/rendererEventRedaction.ts';
import { ServerApiError } from '../../desktop/src/main/serverApiClient.ts';

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
  for (const table of [sessions, messages, taskTags, sessionTaskTags, orcaWorkers, orcaTeams, botSessionLinks, botProfiles]) {
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table)).map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  }
  sqlite.exec(`CREATE TABLE im_bindings (target_session_id TEXT);
    CREATE TABLE shared_task_events (shared_task_id TEXT, session_id TEXT, revision INTEGER,
      kind TEXT, terminal INTEGER, snapshot TEXT, recorded_at INTEGER,
      PRIMARY KEY (shared_task_id, kind, revision));
    INSERT INTO sessions(id,title,source,status,working_dir,workspace_kind,created_at,updated_at)
    VALUES ('task','Shared task','desktop','active','/project','project',1,1)`);
  const db = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  // The in-memory fixture has no database filename for the production all-database scan.
  // Project the same current-database rows explicitly for the Worktree live-reference guard.
  db.readLocalWorktreeReferences = async () => {
    const rows = await db.drizzle.select({
      id: sessions.id, status: sessions.status, source: sessions.source,
      workingDir: sessions.workingDir, worktreePath: sessions.worktreePath,
    }).from(sessions);
    return rows.map(row => ({ ...row, currentDatabase: true }));
  };
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
  const projectHold = 'HOST_PROFILE_IN_USE_BY_DESKTOP: project profile held for this test';
  let holdBeforeProjectWrite = false;
  let created = 0, appCalls = 0, oauthCalls = 0, piPrewarms = 0;
  const oauthCancelled = [];
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
    profileHold: () => held,
    // One USD and one CNY quote: the device-link v1 projection keeps only USD (usageHandlers.ts).
    modelPricing: async () => ({ xd: {
      'usd-model': { providerId: 'xd', modelId: 'usd-model', currency: 'USD', source: 'gateway', approximate: false, inputPerMtok: 3, outputPerMtok: 15 },
      'cny-model': { providerId: 'xd', modelId: 'cny-model', currency: 'CNY', source: 'gateway', approximate: false, inputPerMtok: 20, outputPerMtok: 80 },
    } }),
    providers: async () => ({ providers: [] }),
    setSessionEffort: async () => ({}),
    setSessionFastMode: async () => ({}),
    setSessionThinkingEnabled: async () => ({}),
    setSessionPermissionMode: async () => ({}),
    setSessionPlanMode: async () => ({}),
    listSessions: options => readHostSessionList(db.drizzle, options),
    getSession: id => readHostSession(db.drizzle, id),
    messagesList: (id, limit) => readMessagesList(id, { limit }),
    setSessionModel: async (id, model) => {
      if (model === 'release-refusal') throw holdError(releaseFailure());

      modelChoices.push({ id, model, origin: readDeviceLinkModelSelectionOrigin() });
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
  // The real lifecycle, with createWorktree recording what the channel asks of it.
  const worktreeCreates = [];
  const worktreeLifecycle = { ...createHostWorktreeLifecycle(profile), createWorktree: async (request, options) => {
    worktreeCreates.push({ request, options });
    return { ok: true, meta: { sessionId: request.sessionId, path: path.join(profile, 'created-worktree') } };
  } };
  host = createHostDeviceLink({ profileDir: profile, worktree: worktreeLifecycle, version: 'test', getWsUrl: () => url,
    getToken: async () => 'synthetic-host', canRegister: () => true,
    invoke: service, subscribe: hub.subscribe,
    send: async (sessionId, message, createOpts, sendOpts) => ({ accepted: true, sessionId, message, createOpts, sendOpts }),
    assertRemoteInputControlBoundary: async () => ({ expectedClearBoundaryMs: null, expectedInputGeneration: 0 }),
    setExtraDirs: async (sessionId, dirs) => ({ dirs, rejectedCount: 0, changed: true }),
    publish: event => hub.publish(event),
    isBusyForProjectArchive: () => {
      if (holdBeforeProjectWrite) held = projectHold;
      return false;
    },
    onProjectTaskStatus: (sessionId, status) => hub.publish({ type: 'session_changed', sessionId, status, patch: { status } }),
    preparePiSkillRuntime: async (id, dir, route) => {
      piPrewarms++;
      assert.equal(id, 'task'); assert.equal(dir, '/project');
      if (route) assert.deepEqual(route, { model: 'pi-test', nextInputChars: 45_000 });
    },
    createRuntimeSession: async () => {
      created++;
      throw new Error('Not part of this transport test');
    },
    disableShareAvailability: async () => { throw new Error('This fixture owns no standby grants'); },
    profileHold: () => held,
    isSessionClaimed: async sessionId => {
      const rows = await db.drizzle.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      return rows.length > 0;
    },
    mcpApps: { invoke: async () => { appCalls++; return {}; }, releaseCaller: async () => {} },
    requestPluginOauth: async () => { oauthCalls++; return { ok: true }; },
    invalidatePluginOauth: peer => { oauthCancelled.push(peer ?? 'all'); },
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
  /*
   * Test value (engineering-conventions §3.2)
   * - Production entry and observable result: createHostDeviceLink over the real loopback relay;
   *   a mobile controller can create a project directory, list its parent, stat it, read and update
   *   draft/worktree defaults, invoke maker:send, change task settings and read Git safety state.
   * - Bug/rule basis: the Host returned NOT_FOUND for fs:list-dir and maker:get-new-maker-defaults
   *   despite the existing allowlist and desktop implementation; architecture-invariants §5 requires
   *   both launchers to be wired, including the draft step that follows adding a project.
   * - Existing coverage gap: this integration covered tasks and model controls, not the mobile
   *   project/draft workflow, direct send, session settings or the hold behavior of those writes.
   *   Real Git lifecycle behavior is covered by scripts/worktree-lifecycle.git-integration.mjs.
   * - Minimal failing input: mkdir-p followed by list-dir on the parent and maker:get-new-maker-defaults;
   *   an unpatched Host fails before any filesystem work or returns NOT_FOUND for the draft defaults.
   *   maker:send, draft/worktree writes and session settings use the same registry, and writes must
   *   also be rejected during a desktop profile hold.
   * - Tier: integration (real relay + temporary profile/filesystem); the whole file takes about
   *   10 seconds because it also reuses the existing multi-client/database/connection fixtures.
   */
  const createdDir = path.join(profile, 'mobile-created-project');
  const made = await clients[0].invoke('host', { channel: 'fs:mkdir-p', args: [{ path: createdDir }] });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.result.resolvedPath, createdDir);
  const listing = await clients[0].invoke('host', { channel: 'fs:list-dir', args: [{ path: profile }] });
  assert.equal(listing.ok, true, JSON.stringify(listing));
  assert.equal(listing.result.resolvedPath, profile);
  assert.ok(listing.result.entries.some(entry => entry.name === 'mobile-created-project' && entry.kind === 'dir'));
  const stat = await clients[0].invoke('host', { channel: 'fs:stat-path', args: [{ path: createdDir }] });
  assert.deepEqual(stat.result, { kind: 'dir', resolvedPath: createdDir });
  const refused = await clients[2].invoke('host', { channel: 'maker:set-model', args: ['task', 'release-refusal'] });
  assert.deepEqual(refused, { ok: false, error: { code: 'IPC_ERROR', message: '[PRECONDITION_FAILED] ' + releaseFailure().message } });
  // Regression (Greptile P1 on #12125): on the Host nothing else waits for the background checkout, and
  // the controller starts the task as soon as worktree:create answers, so the channel must ask the
  // manager to answer only after the whole tree is checked out. Before the fix the option was absent.
  const createdWorktree = await clients[0].invoke('host', { channel: 'worktree:create', args: [{
    sessionId: 'remote-worktree', baseRepo: profile, name: 'remote', sourceBranch: 'main' }] });
  assert.equal(createdWorktree.ok, true, JSON.stringify(createdWorktree));
  assert.equal(worktreeCreates.length, 1);
  assert.equal(worktreeCreates[0].options.awaitFullCheckout, true);
  const detected = await clients[0].invoke('host', { channel: 'worktree:detect-cwd', args: [{ cwd: profile }] });
  assert.equal(detected.ok, true, JSON.stringify(detected));
  assert.equal(detected.result.gitInstalled, true);
  assert.equal(detected.result.isGitRepo, false);
  assert.equal(detected.result.supportsRecoveryKeyDiscard, true);
  assert.equal(detected.result.supportsCheckout, false);
  // Adding a project continues into the remote draft: providers + defaults.
  const [providers, defaults] = await Promise.all([
    clients[0].invoke('host', { channel: 'maker:provider:list', args: [] }),
    clients[0].invoke('host', { channel: 'maker:get-new-maker-defaults', args: ['pi'] }),
  ]);
  assert.equal(providers.ok, true, JSON.stringify(providers));
  assert.equal(defaults.ok, true, JSON.stringify(defaults));
  assert.equal(typeof defaults.result, 'object');
  const sent = await clients[0].invoke('host', { channel: 'maker:send', args: ['task', 'hello', {}] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.result.accepted, true);
  assert.equal(sent.result.sessionId, 'task');
  assert.equal(sent.result.message, 'hello');
  assert.equal(sent.result.sendOpts.expectedClearBoundaryMs, null);
  assert.equal(sent.result.sendOpts.expectedInputGeneration, 0);
  const chosen = await clients[0].invoke('host', { channel: 'maker:apply-new-maker-draft-pref', args: [{
    agent: 'pi', providerId: 'inferx', modelId: 'kimi-k3.1-pro', active: true,
    markModelChoice: true, selectDraftAgent: true, effort: 'max', fast: true, thinking: false,
  }] });
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  assert.equal(chosen.result.model, 'kimi-k3.1-pro');
  assert.equal(chosen.result.providerId, 'inferx');
  assert.equal(chosen.result.effort, 'max');
  assert.equal(chosen.result.fastMode, true);
  const worktree = await clients[0].invoke('host', { channel: 'maker:apply-new-maker-worktree-pref', args: [{ worktreeEnabled: true }] });
  assert.equal(worktree.ok, true, JSON.stringify(worktree));
  assert.equal(worktree.result.pi.worktreeEnabled, true);
  const branch = await clients[0].invoke('host', { channel: 'maker:apply-new-maker-worktree-branch-pref', args: [{ baseRepo: '/project', sourceBranch: 'main' }] });
  assert.equal(branch.ok, true, JSON.stringify(branch));
  assert.equal(branch.result.sourceBranch, 'main');
  const branchRead = await clients[0].invoke('host', { channel: 'maker:get-new-maker-worktree-branch-pref', args: [{ baseRepo: '/project' }] });
  assert.equal(branchRead.ok, true, JSON.stringify(branchRead));
  assert.equal(branchRead.result.sourceBranch, 'main');
  const relativeBranch = await clients[0].invoke('host', { channel: 'maker:apply-new-maker-worktree-branch-pref', args: [{ baseRepo: 'relative/repo', sourceBranch: 'main' }] });
  assert.equal(relativeBranch.ok, false, JSON.stringify(relativeBranch));
  assert.match(relativeBranch.error?.message ?? '', /baseRepo must be absolute/);
  const emptyBranch = await clients[0].invoke('host', { channel: 'maker:apply-new-maker-worktree-branch-pref', args: [{ baseRepo: '/project', sourceBranch: '' }] });
  assert.equal(emptyBranch.ok, false, JSON.stringify(emptyBranch));
  assert.match(emptyBranch.error?.message ?? '', /sourceBranch is invalid/);
  const safety = await clients[0].invoke('host', { channel: 'maker:git-safety:get', args: [] });
  assert.equal(safety.ok, true, JSON.stringify(safety));
  assert.equal(safety.result.mode, 'existing-git');
  for (const [channel, args] of [
    ['maker:set-effort', ['task', 'low']],
    ['maker:set-permission-mode', ['task', 'auto']],
    ['maker:set-plan-mode', ['task', true]],
    ['maker:set-fast-mode', ['task', true]],
    ['maker:set-thinking-enabled', ['task', false]],
  ]) {
    const reply = await clients[0].invoke('host', { channel, args });
    assert.equal(reply.ok, true, `${channel}: ${JSON.stringify(reply)}`);
  }
  const extraDirs = await clients[0].invoke('host', { channel: 'maker:set-extra-dirs', args: ['task', ['/project/library']] });
  assert.equal(extraDirs.ok, true, JSON.stringify(extraDirs));
  assert.deepEqual(extraDirs.result, ['/project/library']);
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
  // Device Link integration: unlike the upstream round trip above, the Host can
  // share a profile with Desktop. §3.2: guard the read/write split and the race
  // after entry using the existing remote dispatcher and a byte-for-byte DB check.
  await t.test('project archive allows previews while held and refuses writes at entry and after preflight', async () => {
    const before = sqlite.serialize();
    const assertRefused = async action => {
      const reply = await projectArchive({ action, operation: 'apply', sessionId: 'task' });
      assert.equal(reply.ok, false, JSON.stringify(reply));
      assert.match(JSON.stringify(reply.error), /PRECONDITION_FAILED.*HOST_PROFILE_IN_USE_BY_DESKTOP/);
      assert.deepEqual(sqlite.serialize(), before);
    };
    try {
      held = projectHold;
      const whileHeld = await projectArchive({ action: 'archive', operation: 'preview' });
      assert.equal(whileHeld.ok, true, JSON.stringify(whileHeld));
      assert.deepEqual(whileHeld.result, preview.result);
      await assertRefused('archive');
      await assertRefused('unarchive');
      held = null;
      // Discover occupation during the shared membership check inside the task lock.
      holdBeforeProjectWrite = true;
      await assertRefused('archive');
    } finally {
      holdBeforeProjectWrite = false;
      held = null;
    }
  });
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
  assert.deepEqual(modelChoices, [{ id: 'task', model: 'small', origin: 'owner' }]);

  const prepared = await clients[2].invoke('host', { channel: 'maker:session:prewarm',
    args: ['task', { purpose: 'pi-skill-dispatch', workingDir: '/project' }] });
  assert.deepEqual(prepared.result, { accepted: true, piRuntimePrepared: true }, JSON.stringify(prepared));
  const switched = await clients[2].invoke('host', { channel: 'maker:session:prewarm',
    args: ['task', { purpose: 'pi-skill-dispatch', workingDir: '/project', model: 'pi-test', pendingPiRoute: { nextInputChars: 45_000 } }] });
  assert.deepEqual(switched.result, { accepted: true, piRuntimePrepared: true, pendingRouteApplied: true });
  const unsupported = await clients[2].invoke('host', { channel: 'maker:session:prewarm',
    args: ['task', { purpose: 'pi-skill-dispatch', workingDir: '/project', model: 'pi-test', pendingPiRoute: { agentDeviceId: 'other' } }] });
  assert.equal(unsupported.ok, false);

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
  // Phase 1 (release table row 13, 3d): the usage pushes the desktop's usage cores send on the tap are not
  // forwarded through the Host's device-link wiring (agent/usage-push-channels.ts); another push on the same
  // tap still is. A usage frame would arrive before the probe that follows it.
  const tapScope = broadcastTap.captureDataOwnerBroadcastScope();
  for (const channel of PHASE1_UNFORWARDED_USAGE_CHANNELS) broadcastTap.tapWindowBroadcast(channel, { sessionId: 'task' }, tapScope.ownerStamp);
  broadcastTap.tapWindowBroadcast('local-db:session:error-persisted', { sessionId: 'task', persistId: 'tap-probe' }, tapScope.ownerStamp);
  await waitFor(() => received.every(frames => frames.some(frame => JSON.stringify(frame).includes('tap-probe'))));
  for (const frames of received) {
    assert.deepEqual(frames.filter(frame => String(frame.payload?.channel ?? '').startsWith('usage:')).map(frame => frame.payload.channel), []);
  }
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
  // Coexistence plan A: while a desktop uses the profile, a phone's send, a new task and a plugin
  // page's call are refused with the typed reason, and none reaches its handler; reads still answer.
  held = 'HOST_PROFILE_IN_USE_BY_DESKTOP: held for this test';
  for (const [channel, args] of [['maker:input:enqueue', ['task', { clientId: 'held', text: 'refused' }]],
    ['maker:send', ['task', 'held']], ['maker:set-extra-dirs', ['task', []]], ['maker:create-session', [{}]], ['fs:mkdir-p', [{ path: path.join(profile, 'held-project') }]], ['maker:session:prewarm', ['task', { purpose: 'pi-skill-dispatch', workingDir: '/project' }]],
    [MCP_APPS_INVOKE, ['task', {}]], [PLUGIN_OAUTH_CHANNEL, [{}]]]) {
    const reply = await clients[0].invoke('host', { channel, args });
    assert.equal(reply.ok, false, `${channel}: ${JSON.stringify(reply)}`);
    // The dispatcher answers every plugin OAuth failure with its own fixed text (dispatch.ts:5148).
    if (channel !== PLUGIN_OAUTH_CHANNEL)
      assert.ok(JSON.stringify(reply.error).includes('HOST_PROFILE_IN_USE_BY_DESKTOP'), `${channel}: ${JSON.stringify(reply)}`);
  }
  assert.deepEqual([writes, created, appCalls, oauthCalls, piPrewarms], [2, 0, 0, 0, 2], 'nothing reached a handler while held');
  assert.equal((await clients[0].invoke('host', { channel: 'local-db:sessions:get', args: ['task'] })).ok, true, 'reads still answer');
  // A controller closing its link still cancels its pending plugin authorizations while held: that
  // cancel only drops in-memory requests (plugin-oauth/runtime.ts invalidatePluginOauth), no stored sign-in.
  clients[2].closeLink('host', 'user');
  await waitFor(() => oauthCancelled.includes('desktop'));
  await clients[2].openLink('host', { controllerName: 'desktop', protocolVersion: PROTOCOL_VERSION, appVersion: 'test' });
  held = null;
  // Released, a remote plugin authorization reaches the plugin OAuth entry again.
  assert.equal((await clients[0].invoke('host', { channel: PLUGIN_OAUTH_CHANNEL, args: [{}] })).ok, true);
  assert.equal(oauthCalls, 1);
  // L343 / integration: a metadata refresh reaches the attached window through
  // SSE. A detail subscriber gets the original and next rows without the
  // refresh, which older Mobile code can mistake for a delayed input.
  await t.test('keeps a context recovery notice off Device Link and in attached windows and history', async t => {
    const [ios, android] = clients;
    const subscribe = (client, topics) => client.invoke('host', {
      channel: 'device-link:subscribe', args: [{ topics }],
    });
    assert.equal((await subscribe(ios, ['session:task'])).ok, true);
    assert.equal((await subscribe(android, ['session:other-task'])).ok, true);
    const events = [[], []];
    const readers = [ios, android].map((client, index) => client.onFrame(env => {
      if (env.kind === 'push' && env.src === 'host') events[index].push(env.payload);
    }));
    t.after(() => readers.forEach(off => off()));

    const attached = [];
    let connected = false;
    const server = createHostServer({ instanceId: 'fixture', token: 'synthetic-stream', events: hub, service });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const stop = startHostEventBridge({
      baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'synthetic-stream',
      onConnectionState: state => { connected = state.status === 'connected'; },
      broadcast() {},
      onMessageCreated: event => attached.push(event),
    });
    t.after(async () => {
      stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    await waitFor(() => connected);

    sqlite.prepare(`INSERT INTO messages
      (id, session_id, client_id, role, content, agent_meta, created_at)
        VALUES ('fixed-row', 'task', 'original', 'user', '"继续"', '{}', ?)`)
      .run(Date.parse('2026-01-01T00:00:01.000Z'));
    const [stored] = await db.drizzle.select().from(messages).where(eq(messages.id, 'fixed-row'));
    const original = messageToCamel(stored);
    const publish = (row) => hub.publish({ type: 'message_created', sessionId: row.sessionId, messageId: row.id, message: row });
    publish(original);
    const writes = [];
    const logger = { info() {}, warn() {} };
    const recovery = createHostContextRecoveryRollover({ publish: hub.publish, log: logger }, {
      assertCurrent: () => assert.equal(getCurrentDbClientSnapshot()?.client, db),
      drainHistories: () => assert.fail('the pending queue owns recovery'),
      behindDurableWrites: (_id, _label, write) => {
        const pending = Promise.resolve().then(write);
        writes.push(pending);
        return pending;
      },
      coordinator: {
        hasPendingQueuedWork: () => true,
        skippedOversizedInputClientId: (_id, claim) => claim.inputClientId,
        clearError() {},
      },
    });
    const claim = { instanceId: 'fixture', generation: 3, inputClientId: 'original' };
    assert.equal(recovery.claim('task', claim), 'claimed');
    assert.equal(await recovery.tryRecover('task', { reason: 'context-overflow' }, claim), true);
    await Promise.all(writes);

    // Later rows on both subscribed topics are barriers, including for the
    // mobile diagnostic replay of these exact frames.
    const next = { ...original, id: 'next-row', clientId: 'next', content: 'the actual question',
      createdAt: '2026-01-01T00:00:03.000Z' };
    publish(next);
    publish({ ...original, id: 'other-row', clientId: 'other-input', sessionId: 'other-task' });
    await waitFor(() => events[0].some(event => event.payload?.message?.id === next.id)
      && events[1].some(event => event.payload?.sessionId === 'other-task')
      && attached.some(event => event.messageId === next.id));
    const forSessions = list => list.filter(event => ['task', 'other-task'].includes(event.payload?.sessionId));
    const mobileFrames = forSessions(events[0]);
    t.diagnostic('L343 Device Link rows ' + JSON.stringify(mobileFrames));
    const attachedRows = attached.filter(event => event.sessionId === 'task');
    const refreshed = { ...original, agentMeta: { inputNotice: 'oversized-input-skipped' } };
    assert.deepEqual(attachedRows.map(({ messageId, message }) => [messageId, message]),
      [[original.id, original], [original.id, refreshed], [next.id, next]]);
    assert.deepEqual(Object.keys(attachedRows[1]).sort(), ['message', 'messageId', 'seq', 'sessionId', 'type']);
    const history = await ios.invoke('host', { channel: 'local-db:messages:list', args: ['task'] });
    assert.equal(history.ok, true);
    assert.deepEqual(history.result.map(({ id, clientId, agentMeta }) => [id, clientId, agentMeta]),
      [[original.id, original.clientId, refreshed.agentMeta]]);
    assert.deepEqual(mobileFrames.map(({ channel, payload }) => [channel, payload.message]), [
      ['local-db:messages:created', original], ['local-db:messages:created', next],
    ]);
    assert.deepEqual(forSessions(events[1]).map(({ channel, payload }) => [channel, payload.sessionId]), [
      ['local-db:messages:created', 'other-task'],
    ]);
  });
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
  host = createHostDeviceLink({ profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', getWsUrl: () => url,
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

/*
 * Test value (engineering-conventions §3.2)
 * - Production entry: createHostDeviceLink checks, before it creates the shared inbound dispatch, that
 *   every port it passes has a class in HOST_DISPATCH_PORTS_WHILE_HELD and that `unbound` ports are
 *   the ones left undefined (the tests above construct it through that path; a mismatch throws there).
 * - Rule: coexistence plan A (reviewer, 2026-11-17). While a desktop uses this profile each port the
 *   Host hands the dispatcher is read-only, behind the service gate, refused at its entry, or unbound;
 *   the list is pinned here so a port is only added, or moved between classes, by changing this table.
 * - Coverage gap: the service gate test covers /api/* paths only; the dispatcher's own ports
 *   (plugin OAuth, the invoke registry) were not listed anywhere.
 * - Minimal failing input: an extra port in the Host's dispatch ports without a class, or a class
 *   changed in device-link.ts and not here.
 * - Tier: guard (the table compared with the production list; no IO).
 */
const PINNED_DISPATCH_PORTS = {
  read: ['sameAccountCapabilities', 'TASK_TAG_CHANNEL', 'app', 'readDeviceLinkSettings', 'noteControllerAccessAllowed',
    'noteControllerAccessDenied', 'syncRemoteControlAccessGeneration', 'invalidatePluginOauth',
    'assertRemoteBotInvocationAllowed', 'projectRemoteSessionResult', 'projectRemoteBotPush', 'hasRemoteBotSessionLookup',
    'setRemoteBotSessionLookup', 'captureSharedTaskPeer', 'captureSharedTaskPush', 'assertSharedTaskInvoke',
    'sharedTaskMetadataTopic', 'sharedTaskAccessFailure', 'MAX_SHARED_TASK_TOPICS', 'refreshSharedTaskPeer',
    'releaseSharedTaskWatchesOnWorkdirChange', 'admitSharedTaskFsWatchTopics', 'setBroadcastTapListener', 'broadcastTap',
    'RECOVERY_CHECKPOINT_MARKER', 'sanitizeBotAuthorizationMetaForRemote', 'projectInteractionDismissedForRemote',
    'projectInteractionRequestForRemote', 'remoteWorkingDirRejectionToIpcError'],
  'service-gate': ['executeTaskTags', 'dispatchLocalInvoke'],
  'refused-at-entry': ['requestPluginOauth'],
  unbound: ['readUsageWidgetSnapshot', 'configureStandbyGuestCleanup', 'prepareShareAvailability',
    'readKimiCodingAccountUsage', 'readOpenCodeGoAccountUsage', 'requestFilePeer', 'stopFilePeers', 'requestTaskMigration',
    'delegatedProviderShareGuestAccess', 'locallyProvenProviderShareDelegation',
    'delegatedProviderShareLeases', 'invalidateProviderShareDelegation',
    'remoteDesktop', 'requestRemoteDesktop', 'remoteCredentialHost', 'fetchLocalMediaToOss', 'transcribeRemoteVoiceInput',
    'readTelegramRemoteStatus', 'setTelegramRemoteOnline', 'adviseAndRecordVoiceInputDictionaryLearning',
    'buildMobileDictionarySnapshot'],
};

test('every port the Host passes the inbound dispatch has the class pinned here', () => {
  const pinned = Object.fromEntries(Object.entries(PINNED_DISPATCH_PORTS).flatMap(([kind, names]) => names.map(name => [name, kind])));
  const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(sorted(HOST_DISPATCH_PORTS_WHILE_HELD), sorted(pinned));
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
    profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', getWsUrl: () => 'ws://127.0.0.1:9',
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

// §3.2 integration: the authenticated CLI control handler bypasses the service
// gate, and its formerly pre-queue-only owner check missed a queued account change.
test('Agent-Net control refuses profile hold and rechecks the owner inside the settings lock', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-net-setting-'));
  configureHostOwner({ userDataDir: profile, ownerId: 'first-owner' });
  const file = path.join(profile, 'device-link-settings.json');
  const initial = '{"agentNetEnabled":false,"remoteControlEnabled":false}';
  fs.writeFileSync(file, initial);
  const holdMessage = 'HOST_PROFILE_IN_USE_BY_DESKTOP: The desktop window is using this profile.';
  let held = holdMessage;
  let canRegister = false;
  const host = createHostDeviceLink({
    profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', getWsUrl: () => 'ws://127.0.0.1:9',
    getToken: async () => null, canRegister: () => canRegister, profileHold: () => held,
    invoke: async () => ({ status: 200, body: {} }), subscribe: () => () => {},
    createRuntimeSession: async () => ({}), disableShareAvailability: async () => {},
    agentNet: { base: () => null, subject: () => null, deviceId: () => null },
  });
  const server = createHostServer({ instanceId: 'fixture', token: 'fake-token',
    remoteControl: action => action === 'enable' ? host.setEnabled(true)
      : host.setAgentNetEnabled(action === 'agent-net-on') });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await host.stop();
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = action => fetch(`http://127.0.0.1:${server.address().port}/control/remote`, {
    method: 'POST',
    headers: { authorization: 'Bearer fake-token', 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: 'fixture', action }),
  });
  // Turning remote control on writes the same settings file through the same bypass (`/control/remote`);
  // before this it skipped the hold. Minimal failure: drop refuseWhileHeld() from setEnabled.
  await t.test('CLI commands that turn something on, or Agent-Net off, refuse a held profile', async () => {
    canRegister = true;
    for (const action of ['enable', 'agent-net-on', 'agent-net-off']) {
      const response = await control(action);
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'PRECONDITION_FAILED', message: '[PRECONDITION_FAILED] ' + holdMessage });
      assert.equal(fs.readFileSync(file, 'utf8'), initial);
    }
  });
  held = null;
  await t.test('turning remote control on works again once the hold clears', async () => {
    const response = await control('enable');
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).remoteControlEnabled, true);
  });
  canRegister = false;
  await t.test('queued switch does not write once the owner changes', async t => {
    const before = fs.readFileSync(file, 'utf8');
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', (target, ...args) => {
      const fd = open(target, ...args);
      if (target === file + '.lock' && args[0] === 'wx')
        configureHostOwner({ userDataDir: profile, ownerId: 'next-owner' });
      return fd;
    });
    await assert.rejects(host.setAgentNetEnabled(false), /Host account changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(file + '.lock'), false);
  });
});

// Test value (engineering-conventions §3.2)
// - Production entry and observable result: `cindy-host remote rejoin` reaches createHostDeviceLink `rejoin` through the
//   authenticated `/control/remote` route; the command line prints the `rejoin` result and its hint, and fails unless rejoined.
// - Rule: 2026-11-23, a device removed in Cindy comes back by asking on that device (deviceRejoin.ts; protocol record
//   agent-net-device-removal.md). The control channel turns thrown errors into a bare status, so every outcome is a result.
// - Coverage gap: deviceRejoin.test.ts covers the order with injected ports, not the Host assembly or its hints.
// - Minimal failing input: an older service answering 404, a profile held by the desktop, a service that supports rejoin.
// - Tier: unit with an in-process loopback control server; the Device Link client stays stopped (remote control off).
test('cindy-host remote rejoin reports why it could not rejoin, and asks the official service only when it may', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-rejoin-'));
  configureHostOwner({ userDataDir: profile, ownerId: 'rejoin-owner' });
  fs.writeFileSync(path.join(profile, 'device-link-settings.json'), '{"agentNetEnabled":false,"remoteControlEnabled":false}');
  let held = 'HOST_PROFILE_IN_USE_BY_DESKTOP: The desktop window is using this profile.';
  const requests = [];
  let answer = async () => ({ deviceId: 'host', rejoined: true });
  const host = createHostDeviceLink({
    profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', getWsUrl: () => 'ws://127.0.0.1:9',
    getToken: async () => null, canRegister: () => true, profileHold: () => held,
    invoke: async () => ({ status: 200, body: {} }), subscribe: () => () => {},
    createRuntimeSession: async () => ({}), disableShareAvailability: async () => {},
    agentNet: { base: () => null, subject: () => null, deviceId: () => null },
    officialDeviceLinkFetch: async (route, opts) => { requests.push([route, opts]); return answer(); },
  });
  const server = createHostServer({ instanceId: 'fixture', token: 'fake-token', remoteControl: () => host.rejoin() });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await host.stop();
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rejoin = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/control/remote`, { method: 'POST',
      headers: { authorization: 'Bearer fake-token', 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: 'fixture', action: 'rejoin' }) });
    assert.equal(response.status, 200);
    return (await response.json()).rejoin;
  };
  // The desktop window owns this profile: nothing is asked of the service.
  assert.deepEqual(await rejoin(), { result: 'failed', hint: `Could not rejoin: [PRECONDITION_FAILED] ${held}` });
  assert.equal(requests.length, 0);
  held = null;
  // An older service without the endpoint: signing in again is still the way back there.
  answer = async () => { throw new ServerApiError('NOT_FOUND', 404, 'Not Found'); };
  assert.deepEqual(await rejoin(), { result: 'unsupported',
    hint: 'The Cindy service does not support rejoining yet. Sign in again with cindy-host login.' });
  answer = async () => ({ deviceId: 'host', rejoined: true });
  assert.deepEqual(await rejoin(), { result: 'rejoined', agentNet: 'skipped' });
  assert.deepEqual(requests.map(([route, opts]) => [route, opts.method, opts.body]),
    [['/api/device-link/rejoin', 'POST', {}], ['/api/device-link/rejoin', 'POST', {}]]);
});
