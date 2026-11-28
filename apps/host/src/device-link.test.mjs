import { holdError, releaseFailure } from './agent/profile-hold.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { register as registerTsRequire } from 'tsx/cjs/api';
import WebSocket, { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { SSH_ACCESS_CHANNEL } from '@cindy/device-link';
import { DeviceLinkClient, DeviceLinkError, PROTOCOL_VERSION, FILE_PEER_CHANNEL, REMOTE_AGENT_CHANNEL, REMOTE_DESKTOP_CHANNEL,
  DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1, DL_HISTORY_MESSAGES_CHANNEL, DL_SESSION_HANDOFF_CHANNEL, ORCA_REMOTE_WORKER_MODELS_CHANNEL,
  CONTROLLER_CAPABILITY_EXACT_MESSAGE_NOT_FOUND_V1,
  ORCA_REMOTE_WORKER_CAPS_CHANNEL, MACHINE_STATUS_CHANNEL, parseMachineStatus,
  PROVIDER_SHARE_RELAY_CAPABILITY, isProviderSharePeer, providerShareGuestPeer, providerShareHostPeer, PLUGIN_OAUTH_CHANNEL, SESSION_ACTIVITY_CHANNEL, TASK_ACTIVITY_SNAPSHOT } from '@cindy/device-link';
import { AgentNetWorkerSocket } from '@cindy/agent-net';
import { createPrivateNetwork, generateIdentity, issueCertificate } from '@cindy/agent-net-relay';
import { readDeviceLinkInvokeSourceDevice, readDeviceLinkModelSelectionOrigin } from '../../desktop/src/main/device-link/invoke-context.ts';
import { getOfficialAgentNetPeerBase, parseAgentNetUdpPort } from '../../desktop/src/main/device-link/agentNetStunDiscovery.ts';
import { createHostDeviceLink, HOST_DISPATCH_PORTS_WHILE_HELD } from './device-link.ts';
import { createHostSessionHandoff } from './agent/session-handoff.ts';
import { createInputQueue } from './agent/input-queue.mjs';
import { createIpcError } from '../../desktop/src/shared/ipc-errors.ts';
import { bindHostUiText } from './ui-text.ts';
import { configureUiText } from '../../desktop/src/main/uiText.ts';
import { setSessionOpeningModelAdmission } from '../../desktop/src/main/localDb/sessionOpening.ts';
import { readChatHistoryMessages } from '../../desktop/src/main/mcp-integrations/remoteChatHistory.ts';
import { createRemoteSessionHandoff } from '../../desktop/src/main/mcp-integrations/sessionHandoffRemote.ts';
import { validateRemoteTaskActionReceipt } from '../../desktop/src/main/maker-ipc/remoteTaskActionReceipt.ts';
import { createHostWorktreeLifecycle } from './agent/worktree-lifecycle.ts';
import { createHostService } from './service.mjs';
import { createHostServer } from './server.mjs';
import { MCP_APPS_INVOKE } from '../../desktop/src/shared/mcpApps.ts';
import { createEventHub } from './events.mjs';
import { configureHostOwner } from './agent/claude-auth.mjs';
import { configureAppDataDir } from '../../desktop/src/main/userDataPath.ts';
import { beginAppSessionBoundary, commitVolatileAppSession } from '../../desktop/src/main/appSessionState.ts';
import { getControllerPlatform } from '../../desktop/src/main/device-link/controllerPlatform.ts';
import { getCurrentDbClientSnapshot, setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { messageToCamel } from '../../desktop/src/main/localDb/mapper.ts';
import { startHostEventBridge } from '../../desktop/src/main/host-delegation.ts';
import { sessions, messages, taskTags, sessionTaskTags, orcaWorkers, orcaTeams, botSessionLinks, botProfiles, recentWorkdirs, projectAliases } from '../../desktop/src/main/localDb/schema.ts';
import { readHostSessionList, readHostSession } from './session-reads.ts';
import { publishAgentEvent } from './agent/turn-executor.mjs';
import { createHostContextRecoveryRollover } from './agent/context-recovery-assembly.ts';
import { createHostHistoryReader, dismissHostErrorMessage, readHostHistoryView, readHostWorkDetails, readMessagesAroundClientId, readMessagesList } from './agent/history.ts';
import { setHistoryWorkPageReader } from '../../desktop/src/main/device-link/historyViewPush.ts';
import { ackSessionTurnEndedDurable, markSessionTurnEnded, drainSessionActiveTurnWrites, setOnSessionTurnEndedPersisted } from '../../desktop/src/main/localDb/sessionActiveTurn.ts';
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

function loadMobileOutbox() {
  // Only the test imports Mobile's state machine. Resolve its Metro aliases
  // without changing the resolver for the Host and its other tests.
  const previous = process.env.TSX_TSCONFIG_PATH;
  process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../mobile/tsconfig.json', import.meta.url));
  try {
    const loader = registerTsRequire({ namespace: 'host-mob-outbox-test' });
    try {
      return {
        ...loader.require('../../mobile/src/session/durableOutbox.ts', import.meta.url),
        ...loader.require('../../mobile/src/session/durableOutboxDelivery.ts', import.meta.url),
        ...loader.require('../../mobile/src/session/outboxHistoryConfirmation.ts', import.meta.url),
        ...loader.require('../../mobile/src/device-link/historyViewCapability.ts', import.meta.url),
      };
    } finally { loader.unregister(); }
  } finally {
    if (previous === undefined) delete process.env.TSX_TSCONFIG_PATH;
    else process.env.TSX_TSCONFIG_PATH = previous;
  }
}

// Real Node WebSockets + shared production client/dispatcher + SQLite. The local
// relay authenticates synthetic tokens and stamps src; it is NOT official-relay
// or physical iOS/Android acceptance, and does not make a model call.
test('headless dispatcher serves multiple clients and enforces owner and per-device revocation', async t => {
  const previousDeviceName = process.env.CINDY_HOST_DEVICE_NAME;
  const deviceName = 'Fixture cloud computer';
  process.env.CINDY_HOST_DEVICE_NAME = `  ${deviceName}  `;
  t.after(() => {
    if (previousDeviceName === undefined) delete process.env.CINDY_HOST_DEVICE_NAME;
    else process.env.CINDY_HOST_DEVICE_NAME = previousDeviceName;
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-remote-'));
  configureAppDataDir(profile);
  configureHostOwner({ userDataDir: profile, ownerId: 'test-headless-owner' });
  const sqlite = new Database(':memory:');
  for (const table of [sessions, messages, taskTags, sessionTaskTags, orcaWorkers, orcaTeams, botSessionLinks, botProfiles, recentWorkdirs, projectAliases]) {
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
  let hostHello;
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
    const match = /^Bearer synthetic-(host|legacy-host|ios|android|desktop)$/.exec(request.headers.authorization ?? '');
    if (!match) { socket.close(1008); return; }
    const id = match[1]; sockets.set(id, socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === 'hello') {
        if (id === 'host') hostHello = frame.payload;
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
  const closedSessions = [];
  const metaPatches = [];
  const titleCalls = [];
  const insertMessage = sqlite.prepare(
    'INSERT INTO messages (id, session_id, client_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const outboxHistory = createHostHistoryReader({ running: () => false, live: () => [] });
  const outboxPending = [];
  const service = createHostService({
    profileHold: () => held,
    historyView: (id, before, opts) => readHostHistoryView(outboxHistory, id, before, opts),
    // One USD and one CNY quote: the device-link v1 projection keeps only USD (usageHandlers.ts).
    modelPricing: async () => ({ xd: {
      'usd-model': { providerId: 'xd', modelId: 'usd-model', currency: 'USD', source: 'gateway', approximate: false, inputPerMtok: 3, outputPerMtok: 15 },
      'cny-model': { providerId: 'xd', modelId: 'cny-model', currency: 'CNY', source: 'gateway', approximate: false, inputPerMtok: 20, outputPerMtok: 80 },
    } }),
    providers: async () => ({ providers: [] }),
    executeTaskTags: async request => {
      assert.deepEqual(request, { action: 'list' });
      return { tags: [], sessions: [] };
    },
    setSessionEffort: async () => ({}),
    setSessionFastMode: async () => ({}),
    setSessionThinkingEnabled: async () => ({}),
    setSessionPermissionMode: async () => ({}),
    setSessionPlanMode: async () => ({}),
    listSessions: options => readHostSessionList(db.drizzle, options),
    getSession: id => readHostSession(db.drizzle, id),
    updateSession: async (id, patch, options) => { metaPatches.push({ id, patch, options }); return { id, ...patch }; },
    messagesList: (id, limit) => readMessagesList(id, { limit }),
    messagesAroundClientId: readMessagesAroundClientId,
    setSessionModel: async (id, model) => {
      if (model === 'release-refusal') throw holdError(releaseFailure());

      modelChoices.push({ id, model, origin: readDeviceLinkModelSelectionOrigin() });
      return { deferred: true };
    },
    input: {
      projection: async sessionId => ({
        sessionId, pendingQueue: sessionId === 'outbox-task' ? outboxPending : [],
        turnInProgress: false, clearBoundaryMs: null,
      }),
      enqueue: async (sessionId, item) => {
      writes++; source = readDeviceLinkInvokeSourceDevice();
      await hold;
        if (sessionId === 'outbox-task') {
          insertMessage.run(randomUUID(), sessionId, item.clientId, 'user', item.text, 200);
        }
      const projection = { sessionId, pendingQueue: [item], turnInProgress: false };
      hub.publish({ type: 'input_projection', sessionId, projection });
      return projection;
    } },
  });
  // The real lifecycle, with createWorktree recording what the channel asks of it.
  const worktreeCreates = [];
  const worktreeLifecycle = { ...createHostWorktreeLifecycle(profile), createWorktree: async (request, options) => {
    worktreeCreates.push({ request, options });
    return { ok: true, meta: { sessionId: request.sessionId, path: path.join(profile, 'created-worktree'),
      sourceBranch: request.sourceBranch } };
  } };
  const handoffQueue = [];
  let enqueueHandoff = async (id, item, handoff) => {
    const target = await handoff.validateTarget();
    if (!target.ok) return target;
    await handoff.taskActionDeliveryGuard();
    handoffQueue.push({ id, item, handoff });
    return target;
  };
  let holdAfterHandoffCreation;
  const handoffProviders = [{
    id: 'fixture-provider', name: 'Fixture provider', connected: true, source: 'user', agents: ['claude-code'],
    routing: { 'claude-code': { authStrategy: 'api-key' } },
    models: { 'claude-code': [{ id: 'fixture-model', name: 'Fixture model', efforts: [] }] },
  }, {
    id: 'selected-provider', name: 'Selected provider', connected: true, source: 'user', agents: ['claude-code'],
    routing: { 'claude-code': { authStrategy: 'api-key' } },
    models: { 'claude-code': [{ id: 'fixture-model', name: 'Fixture model', efforts: [] }] },
  }];
  // Model-service IO is synthetic. The Host adapter still performs repository
  // model checks, real session opening, SQLite writes and queue admission.
  setSessionOpeningModelAdmission(async body => body);
  host = createHostDeviceLink({ profileDir: profile, worktree: worktreeLifecycle, version: 'test', sessionInTurn: () => false, getWsUrl: () => url,
    getToken: async () => 'synthetic-host', canRegister: () => true,
    sessionHandoff: isSelfDeviceId => createHostSessionHandoff({
      input: {
        profileHoldReason: () => held, profileHoldGeneration: () => 0,
        enqueue: (...args) => enqueueHandoff(...args),
      },
      worktree: worktreeLifecycle, isSelfDeviceId, readProviders: async () => handoffProviders,
      agents: () => ['claude-code'], hasCindyAiApiKey: () => false,
      assertProviderExecutionSupported() {},
      broadcastCreated: sessionId => {
        if (sessionId === holdAfterHandoffCreation) held = projectHold;
        hub.publish({ type: 'session_changed', action: 'create', sessionId });
      },
    }),
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
    closeRuntimeSession: async id => { closedSessions.push(id); },
    disableShareAvailability: async () => { throw new Error('This fixture owns no standby grants'); },
    profileHold: () => held,
    isSessionClaimed: async sessionId => {
      const rows = await db.drizzle.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      return rows.length > 0;
    },
    mcpApps: { invoke: async () => { appCalls++; return {}; }, releaseCaller: async () => {} },
    autoTitle: {
      generateTitle: async req => { titleCalls.push(['generate', req]); return { title: 'Gen title' }; },
      regenerateTitle: async req => { titleCalls.push(['regenerate', req]); return { title: 'Regen title' }; },
    },
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
    await client.openLink('host', { controllerName: id, protocolVersion: PROTOCOL_VERSION, appVersion: 'test',
      ...(id === 'ios' ? { capabilities: [CONTROLLER_CAPABILITY_EXACT_MESSAGE_NOT_FOUND_V1] } : {}) });
    // The first invocation uses one of the last registered ordinary handlers (no startup delay).
    // Assigning old-peer "unsupported" here would survive the end of startup in a controller cache.
    const first = await client.invoke('host', { channel: 'maker:session:prewarm', args: ['task', {}] });
    assert.deepEqual(first, { ok: true, result: { accepted: false } });
    const reply = await client.invoke('host', { channel: 'local-db:sessions:list', args: [] });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.result.map(row => row.id), ['task']);
    return client;
  }
  for (const id of ['ios', 'android', 'desktop']) clients.push(await connect(id));
  // Task tags have a dedicated dispatch port, separate from the ordinary IPC registry.
  const tags = await clients[2].invoke('host', { channel: 'local-db:task-tags:execute', args: [{ action: 'list' }] });
  assert.deepEqual(tags, { ok: true, result: { tags: [], sessions: [] } });
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
  const inTurn = await clients[0].invoke('host', { channel: 'maker:session-in-turn', args: ['task'] });
  assert.equal(inTurn.ok, true, JSON.stringify(inTurn));
  assert.equal(inTurn.result, false);
  const projection = await clients[0].invoke('host', { channel: 'maker:input:get-projection', args: ['task'] });
  assert.equal(projection.ok, true, JSON.stringify(projection));
  assert.equal(projection.result.sessionId, 'task');
  assert.equal(projection.result.turnInProgress, false);
  assert.equal(projection.result.inputDeliveryVersion, undefined);
  const removalPreview = await clients[0].invoke('host', { channel: 'worktree:removal-preview', args: ['task'] });
  assert.deepEqual(removalPreview, { ok: true, result: { hasWorktree: false, dirty: false } });
  const closed = await clients[0].invoke('host', { channel: 'maker:close-session', args: ['task'] });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.deepEqual(closedSessions, ['task']);
  const archived = await clients[0].invoke('host', { channel: 'local-db:sessions:patch-meta', args: ['task', { status: 'archived', pinnedAt: null }] });
  assert.deepEqual(archived, { ok: true, result: { id: 'task', status: 'archived', pinnedAt: null } });
  assert.deepEqual(metaPatches.at(-1), { id: 'task', patch: { status: 'archived', pinnedAt: null }, options: undefined });
  const deleted = await clients[0].invoke('host', { channel: 'local-db:sessions:patch-meta', args: ['task', { status: 'deleted', deleteTarget: 'task' }] });
  assert.deepEqual(deleted, { ok: true, result: { id: 'task', status: 'deleted' } });
  assert.deepEqual(metaPatches.at(-1), { id: 'task', patch: { status: 'deleted' }, options: { deleteTarget: 'task' } });
  const badField = await clients[0].invoke('host', { channel: 'local-db:sessions:patch-meta', args: ['task', { workingDir: '/tmp' }] });
  assert.equal(badField.ok, false);
  const badDiscard = await clients[0].invoke('host', { channel: 'local-db:sessions:patch-meta', args: ['task', { status: 'archived', discardWorktreeChanges: true }] });
  assert.equal(badDiscard.ok, false);
  const genTitle = await clients[0].invoke('host', { channel: 'maker:generate-title', args: [{ message: 'hello', agentKind: 'claude-code', sessionId: 'task' }] });
  assert.deepEqual(genTitle, { ok: true, result: { title: 'Gen title' } });
  const regenTitle = await clients[0].invoke('host', { channel: 'maker:regenerate-title', args: [{ sessionId: 'task' }] });
  assert.deepEqual(regenTitle, { ok: true, result: { title: 'Regen title' } });
  assert.deepEqual(titleCalls, [['generate', { message: 'hello', agentKind: 'claude-code', sessionId: 'task' }], ['regenerate', { sessionId: 'task' }]]);
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
  /*
   * Test value (engineering-conventions §3.2)
   * Production entry: desktop createRemoteSessionHandoff → real Device Link → Node Host
   * registry and session opener. Earlier relay tests only covered direct controller
   * sends and returned CHANNEL_NOT_ALLOWED for a desktop capability probe.
   * Contract: cross-computer-task-action-receipt.md. Minimal input is that probe;
   * create, jump, revoked receipt and catalogs each have a different observable result.
   * Tier: integration, using the existing loopback relay and synthetic owner DB.
   */
  await t.test('desktop handoff negotiates catalogs, creates and queues with a live reverse receipt', async t => {
    const desktop = clients[2];
    const releases = [];
    const denyNextValidation = new Set();
    const off = desktop.onFrame(frame => {
      if (frame.kind === 'link-open') desktop.sendLinkAccept(frame.src, frame.id, {
        appVersion: 'test', allowlistHash: 'test', capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1],
      });
      if (frame.kind !== 'invoke' || frame.payload.channel !== DL_SESSION_HANDOFF_CHANNEL) return;
      const [input] = frame.payload.args;
      assert.equal(input.action, 'validate-task-action');
      const validation = !input.release && denyNextValidation.delete(input.targetSessionId)
        ? Promise.resolve(false)
        : validateRemoteTaskActionReceipt(frame.src, input);
      void validation.then(valid => {
        if (input.release) releases.push({ target: input.targetSessionId, valid, held: Boolean(held) });
        desktop.sendInvokeResult(frame.src, frame.id, {
          ok: true, result: { valid, ...(input.release ? { released: valid } : {}) },
        });
      });
    });
    try {
      const handoff = args => desktop.invoke('host', { channel: DL_SESSION_HANDOFF_CHANNEL, args });
      const support = await handoff([{ action: 'task-action-capability' }]);
      assert.equal(support.ok, true, JSON.stringify(support));
      assert.equal(support.result.ordinaryCreateVersion, 1);
      assert.equal(support.result.ordinaryCreatePluginEngine, undefined);
      assert.equal(support.result.projectCatalogVersion, 1);
      assert.equal(support.result.taskActionVersion, 1);

      await db.drizzle.insert(recentWorkdirs).values({ path: profile, lastUsedAt: 1 }).run();
      const projects = await handoff([{ action: 'list-projects', options: { limit: 1 } }]);
      assert.equal(projects.result?.projects?.[0]?.workingDir, profile, JSON.stringify(projects));
      const models = await desktop.invoke('host', { channel: ORCA_REMOTE_WORKER_MODELS_CHANNEL, args: [{ agent: 'claude-code' }] });
      assert.equal(models.result?.claude_code?.[0]?.id, 'fixture-model', JSON.stringify(models));
      const worker = await desktop.invoke('host', { channel: ORCA_REMOTE_WORKER_CAPS_CHANNEL, args: [] });
      assert.equal(worker.error?.code, 'CHANNEL_NOT_ALLOWED');

      let lastWrite;
      const send = createRemoteSessionHandoff({
        captureAccess: () => () => {},
        invoke: (_id, channel, args) => {
          if (args[0].taskActionReceipt) lastWrite = args[0];
          return desktop.invoke('host', { channel, args });
        },
      });
      const id = randomUUID();
      const sender = async () => ({ sessionId: 'source-task', title: 'Desktop task' });
      // Integration regression: when two connected sources serve the same model,
      // the persisted draft's provider must win over the catalog's default.
      const draft = await clients[0].invoke('host', { channel: 'maker:apply-new-maker-draft-pref', args: [{
        agent: 'claude-code', providerId: 'selected-provider', modelId: 'fixture-model',
        active: true, markModelChoice: true, selectDraftAgent: true,
      }] });
      assert.equal(draft.ok, true, JSON.stringify(draft));
      const create = await send({ deviceId: 'host', sessionId: id }, {
        sender, message: 'First delegated message',
        create: async () => ({ permissionMode: 'ask', projectDir: null }),
      });
      assert.equal(create.ok, true, JSON.stringify(create));
      assert.equal(create.wakeKind, 'created');
      assert.equal(hostHello?.deviceName, deviceName);
      assert.ok(hostHello?.deviceInfo?.osVersion);
      const [stored] = await db.drizzle.select().from(sessions).where(eq(sessions.id, id));
      assert.equal(stored.permissionMode, 'ask');
      assert.equal(stored.model, 'fixture-model');
      assert.equal(stored.providerId, 'selected-provider');
      assert.equal(create.providerId, 'selected-provider');
      const jump = await send({ deviceId: 'host', sessionId: id }, { sender, message: 'Follow-up message' });
      assert.equal(jump.wakeKind, 'queued', JSON.stringify(jump));
      assert.deepEqual(handoffQueue.map(({ id, item, handoff }) => [id, item.text, handoff.origin.senderSessionId]), [
        [id, 'First delegated message', 'desktop::source-task'], [id, 'Follow-up message', 'desktop::source-task'],
      ]);
      // Cross-device history is the read-only recovery path after DELIVERY_UNKNOWN.
      // Direct renderer history above does not exercise the MCP request, cursors,
      // or qualified IDs. One production sender read on a stored reply reproduces
      // the old CHANNEL_NOT_ALLOWED with this same loopback relay (integration tier).
      await db.drizzle.insert(messages).values([
        { id: 'handoff-user', sessionId: id, role: 'user', content: JSON.stringify('First delegated message'), createdAt: 10 },
        { id: 'handoff-reply', sessionId: id, role: 'assistant', content: JSON.stringify('Result from the Host'), createdAt: 10 },
      ]).run();
      const readHistory = (sessionId, cursor = null) => readChatHistoryMessages({
        sessionIds: [`host::${sessionId}`], workdir: null, fromMs: null, toMs: null, agentKind: null,
        roles: ['user', 'assistant'], includeRewound: false, limit: 1, cursor, order: 'asc',
      }, {
        invokeRemote: (deviceId, channel, args) => desktop.invoke(deviceId, { channel, args }),
        readLocal: () => assert.fail('A qualified ID must not fall back to local history'),
      });
      const firstPage = await readHistory(id);
      assert.equal(firstPage.ok, true, JSON.stringify(firstPage));
      assert.equal(firstPage.page.hasMore, true);
      assert.deepEqual(firstPage.page.items.map(row => [row.sessionId, row.role, row.content]),
        [[`host::${id}`, 'user', 'First delegated message']]);
      const secondPage = await readHistory(id, firstPage.page.nextCursor);
      assert.equal(secondPage.ok, true, JSON.stringify(secondPage));
      assert.equal(secondPage.page.hasMore, false);
      assert.deepEqual(secondPage.page.items.map(row => [row.sessionId, row.role, row.content]),
        [[`host::${id}`, 'assistant', 'Result from the Host']]);
      assert.equal((await readHistory('missing')).errorCode, 'NOT_FOUND');

      const unsupportedPlugin = await send({ deviceId: 'host', sessionId: randomUUID() }, {
        sender, message: 'Plugin engine task',
        create: async () => ({ permissionMode: 'ask', agentKind: 'acp', providerId: 'acp-plugin:antigravity:acp', model: 'gemini-4-neon', projectDir: null }),
      });
      assert.equal(unsupportedPlugin.ok, false, JSON.stringify(unsupportedPlugin));
      assert.equal(unsupportedPlugin.errorCode, 'REMOTE_UNSUPPORTED');
      const bypassPlugin = createRemoteSessionHandoff({
        captureAccess: () => () => {},
        invoke: async (_id, channel, args) => {
          const res = await desktop.invoke('host', { channel, args });
          if (args[0]?.action === 'task-action-capability' && res.ok && res.result)
            return { ...res, result: { ...res.result, ordinaryCreatePluginEngine: 1 } };
          return res;
        },
      });
      const hostRejectedPlugin = await bypassPlugin({ deviceId: 'host', sessionId: randomUUID() }, {
        sender, message: 'Bypassed plugin engine task',
        create: async () => ({ permissionMode: 'ask', agentKind: 'acp', providerId: 'acp-plugin:antigravity:acp', model: 'gemini-4-neon', projectDir: null }),
      });
      assert.equal(hostRejectedPlugin.ok, false, JSON.stringify(hostRejectedPlugin));
      assert.equal(hostRejectedPlugin.errorCode, 'UNSUPPORTED_CAPABILITY');
      assert.equal(handoffQueue.length, 2);

      await handoffQueue[1].handoff.taskActionDeliveryGuard.onSettled();
      await assert.rejects(handoffQueue[1].handoff.taskActionDeliveryGuard(), /TASK_ACTION_AUTHORIZATION_EXPIRED/);
      assert.equal((await handoff([lastWrite])).result?.errorCode, 'UNSUPPORTED_CAPABILITY');
      assert.equal(handoffQueue.length, 2);

      // Integration: the existing desktop sender/loopback fixture covered ordinary
      // targets. A visible companion must reject without appearing to be missing.
      await t.test('a visible buddy target reports unsupported without enqueueing', async () => {
        const targets = [
          { id: 'visible-buddy', source: 'bot', hiddenAt: null },
          { id: 'legacy-buddy', source: 'desktop', hiddenAt: null },
          { id: 'hidden-buddy', source: 'bot', hiddenAt: 1 },
        ];
        await db.drizzle.insert(sessions).values(targets.map(target => ({
          ...target, title: 'Fixture buddy', status: 'active', agentKind: 'cc', createdAt: 1, updatedAt: 1,
        }))).run();
        await db.drizzle.insert(botProfiles).values({
          id: 'fixture-buddy', displayName: 'Fixture buddy', status: 'active', createdAt: 1, updatedAt: 1,
        }).run();
        await db.drizzle.insert(botSessionLinks).values(targets.map(target => ({
          id: `link-${target.id}`, botId: 'fixture-buddy', sessionId: target.id, role: 'delegation', createdAt: 1,
        }))).run();
        bindHostUiText(() => ['zh-CN']);
        try {
          for (const sessionId of ['visible-buddy', 'legacy-buddy']) {
            const result = await send({ deviceId: 'host', sessionId }, { sender, message: 'A buddy delegation' });
            assert.deepEqual(result, {
              ok: false, errorCode: 'UNSUPPORTED_CAPABILITY', message: '当前服务器或电脑暂不支持此操作。',
            }, sessionId);
          }
          for (const sessionId of ['hidden-buddy', 'no-such-buddy']) {
            const result = await send({ deviceId: 'host', sessionId }, { sender, message: 'A buddy delegation' });
            assert.equal(result.errorCode, 'NOT_FOUND');
          }
          assert.equal(handoffQueue.length, 2);
        } finally {
          configureUiText((_key, fallback) => fallback);
        }
      });

      // Integration: ordinary creation already works over this loopback. The
      // smallest missing case is a real profile hold between SQLite creation
      // and the first enqueue. Check the sender result and both ends of release.
      await t.test('a hold after creation refuses the first message and releases the receipt', async () => {
        const sessionId = randomUUID();
        holdAfterHandoffCreation = sessionId;
        try {
          const result = await send({ deviceId: 'host', sessionId }, {
            sender, message: 'Refused after creation',
            create: async () => ({ permissionMode: 'ask', projectDir: null }),
          });
          assert.equal(result.errorCode, 'CREATED_NOT_DELIVERED', JSON.stringify(result));
          assert.deepEqual(releases.filter(entry => entry.target === sessionId), [
            { target: sessionId, valid: true, held: true },
          ]);
        } finally {
          held = null;
          holdAfterHandoffCreation = undefined;
        }

        const createdRows = await db.drizzle.select().from(sessions).where(eq(sessions.id, sessionId));
        assert.equal(createdRows.length, 1);
        assert.equal(handoffQueue.some(entry => entry.id === sessionId), false);
        const history = await readHistory(sessionId);
        assert.equal(history.ok, true, JSON.stringify(history));
        assert.deepEqual(history.page.items, []);
        // A retained receiver claim would return DELIVERY_UNKNOWN before it
        // revalidates this already-released receipt with the sender.
        assert.equal((await handoff([lastWrite])).result?.errorCode, 'UNSUPPORTED_CAPABILITY');
      });

      // Integration (2026-11-28): `create.baseRef` over the real relay. The opener is shared with
      // Desktop, so this loopback is where the key crosses the wire into the Host's own worktree
      // preparation; the cases above never ask for a worktree. A project whose work branch is not
      // the default one otherwise starts every new task from the default branch. Minimal input: a
      // real repository and one create per outcome; createWorktree only records its request.
      await t.test('creates the task worktree from the requested base and reports what took effect', async () => {
        assert.equal(support.result.ordinaryCreateBaseRef, 1);
        const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-base-')));
        const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
          cwd: repo, stdio: 'ignore', env: { ...process.env,
            GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
            GIT_CONFIG_NOSYSTEM: '1' },
        });
        fs.mkdirSync(path.join(profile, 'created-worktree'), { recursive: true });
        try {
          git('init', '--initial-branch=main');
          git('commit', '--allow-empty', '-m', 'base');
          git('branch', 'release/2.x');
          const sessionId = randomUUID();
          const created = await send({ deviceId: 'host', sessionId }, {
            sender, message: 'Work on the release branch',
            create: async () => ({ permissionMode: 'ask', projectDir: null, workingDir: repo, useWorktree: true, baseRef: 'release/2.x' }),
          });
          assert.equal(created.ok, true, JSON.stringify(created));
          assert.equal(created.wakeKind, 'created');
          assert.equal(worktreeCreates.at(-1).request.sourceBranch, 'release/2.x');
          assert.equal(worktreeCreates.at(-1).request.sessionId, sessionId);
          assert.equal(created.worktreeBaseRef, 'release/2.x');
          assert.equal(created.worktreePath, path.join(profile, 'created-worktree'));
          // null = the Host's own provider; a caller must be able to tell it from "not reported".
          assert.equal(created.agentDeviceId, null);
          const [stored] = await db.drizzle.select().from(sessions).where(eq(sessions.id, sessionId));
          assert.equal(stored.worktreePath, path.join(profile, 'created-worktree'));

          const attempts = worktreeCreates.length;
          for (const create of [
            { useWorktree: true, baseRef: '--upload-pack=evil' },
            { baseRef: 'release/2.x' },
          ]) {
            const refusedId = randomUUID();
            const refused = await send({ deviceId: 'host', sessionId: refusedId }, {
              sender, message: 'Refused base',
              create: async () => ({ permissionMode: 'ask', projectDir: null, workingDir: repo, ...create }),
            });
            assert.equal(refused.errorCode, 'INVALID_ARGS', JSON.stringify(refused));
            assert.equal((await db.drizzle.select().from(sessions).where(eq(sessions.id, refusedId))).length, 0);
          }
          assert.equal(worktreeCreates.length, attempts);
        } finally {
          fs.rmSync(repo, { recursive: true, force: true });
        }
      });

      // This also uses the actual Node queue. The hold case does not reach it;
      // inject one failing boundary at a time after the task row exists.
      await t.test('settles pre-acceptance rejections but retains receipts after uncertain queue writes', async () => {
        let failure;
        let stopping;
        const originalEnqueue = enqueueHandoff;
        const input = createInputQueue({
          hub,
          getMaker: () => ({ getSession: () => undefined }),
          getOwner: getCurrentDbClientSnapshot,
          readSession: async sessionId => {
            const [row] = await db.drizzle.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
            if (failure === 'precondition') throw createIpcError('PRECONDITION_FAILED', 'Before admission');
            if (failure === 'cancelled') stopping = input.stop(sessionId);
            if (failure === 'expired') denyNextValidation.add(sessionId);
            return row;
          },
          persistQueueSnapshot: async () => {
            if (failure === 'after acceptance') throw createIpcError('PRECONDITION_FAILED', 'Queue write was not confirmed');
          },
        });
        enqueueHandoff = input.enqueue;
        try {
          for (const boundary of ['precondition', 'cancelled', 'expired', 'after acceptance']) {
            const sessionId = randomUUID();
            failure = boundary;
            const result = await send({ deviceId: 'host', sessionId }, {
              sender, message: 'First message at the queue boundary',
              create: async () => ({ permissionMode: 'ask', projectDir: null }),
            });
            await stopping;
            const uncertain = boundary === 'after acceptance';
            assert.equal(result.errorCode, uncertain ? 'DELIVERY_UNKNOWN' : 'CREATED_NOT_DELIVERED', boundary);
            assert.deepEqual(releases.filter(entry => entry.target === sessionId),
              uncertain ? [] : [{ target: sessionId, valid: true, held: false }], boundary);
            assert.equal(input.projection(sessionId).pendingQueue.length, uncertain ? 1 : 0, boundary);
            assert.equal((await handoff([lastWrite])).result?.errorCode,
              uncertain ? 'DELIVERY_UNKNOWN' : 'UNSUPPORTED_CAPABILITY', boundary);
          }
        } finally {
          failure = undefined;
          enqueueHandoff = originalEnqueue;
          await input.dispose();
        }
      });
    } finally { off(); }
  });
  /*
   * Test value (engineering-conventions §3.2): the real Mobile outbox uses the
   * same loopback Device Link and Host service as other sends. Start with one
   * committed user message whose outbox confirmation is pending. The existing
   * enqueue test can't observe the second record waiting behind it. The Host
   * must confirm the first without re-enqueueing it and persist the second once.
   * The legacy peer sends the original CHANNEL_NOT_ALLOWED over the same wire and offers the
   * historical page route without the newer capability. Exercise the same bounded read that
   * Mobile uses and count its requests along with actual committed SQLite rows.
   * Tier: integration with synthetic engine IO and an in-memory SQLite DB.
   */
  await t.test('confirms an already committed mobile input and sends the next exactly once', async t => {
    const { createDurableOutbox, createDurableOutboxDelivery, readLegacyOutboxHistory,
      invokeWithHistoryViewCapability } = loadMobileOutbox();
    const sessionId = 'outbox-task';
    const channel = 'local-db:messages:around-client-id';
    const view = 'local-db:messages:view';
    sqlite.prepare('INSERT INTO sessions(id, source, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(sessionId, 'desktop', 'active', 1, 1);
    const mobile = clients[0];
    const count = clientId => sqlite.prepare('SELECT count(*) AS n FROM messages WHERE session_id=? AND client_id=?')
      .get(sessionId, clientId).n;
    const rpc = (target, channel, args) => mobile.invoke(target, { channel, args });

    async function followup(target, firstState, { saved = true, suffix = '', cacheCaughtUp = () => true } = {}) {
      const first = [target, suffix, 'first'].filter(Boolean).join('-');
      const next = [target, suffix, 'next'].filter(Boolean).join('-');
      const commitFirst = () => insertMessage.run(randomUUID(), sessionId, first, 'user', 'first input', 100);
      if (saved) commitFirst();
      const data = new Map();
      const store = createDurableOutbox({
        getAllKeys: async () => [...data.keys()],
        getItem: async key => data.get(key) ?? null,
        setItem: async (key, value) => { data.set(key, value); },
        removeItem: async key => { data.delete(key); },
      });
      const message = (clientId, createdAt) => ({
        version: 1, accountId: 'test-account', deviceId: target, createdAt, state: 'queued', uploads: [],
        item: { sessionId, clientId, text: 'follow-up input', attachmentSlots: [] },
      });
      await store.activate('test-account');
      await store.add({
        ...message(first, 1), state: firstState,
        prepared: { clientId: first, text: 'first input' }, enqueueStarted: true, sendAtMs: 1,
      });
      await store.add(message(next, 2));
      const calls = [];
      const invoke = async (destination, name, args) => {
        calls.push([destination, name, ...args]);
        const reply = await rpc(destination, name, args);
        if (!reply.ok) throw new DeviceLinkError(reply.error.code, reply.error.message);
        return reply.result;
      };
      const enqueued = [];
      const delivery = createDurableOutboxDelivery({
        store, isCurrent: () => true, canRun: () => true,
        projection: r => invoke(target, 'maker:input:get-projection', [sessionId, { deliveryClientIds: [r.item.clientId] }]),
        prepare: async r => ({ clientId: r.item.clientId, text: r.item.text }),
        enqueue: r => {
          enqueued.push(r.item.clientId);
          return invoke(target, 'maker:input:enqueue', [sessionId, r.prepared, { sendAtMs: r.sendAtMs }]);
        },
        history: async r => (await invoke(target, channel, [sessionId, r.item.clientId, { radius: 1 }]))
          .some(row => row.clientId === r.item.clientId && row.role === 'user'),
        legacyHistory: async r => Boolean(await readLegacyOutboxHistory(r, (device, name, args) =>
          invokeWithHistoryViewCapability(name, async () => ({ capabilities: [] }),
            () => invoke(device, name, args), true))),
        cacheHistory: async r => cacheCaughtUp(r.item.clientId, first),
        bindProjection: () => () => {}, cleanup: async () => {},
        retryable: () => false, describe: error => error.message,
      });
      const run = async () => {
        delivery.wake();
        await delivery.run();
      };
      return { first, next, enqueued, store, run, commitFirst, calls, stop: delivery.stop };
    }

    const legacy = new DeviceLinkClient({
      getWsUrl: () => url, getToken: async () => 'synthetic-legacy-host',
      getHello: () => ({ deviceName: 'legacy-host', platform: 'linux', appVersion: 'test', remoteControlEnabled: true }),
      createWebSocket: (address, headers) => new WebSocket(address, { headers }),
    });
    t.after(() => legacy.stop());
    const legacyRoutes = new Map([
      [view, ([sid, opts]) => service('/api/messages/history-view', { sessionId: sid, opts })],
      ['maker:input:get-projection', ([sid]) => service('/api/input/projection', { sessionId: sid })],
      ['maker:input:enqueue', ([sid, item]) => service('/api/input/enqueue', { sessionId: sid, item })],
    ]);
    legacy.onFrame(async frame => {
      if (frame.kind === 'link-open') {
        legacy.sendLinkAccept(frame.src, frame.id, { appVersion: 'test', allowlistHash: '' });
      } else if (frame.kind === 'invoke') {
        const handle = legacyRoutes.get(frame.payload.channel);
        if (!handle) {
          legacy.sendInvokeResult(frame.src, frame.id,
            { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: "legacy peer does not support this channel" } });
          return;
        }
        try {
          const { body } = await handle(frame.payload.args);
          legacy.sendInvokeResult(frame.src, frame.id, { ok: true, result: body });
        } catch (error) {
          legacy.sendInvokeResult(frame.src, frame.id, { ok: false, error: { code: 'IPC_ERROR', message: error.message } });
        }
      }
    });
    legacy.start();
    await waitFor(() => legacy.getStatus() === 'online');
    const accepted = await mobile.openLink('legacy-host', { controllerName: 'ios', protocolVersion: PROTOCOL_VERSION, appVersion: 'test' });
    assert.equal(accepted.capabilities?.includes(DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1) ?? false, false);

    await t.test('old Host confirms with one page even while local history is catching up', async t => {
      let cacheReady = false;
      const f = await followup('legacy-host', 'confirming', { cacheCaughtUp: (id, head) => id !== head || cacheReady });
      t.after(f.stop);
      await f.run();
      assert.deepEqual(f.store.getSnapshot().map(r => r.state), ['host-owned', 'queued']);
      assert.equal(f.store.getSnapshot()[0].historyConfirmed, true);
      assert.deepEqual(f.calls.filter(([, name]) => name === view), [
        ['legacy-host', view, sessionId, { lazyDetails: true }],
      ]);
      await f.run();
      assert.deepEqual(f.enqueued, [f.next]);
      assert.equal(count(f.first), 1);
      assert.equal(count(f.next), 1);
      assert.equal(f.calls.filter(([, name, , clientId]) => name === channel && clientId === f.first).length, 1);
      cacheReady = true;
      await f.run();
      assert.deepEqual(f.store.getSnapshot(), []);
    });

    await t.test('a legacy miss waits for a read-only recheck before releasing the next input', async t => {
      const f = await followup('legacy-host', 'confirming', { saved: false, suffix: 'recheck' });
      t.after(f.stop);
      await f.run();
      await f.run();
      assert.deepEqual(f.enqueued, []);
      assert.deepEqual(f.store.getSnapshot().map(r => [r.item.clientId, r.state, r.historyConfirmation]), [
        [f.first, 'failed', 'unconfirmed'], [f.next, 'queued', undefined],
      ]);
      const reads = f.calls.filter(([, name]) => name === view);
      assert.equal(reads.length, 1);
      assert.equal(count(f.first), 0);
      assert.equal(count(f.next), 0);

      await f.store.update(f.store.getSnapshot()[0], { historyConfirmation: 'requested' });
      await f.run();
      assert.equal(f.store.getSnapshot()[0].historyConfirmation, 'unconfirmed');
      assert.deepEqual(f.enqueued, []);
      assert.equal(count(f.first), 0);
      assert.equal(count(f.next), 0);

      f.commitFirst();
      await f.store.update(f.store.getSnapshot()[0], { historyConfirmation: 'requested' });
      await f.run();
      assert.deepEqual(f.enqueued, []);
      assert.equal(f.calls.filter(([, name]) => name === view).length, 3);
      assert.deepEqual(f.calls.filter(([, name]) => name === channel)
        .map(([target, , task, clientId]) => [target, task, clientId]),
      Array.from({ length: 3 }, () => ['legacy-host', sessionId, f.first]));
      await f.run();
      assert.deepEqual(f.enqueued, [f.next]);
      assert.equal(count(f.first), 1);
      assert.equal(count(f.next), 1);
    });

    // Integrate the new Host's structured miss with the Mobile ledger. Both
    // branches cross the same real dispatcher and SQLite history read.
    for (const inQueue of [false, true]) {
      await t.test(`rechecks a missing history row ${inQueue ? 'still in' : 'absent from'} the Host queue`, async t => {
        const f = await followup('host', 'failed', { saved: false, suffix: inQueue ? 'pending' : 'missing' });
        t.after(f.stop);
        if (inQueue) outboxPending.push({ clientId: f.first });
        try {
          const miss = await rpc('host', channel, [sessionId, f.first, { radius: 1 }]);
          assert.equal(miss.ok, false);
          assert.equal(miss.error.code, 'NOT_FOUND');
          await f.store.update(f.store.getSnapshot()[0], { historyConfirmation: 'requested' });
          await f.run();
          const firstRecord = f.store.getSnapshot()[0];
          assert.equal(firstRecord.state, 'failed');
          assert.equal(firstRecord.historyConfirmation, inQueue ? 'unconfirmed' : undefined);
          await f.run();
          assert.deepEqual(f.enqueued, []);
          assert.equal(count(f.first), 0);
          assert.equal(count(f.next), 0);
          if (inQueue) return;

          await f.store.update(firstRecord, { state: 'queued' });
          for (let pass = 0; pass < 4; ++pass) await f.run();
          assert.deepEqual(f.enqueued, [f.first, f.next]);
          assert.equal(count(f.first), 1);
          assert.equal(count(f.next), 1);
          assert.deepEqual(f.store.getSnapshot(), []);
        } finally {
          if (inQueue) outboxPending.pop();
        }
      });
    }

    // An upgraded Host can repair a phone ledger whose first confirmation already failed.
    const f = await followup('host', 'failed');
    t.after(f.stop);
    for (let pass = 0; pass < 4; ++pass) await f.run();
    const { first, next } = f;
    assert.deepEqual(f.enqueued, [next], 'the confirmed first message must release the next FIFO entry');
    assert.equal(count(first), 1);
    assert.equal(count(next), 1);
    assert.deepEqual(f.store.getSnapshot(), []);
    assert.equal(f.calls.some(([, name]) => name === view), false);

    // The same read works during a profile hold and respects the desktop's
    // exact session/client identity, persisted visibility and content limit.
    held = projectHold;
    try {
      const around = await rpc('host', channel, [sessionId, first, { radius: 0, contentCharLimit: 5 }]);
      assert.equal(around.ok, true, JSON.stringify(around));
      assert.deepEqual(around.result.map(row => [row.clientId, row.content]), [[first, '…nput']]);
      const notFound = async (...args) => {
        const reply = await rpc('host', channel, args);
        assert.equal(reply.ok, false);
        assert.match(reply.error.message, /^\[NOT_FOUND\]/);
      };
      await notFound('task', first);
      await notFound(sessionId, sqlite.prepare('SELECT id FROM messages WHERE client_id=?').get(next).id);
      sqlite.prepare('UPDATE messages SET rewind_at=? WHERE session_id=? AND client_id=?').run(201, sessionId, next);
      await notFound(sessionId, next);
      sqlite.prepare('UPDATE sessions SET cleared_at=? WHERE id=?').run(100, sessionId);
      await notFound(sessionId, first);
    } finally { held = null; }
    assert.equal(count(first), 1, 'confirmation reads do not mutate the stored messages');
    assert.equal(count(next), 1);
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
  const pendingWrites = writes + 1;
  const inFlight = clients[1].invoke('host', { channel: 'maker:input:enqueue', args: ['task', { clientId: 'pending', text: 'wait' }] }).catch(() => null);
  await waitFor(() => writes === pendingWrites);
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
  // list_machines opens a background link with no subscriptions. Keep the
  // fixture's status reader explicit so a guest cannot reach the OS probes.
  let machineReads = 0;
  const machineStatus = {
    capturedAt: '2026-11-01T00:00:00.000Z',
    cpu: { logicalCores: 8, busyPercent: 2, loadAverage1m: 1 },
    memory: { totalBytes: 256, availableBytes: 128 },
    disk: { freeBytes: 512, totalBytes: 1024 },
    idleSeconds: 25, onBattery: false, runningTasks: 1,
  };
  let host, desktop, guest, hostDeviceInfo;
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
        if (id === 'host') hostDeviceInfo = frame.payload.deviceInfo;
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
  host = createHostDeviceLink({ profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', sessionInTurn: () => false, getWsUrl: () => url,
    getToken: async () => 'synthetic-host', canRegister: () => true,
    invoke: async route => { reached.push(route); return { status: 404, body: { message: `unexpected ${route}` } }; },
    readMachineStatus: async () => { machineReads++; return machineStatus; },
    subscribe: () => () => {},
    createRuntimeSession: async () => { throw new Error('Not part of this test'); },
    closeRuntimeSession: async () => { throw new Error('Not part of this test'); },
    disableShareAvailability: async () => { throw new Error('This fixture owns no standby grants'); },
  });
  await host.setEnabled(true);
  await waitFor(() => host.state().status === 'online');
  // The directory gets hardware and OS labels from hello, before it requests live status.
  assert.ok(hostDeviceInfo?.osVersion, 'the Host hello must include the OS version');
  if (os.cpus()[0]?.model.trim()) assert.ok(hostDeviceInfo.cpuLabel, 'the Host hello must include the CPU label');
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
  // Production loopback entry and regression for cindy-machines §3: a desktop
  // opens a regular relay background link and reads a valid status. Without the
  // capability or handler, the directory reports update_required.
  const accepted = await desktop.openLink('host', { controllerName: 'desktop', protocolVersion: PROTOCOL_VERSION,
    appVersion: 'test', capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] });
  assert.ok(accepted.capabilities?.includes(DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1));
  assert.ok(accepted.capabilities?.includes(DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1));
  const status = await desktop.invoke('host', { channel: MACHINE_STATUS_CHANNEL, args: [] });
  assert.deepEqual(status, { ok: true, result: machineStatus });
  assert.deepEqual(parseMachineStatus(status.result), machineStatus);
  assert.deepEqual(host.state().controllers, [], 'background probe does not control the computer');

  // The genuine relay invoke path used to report IPC_ERROR when an allowlisted handler was absent.
  // Clients cache only CHANNEL_NOT_ALLOWED as unsupported. Extend the existing loopback fixture
  // with one request per affected capability, including the goal write that must not reach a handler.
  for (const channel of [
    'maker:subscription-accounts', 'maker:goal:get-status', 'maker:goal:set',
    'maker:model-context-limit:get', 'maker:api-key:present',
  ]) {
    const reply = await desktop.invoke('host', { channel, args: [] });
    assert.deepEqual(reply, {
      ok: false,
      error: { code: 'CHANNEL_NOT_ALLOWED', message: `channel '${channel}' not allowed remotely` },
    }, channel);
  }

  const filePeer = await desktop.invoke('host', { channel: FILE_PEER_CHANNEL, args: [{}] });
  assert.deepEqual(filePeer, { ok: false, error: { code: 'IPC_ERROR', message: 'FILE_PEER_UNAVAILABLE' } });
  const remoteDesktop = await desktop.invoke('host', { channel: REMOTE_DESKTOP_CHANNEL, args: [{}] });
  assert.equal(remoteDesktop.ok, false, JSON.stringify(remoteDesktop));
  assert.equal(remoteDesktop.error.code, 'IPC_ERROR');
  assert.match(remoteDesktop.error.message, /^\[NOT_SUPPORTED\] requestRemoteDesktop /);

  for (const channel of [REMOTE_AGENT_CHANNEL, MACHINE_STATUS_CHANNEL, DL_HISTORY_MESSAGES_CHANNEL,
    'local-db:messages:around-client-id', 'local-db:sessions:list',
    'model-groups:get', 'model-groups:resolve', 'host:execute-arbitrary']) {
    const reply = await guest.invoke(hostKey, { channel, args: [] });
    assert.equal(reply.ok, false, `${channel}: ${JSON.stringify(reply)}`);
    assert.equal(reply.error.code, 'ACCESS_REVOKED', `${channel}: ${JSON.stringify(reply)}`);
  }
  assert.equal(machineReads, 1, 'only the same-account machine status request reached the reader');
  assert.deepEqual(reached, [], 'no refused channel may reach the Host service');
});

// Test value (engineering-conventions §3.2)
// - Production entry: createHostDeviceLink with a fake machine (temporary home, sshd answering, fixed endpoint): a
//   same-account desktop's device-link:ssh-access:v1 through the loopback relay, and the `cindy-host remote ssh-access` /
//   `ssh-key` commands (deviceLink.sshAccess). Observable: replies, device-link-settings.json, ~/.ssh/authorized_keys.
// - Rule: spec item 4 (only the person's choice is stored; "default" deletes it), the Host wires the same shared target
//   (architecture-invariants §5), coexistence plan A (writes refused while a desktop holds the profile).
// - Coverage gap: the target core tests run without the Host assembly; nothing checked the Host's dispatch port, its
//   settings store binding or the hold.
// - Minimal failing input: `ssh-access-default` leaving sshAccessEnabled in the file; an enrolment accepted while held.
// - Tier: unit with loopback sockets in-process, as the tests above (no real ~/.ssh, no sshd, no network).
test('Host SSH access: same-account enrolment, the remote commands and the profile hold', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-ssh-access-'));
  const home = path.join(profile, 'home');
  configureAppDataDir(profile);
  configureHostOwner({ userDataDir: profile, ownerId: 'test-ssh-owner' });
  const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7';
  const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMaGP9ZBWsUOAER5H5Zf4eYmzMBURk1Zj2heBDSMKSOi';
  const sockets = new Map();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let host, desktop, held = null;
  t.after(async () => {
    desktop?.stop();
    await host?.stop();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  wss.on('connection', (socket, request) => {
    const id = /^Bearer synthetic-(host|desktop)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!id) { socket.close(1008); return; }
    sockets.set(id, socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === 'hello') {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
          serverProtocolVersion: PROTOCOL_VERSION, deviceId: id, userId: 'synthetic-same-user', capabilities: [] } }));
        if (id === 'desktop') sockets.get('host')?.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'presence-changed',
          payload: { deviceId: 'desktop', platform: 'darwin', online: true, remoteControlEnabled: true } }));
      } else if (frame.kind === 'ping') socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'pong' }));
      else if (frame.dst && sockets.get(frame.dst)?.readyState === WebSocket.OPEN) {
        sockets.get(frame.dst).send(JSON.stringify({ ...frame, src: id }));
      }
    });
  });
  await once(wss, 'listening');
  const url = `ws://127.0.0.1:${wss.address().port}`;
  host = createHostDeviceLink({ profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', sessionInTurn: () => false,
    getWsUrl: () => url, getToken: async () => 'synthetic-host', canRegister: () => true,
    invoke: async route => ({ status: 404, body: { message: `unexpected ${route}` } }),
    subscribe: () => () => {},
    createRuntimeSession: async () => { throw new Error('Not part of this test'); },
    closeRuntimeSession: async () => { throw new Error('Not part of this test'); },
    disableShareAvailability: async () => { throw new Error('This fixture owns no standby grants'); },
    profileHold: () => held,
    deviceDirectory: async () => ['desktop', 'host'],
    sshAccessMachine: {
      platform: 'linux', homeDir: () => home, detectCloudGuest: async () => false, probeSshd: async () => true,
      readEndpointFacts: async () => ({ user: 'tester', port: 22, lanAddresses: [{ kind: 'lan', host: '10.0.0.9' }], mdnsName: null, hostKeys: [KEY_B] }),
      readPublicIpv4: async () => null,
      terminator: { endsKeySessions: true, terminateFingerprints: async () => ({ supported: true, terminated: 0, unmapped: 0 }),
        terminateAll: async () => ({ supported: true, terminated: 0, unmapped: 0 }) },
    },
  });
  await host.setEnabled(true);
  await waitFor(() => host.state().status === 'online');
  desktop = new DeviceLinkClient({ getWsUrl: () => url, getToken: async () => 'synthetic-desktop',
    getHello: () => ({ deviceName: 'desktop', platform: 'darwin', appVersion: 'test', remoteControlEnabled: false }),
    createWebSocket: (address, headers) => new WebSocket(address, { headers }) });
  desktop.start();
  await waitFor(() => desktop.getStatus() === 'online');
  await desktop.openLink('host', { controllerName: 'desktop', protocolVersion: PROTOCOL_VERSION, appVersion: 'test', capabilities: [] });
  const ssh = request => desktop.invoke('host', { channel: SSH_ACCESS_CHANNEL, args: [request] });
  const settingsFile = () => JSON.parse(fs.readFileSync(path.join(profile, 'device-link-settings.json'), 'utf8'));
  const authorizedKeys = () => fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8');

  // Off by default on an ordinary machine: the desktop is told so and cannot enrol.
  const { revision: _revision, ...off } = (await ssh({ action: 'status' })).result;
  assert.deepEqual(off, { version: 1, enabled: false, blocked: null, authorized: false, endpoint: null });
  const enroll = { action: 'enroll', requestId: 'host-test-0001', publicKey: KEY_A };
  assert.match((await ssh(enroll)).error.message, /^\[SSH_ACCESS_DISABLED\]/);

  assert.deepEqual((await host.sshAccess('ssh-access-on', {})).setting, true);
  assert.equal(settingsFile().sshAccessEnabled, true);
  const enrolled = await ssh(enroll);
  assert.deepEqual({ ok: enrolled.ok, authorized: enrolled.result.authorized, endpoint: enrolled.result.endpoint },
    { ok: true, authorized: true, endpoint: { user: 'tester', port: 22, addresses: [{ kind: 'lan', host: '10.0.0.9' }], hostKeys: [KEY_B] } });
  assert.ok(authorizedKeys().includes(`${KEY_A} cindy-device:desktop\n`));
  const added = await host.sshAccess('ssh-key-add', { publicKey: `${KEY_B} me@laptop\n`, label: 'work' });
  assert.equal(added.state.manualKeys[0].label, 'work');
  assert.match(authorizedKeys(), /cindy-manual:work/);
  await assert.rejects(host.sshAccess('ssh-key-remove', { fingerprint: 'not-a-fingerprint' }), /SHA256 fingerprint/);

  // A desktop holding the profile owns the files: the Host refuses changes but still answers status.
  held = 'HOST_PROFILE_IN_USE_BY_DESKTOP: The desktop window is using this profile.';
  assert.match((await ssh({ action: 'withdraw', requestId: 'host-test-0002' })).error.message, /^\[SSH_ACCESS_UNAVAILABLE\]/);
  await assert.rejects(host.sshAccess('ssh-access-off', {}));
  assert.equal((await ssh({ action: 'status' })).result.authorized, true);
  held = null;

  const restored = await host.sshAccess('ssh-access-default', {});
  assert.deepEqual({ setting: restored.setting, customized: restored.customized, enabled: restored.enabled }, { setting: false, customized: false, enabled: false });
  assert.equal('sshAccessEnabled' in settingsFile(), false);
  assert.equal(authorizedKeys(), '');
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
    'noteControllerAccessDenied', 'syncRemoteControlAccessGeneration', 'invalidatePluginOauth', 'hasLocalChannel',
    'assertRemoteBotInvocationAllowed', 'projectRemoteSessionResult', 'projectRemoteBotPush', 'hasRemoteBotSessionLookup',
    'setRemoteBotSessionLookup', 'captureSharedTaskPeer', 'captureSharedTaskPush', 'assertSharedTaskInvoke',
    'sharedTaskMetadataTopic', 'sharedTaskAccessFailure', 'MAX_SHARED_TASK_TOPICS', 'refreshSharedTaskPeer',
    'releaseSharedTaskWatchesOnWorkdirChange', 'admitSharedTaskFsWatchTopics', 'setBroadcastTapListener', 'broadcastTap',
    'RECOVERY_CHECKPOINT_MARKER', 'sanitizeBotAuthorizationMetaForRemote', 'projectInteractionDismissedForRemote',
    'projectInteractionRequestForRemote', 'remoteWorkingDirRejectionToIpcError'],
  'service-gate': ['executeTaskTags', 'dispatchLocalInvoke'],
  'refused-at-entry': ['requestPluginOauth', 'sshAccessTarget'],
  unbound: ['readUsageWidgetSnapshot', 'configureStandbyGuestCleanup', 'prepareShareAvailability',
    'readZhipuCodingPlanAccountUsage', 'isRemoteProviderInvocationAllowed',
    'readKimiCodingAccountUsage', 'readOpenCodeGoAccountUsage', 'requestFilePeer', 'stopFilePeers', 'requestTaskMigration',
    'delegatedProviderShareGuestAccess', 'locallyProvenProviderShareDelegation',
    'delegatedProviderShareLeases', 'invalidateProviderShareDelegation',
    'remoteDesktop', 'requestRemoteDesktop', 'remoteCredentialHost', 'fetchLocalMediaToOss', 'transcribeRemoteVoiceInput',
    'readTelegramRemoteStatus', 'setTelegramRemoteOnline', 'adviseAndRecordVoiceInputDictionaryLearning',
    'buildMobileDictionarySnapshot', 'mutateMobileDictionary'],
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
    profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', sessionInTurn: () => false, getWsUrl: () => 'ws://127.0.0.1:9',
    getToken: async () => 'synthetic-host', canRegister: () => true,
    invoke: async () => ({ status: 200, body: {} }), subscribe: () => () => {},
    createRuntimeSession: async () => ({}), closeRuntimeSession: async () => {}, disableShareAvailability: async () => {},
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

// §3.2 integration: drive the Host's real dispatch over one simulated relay.
// A backpressured reply must stay in the outbox while its route is known offline.
// Removing either offline notification wiring allows the next full sweep to
// write to that peer. Another controller and the directed relink flush stay live.
for (const offlineSignal of ['presence', 'relay error']) {
  test(`Host outbox skips an offline controller after ${offlineSignal} and flushes it on relink`, async t => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-offline-outbox-'));
    configureAppDataDir(profile);
    configureHostOwner({ userDataDir: profile, ownerId: 'test-offline-outbox' });
    const sockets = [];
    const attempts = [];
    const released = [];
    class Wire extends EventEmitter {
      sent = [];
      bufferedAmount = 0;
      send(data) {
        const frame = JSON.parse(data);
        if (frame.kind === 'invoke-result') {
          attempts.push(frame.id);
          if ((frame.id === 'waiting-a' || frame.id === 'waiting-b')
            && attempts.filter(id => id === frame.id).length === 1)
            throw new DeviceLinkError('BACKPRESSURE', 'fixture write is full');
        }
        this.sent.push(frame);
        if (frame.kind === 'hello') queueMicrotask(() => this.push({ kind: 'hello-ack',
          payload: { serverProtocolVersion: PROTOCOL_VERSION, deviceId: 'host', userId: 'test-offline-outbox' } }));
      }
      push(frame) { this.emit('message', JSON.stringify({ v: PROTOCOL_VERSION, ...frame })); }
      close(code = 1000) { this.emit('close', code); }
    }
    const host = createHostDeviceLink({
      profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test',
      getWsUrl: () => 'ws://127.0.0.1:9', getToken: async () => 'synthetic-host', canRegister: () => true,
      invoke: async () => ({ status: 200, body: {} }), subscribe: () => () => {},
      createRuntimeSession: async () => ({}), closeRuntimeSession: async () => {}, disableShareAvailability: async () => {},
      releaseAuthCaller: caller => released.push(caller),
      createWebSocket: () => {
        const socket = new Wire();
        sockets.push(socket);
        setImmediate(() => socket.emit('open'));
        return socket;
      },
    });
    t.after(async () => {
      await host.stop();
      commitVolatileAppSession('signed-out', null, true);
      fs.rmSync(profile, { recursive: true, force: true });
    });

    await host.setEnabled(true);
    await waitFor(() => host.state().status === 'online');
    const [relay] = sockets;
    const open = (src, id) => relay.push({ kind: 'link-open', src, id,
      payload: { controllerName: src, protocolVersion: PROTOCOL_VERSION, appVersion: 'test' } });
    const subscribe = (src, id, topics = ['sessions']) => relay.push({ kind: 'invoke', src, id,
      payload: { channel: 'device-link:subscribe', args: [{ topics }] } });
    const reply = id => relay.sent.find(frame => frame.kind === 'invoke-result' && frame.id === id);
    const settle = () => new Promise(resolve => setImmediate(resolve));
    open('peer-a', 'a-open');
    open('peer-b', 'b-open');
    await waitFor(() => relay.sent.filter(frame => frame.kind === 'link-accept').length === 2);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    subscribe('peer-a', 'a-probe');
    subscribe('peer-a', 'waiting-a');
    await settle();
    assert.equal(reply('a-probe')?.payload.ok, true);
    assert.deepEqual(attempts, ['a-probe', 'waiting-a']);

    if (offlineSignal === 'presence') {
      relay.push({ kind: 'presence-changed', payload: { deviceId: 'peer-a', online: false } });
    } else {
      relay.push({ kind: 'relay-error', id: 'a-probe',
        payload: { dst: 'peer-a', code: 'DEVICE_OFFLINE', message: 'device offline' } });
    }
    t.mock.timers.tick(500);
    await settle();
    assert.equal(attempts.filter(id => id === 'waiting-a').length, 1, 'no blind outbox write while offline');
    assert.deepEqual(released, ['device:peer-a']);
    subscribe('peer-b', 'b-live');
    await settle();
    assert.equal(reply('b-live')?.payload.ok, true);

    open('peer-a', 'a-reopen');
    await settle();
    assert.equal(reply('waiting-a')?.payload.ok, true);
    t.mock.timers.tick(500);
    assert.deepEqual(attempts, ['a-probe', 'waiting-a', 'b-live', 'waiting-a']);
    assert.deepEqual(sockets, [relay]);
    assert.equal(relay.sent.filter(frame => frame.kind === 'link-accept' && frame.dst === 'peer-b').length, 1);

    if (offlineSignal === 'presence') {
      // §3.2: the production presence handler must still clear the controller's
      // platform, App caller, and accepted subscription during an owner boundary.
      // This is distinct from recording a new offline outbox gate for that owner.
      relay.push({ kind: 'presence-changed', payload: { deviceId: 'peer-b', online: true, platform: 'ios' } });
      assert.equal(getControllerPlatform('peer-b'), 'ios');
      subscribe('peer-b', 'waiting-b', ['session:task']);
      await settle();
      assert.equal(attempts.filter(id => id === 'waiting-b').length, 1);
      assert.equal(host.state().controllers.some(controller => controller.deviceId === 'peer-b'), true);
      const endBoundary = beginAppSessionBoundary();
      try {
        relay.push({ kind: 'presence-changed', payload: { deviceId: 'peer-b', online: false } });
        await settle();
        assert.equal(getControllerPlatform('peer-b'), undefined);
        assert.deepEqual(released, ['device:peer-a', 'device:peer-b']);
        assert.equal(host.state().controllers.some(controller => controller.deviceId === 'peer-b'), false);
      } finally {
        endBoundary();
      }
      t.mock.timers.tick(500);
      await settle();
      assert.equal(attempts.filter(id => id === 'waiting-b').length, 2,
        'a pending owner boundary must not record an offline outbox gate');
    }
  });
}

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
    profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', sessionInTurn: () => false, getWsUrl: () => 'ws://127.0.0.1:9',
    getToken: async () => null, canRegister: () => canRegister, profileHold: () => held,
    invoke: async () => ({ status: 200, body: {} }), subscribe: () => () => {},
    createRuntimeSession: async () => ({}), closeRuntimeSession: async () => {}, disableShareAvailability: async () => {},
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
    createRuntimeSession: async () => ({}), closeRuntimeSession: async () => {}, disableShareAvailability: async () => {},
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

// Test value (engineering-conventions §3.2)
// - Production entry and observable result: `cindy-host remote agent-net-on` (createHostDeviceLink `setAgentNetEnabled`, with the
//   real shared agentNetNode): whether it asks the official service, rejoins first, and turns Agent-Net on; the `rejoin` result.
// - Rule: 2026-11-26, a device removed from the account must be able to come back by turning Agent-Net on on that device
//   (signing in again restores only Device Link; agent-net-device-removal.md).
// - Coverage gap: the rejoin test above covers `cindy-host remote rejoin` only; turning the switch on never looked at revocation.
// - Minimal failing input: an enrolled Host whose `/directory` answers 401 DEVICE_REVOKED, or missing from the account's Device Link
//   device list, turned on again; offline; never enrolled.
// - Tier: unit, fake official services in process (real certificates), the Device Link client stays stopped.
test('cindy-host remote agent-net-on rejoins a Host removed from the account before turning Agent-Net on', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-agent-net-on-'));
  configureHostOwner({ userDataDir: profile, ownerId: 'agent-net-on-owner' });
  // On, so that the first rejoin below enrolls the identity this Host had before it was removed.
  fs.writeFileSync(path.join(profile, 'device-link-settings.json'), '{"agentNetEnabled":true,"remoteControlEnabled":false}');
  const { root, bootstrap } = createPrivateNetwork('Test Host network', generateIdentity('root-agent-net-on'));
  const secrets = new Map(), rejoins = [], enrollments = [];
  let directory = async () => new Response(JSON.stringify({ rootPublicKey: bootstrap.rootPublicKey, devices: [] }), { status: 200 });
  let directoryReads = 0, listed = null;
  const host = createHostDeviceLink({
    profileDir: profile, worktree: createHostWorktreeLifecycle(profile), version: 'test', getWsUrl: () => 'ws://127.0.0.1:9',
    getToken: async () => null, canRegister: () => true, profileHold: () => null,
    invoke: async () => ({ status: 200, body: {} }), subscribe: () => () => {},
    createRuntimeSession: async () => ({}), closeRuntimeSession: async () => {}, disableShareAvailability: async () => {},
    agentNet: {
      base: () => 'https://test-agent-net.invalid', subject: () => 'agent-net-on-owner', deviceId: () => 'host', deviceName: () => 'Test Host',
      readSecret: async key => secrets.get(key) ?? null,
      writeSecret: async (key, value) => { secrets.set(key, value); },
      enroll: async (_base, body) => {
        enrollments.push(body.rejoin === true ? 'rejoin' : 'enroll');
        return { rootPublicKey: bootstrap.rootPublicKey,
          certificate: issueCertificate(root, { networkId: 'account:test', subject: 'agent-net-on-owner', identity: body, role: 'member' }) };
      },
      fetch: async url => { if (String(url).endsWith('/directory')) directoryReads++; return directory(); },
      createWebSocket: async () => { throw new Error('No real Agent-Net relay in this test'); },
      workerFile: () => null, coreModule: async () => { throw new Error('No Agent-Net core in this test'); }, log: { info() {}, warn() {} },
      deviceLinkDeviceIds: async () => listed,
    },
    officialDeviceLinkFetch: async route => { rejoins.push(route); return { deviceId: 'host', rejoined: true }; },
  });
  t.after(async () => {
    await host.stop();
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const turnOn = async () => { await host.setAgentNetEnabled(false); const result = await host.setAgentNetEnabled(true); return result.rejoin; };

  // Never enrolled on this account's service: nothing to ask.
  await host.setAgentNetEnabled(false);
  secrets.clear();
  assert.equal(await turnOn(), undefined);
  assert.equal(directoryReads, 0);
  assert.equal((await host.rejoin()).rejoin.agentNet, 'rejoined'); // Enrolls the identity this Host had.
  rejoins.length = 0; enrollments.length = 0;

  // Removed from the account: its certificate is revoked. Turning Agent-Net on brings it back first, then turns it on.
  directory = async () => new Response(JSON.stringify({ error: { code: 'DEVICE_REVOKED' } }), { status: 401 });
  assert.deepEqual(await turnOn(), { result: 'rejoined', agentNet: 'rejoined' });
  assert.deepEqual([rejoins, enrollments], [['/api/device-link/rejoin'], ['rejoin']]);
  assert.equal(host.state().agentNet.enabled, true);

  // Signed in again after a removal: not on the account's device list (every computer refuses it on Agent-Net), even with no
  // stored Agent-Net secret yet: turning Agent-Net on still forces Agent-Net rejoin (never 'skipped').
  directory = async () => new Response(JSON.stringify({ rootPublicKey: bootstrap.rootPublicKey, devices: [] }), { status: 200 });
  rejoins.length = 0; enrollments.length = 0; listed = ['desktop']; secrets.clear();
  assert.deepEqual(await turnOn(), { result: 'rejoined', agentNet: 'rejoined' });
  assert.deepEqual([rejoins, enrollments], [['/api/device-link/rejoin'], ['rejoin']]);
  listed = ['desktop', 'host'];

  // Offline, or not removed: turned on as before, without asking anyone to rejoin.
  for (const answer of [async () => { throw new TypeError('fetch failed'); },
    async () => new Response(JSON.stringify({ rootPublicKey: bootstrap.rootPublicKey, devices: [] }), { status: 200 })]) {
    directory = answer;
    assert.equal(await turnOn(), undefined);
    assert.equal(host.state().agentNet.enabled, true);
  }
  assert.deepEqual([rejoins, enrollments], [['/api/device-link/rejoin'], ['rejoin']]);
});

// Test value (engineering-conventions §3.2)
// - Production entry and observable result: Node Host's shared `parseAgentNetUdpPort` (`CINDY_AGENT_NET_UDP_PORT`) and
//   `getOfficialAgentNetPeerBase` helpers run without Electron, validate 1..65535 (warning and falling back to ephemeral on
//   invalid input), and map official CN <-> Global bases while returning null for self-hosted/custom URLs.
// - Rule: architecture-invariants §5 (shared core tested under Host runtime); dual-region STUN privacy boundary.
// - Coverage gap: desktop Vitest tests run under desktop's toolchain; Host's Node runner verifies zero-Electron import and env parsing.
// - Minimal failing input: valid port '41641', '0'/empty, invalid '70000'/'abc', and official vs self-hosted URLs.
// - Tier: unit, pure functions in Node Host runner.
test('Node Host parses CINDY_AGENT_NET_UDP_PORT and pairs only official Agent-Net regions', () => {
  const warnings = [];
  const log = { warn: msg => warnings.push(msg) };
  assert.equal(parseAgentNetUdpPort(undefined, log), undefined);
  assert.equal(parseAgentNetUdpPort('', log), undefined);
  assert.equal(parseAgentNetUdpPort('0', log), undefined);
  assert.equal(parseAgentNetUdpPort('1', log), 1);
  assert.equal(parseAgentNetUdpPort(' 41641 ', log), 41641);
  assert.equal(parseAgentNetUdpPort('65535', log), 65535);
  assert.equal(warnings.length, 0);

  for (const invalid of ['-1', '65536', '70000', '41641.5', 'abc', '41641px']) {
    assert.equal(parseAgentNetUdpPort(invalid, log), undefined);
  }
  assert.equal(warnings.length, 6);

  assert.equal(getOfficialAgentNetPeerBase('https://agent-net.cindy.com.cn'), 'https://agent-net.cindy.app');
  assert.equal(getOfficialAgentNetPeerBase('https://agent-net.cindy.app/'), 'https://agent-net.cindy.com.cn');
  assert.equal(getOfficialAgentNetPeerBase('https://self-hosted.example.test'), null);
  assert.equal(getOfficialAgentNetPeerBase('http://127.0.0.1:8787'), null);
});

test('Host device-link pushes session activity, turn-ended patches, and serves history view-intent and work-details', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-status-history-'));
  configureAppDataDir(profile);
  configureHostOwner({ userDataDir: profile, ownerId: 'test-status-history-owner' });
  commitVolatileAppSession('cloud', 'test-status-history-owner', true);
  const sqlite = new Database(':memory:');
  for (const table of [sessions, messages, taskTags, sessionTaskTags, orcaWorkers, orcaTeams, botSessionLinks, botProfiles, recentWorkdirs, projectAliases]) {
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table)).map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  }
  sqlite.exec(`
    INSERT INTO sessions(id, source, title, working_dir, agent_kind, status, created_at, updated_at, active_turn_started_at)
    VALUES ('task-1', 'desktop', 'Status Task', '/repo', 'cc', 'active', 1000, 1000, 1000);
    INSERT INTO messages(id, client_id, session_id, role, content, tool_use_id, created_at) VALUES
      ('m-user', 'c-user', 'task-1', 'user', '"run check"', NULL, 1000),
      ('m-tool-use', 'c-tu', 'task-1', 'tool_use', '{"toolUseId":"tu-1","toolName":"Read","input":{"file_path":"/repo/a.ts"}}', 'tu-1', 1100),
      ('m-tool-res', 'c-tr', 'task-1', 'tool_result', '{"toolUseId":"tu-1","summary":"ok","fullText":"const a = 1;"}', 'tu-1', 1200),
      ('m-reply', 'c-reply', 'task-1', 'assistant', '"done"', NULL, 1300),
      ('m-err', 'c-err', 'task-1', 'error', '{"message":"boom","sdkError":"rate_limit"}', NULL, 1400);
  `);
  const db = createDbClientForHandle({ db: sqlite, drizzle: drizzle(sqlite) });
  setCurrentDbClient(db, 'test-status-history-owner');
  const reader = createHostHistoryReader({ running: () => false, live: () => [] });
  setHistoryWorkPageReader((sid, onShape) => reader.page(sid, undefined, true, { workLines: true, onShape }));
  const hub = createEventHub();
  setOnSessionTurnEndedPersisted(
    (sessionId, endedAt, capturedScope) => {
      if (capturedScope && !broadcastTap.isDataOwnerBroadcastScopeCurrent(capturedScope)) return;
      hub.publish({ type: 'session_changed', sessionId, patch: { lastTurnEndedAt: endedAt } });
    },
    broadcastTap.captureDataOwnerBroadcastScope,
  );

  const sockets = new Map();
  const platforms = new Map();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let host;
  const clients = [];
  t.after(async () => {
    clients.forEach(c => c.stop());
    await host?.stop();
    setOnSessionTurnEndedPersisted(null);
    setHistoryWorkPageReader(null);
    for (const s of wss.clients) s.terminate();
    await new Promise(resolve => wss.close(resolve));
    clearCurrentDbClient(db);
    sqlite.close();
    commitVolatileAppSession('signed-out', null, true);
    fs.rmSync(profile, { recursive: true, force: true });
  });

  wss.on('connection', (socket, request) => {
    const match = /^Bearer synthetic-(host|ctrl-1|ctrl-2)$/.exec(request.headers.authorization ?? '');
    if (!match) { socket.close(1008); return; }
    const id = match[1];
    sockets.set(id, socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === 'hello') {
        platforms.set(id, frame.payload.platform);
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
          serverProtocolVersion: PROTOCOL_VERSION, deviceId: id, userId: 'synthetic-user', capabilities: [],
        } }));
        for (const [peer, target] of sockets) for (const [deviceId, platform] of platforms) {
          if (peer !== deviceId && target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: { deviceId, platform, online: true, remoteControlEnabled: true } }));
          }
        }
      } else if (frame.kind === 'ping') {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'pong' }));
      } else if (frame.dst && sockets.get(frame.dst)?.readyState === WebSocket.OPEN) {
        sockets.get(frame.dst).send(JSON.stringify({ ...frame, src: id }));
      }
    });
    socket.once('close', () => { if (sockets.get(id) === socket) sockets.delete(id); });
  });
  await once(wss, 'listening');
  const url = `ws://127.0.0.1:${wss.address().port}`;

  const service = createHostService({
    getSession: async id => {
      const [row] = await db.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      return row ? { id: row.id, title: row.title, status: row.status, workingDir: row.workingDir } : null;
    },
    historyView: (id, before, opts) => readHostHistoryView(reader, id, before, opts),
    workDetails: (id, ref, after) => readHostWorkDetails(reader, id, ref, after),
    listRunningSessions: options => {
      const rows = [
        { sessionId: 'task-1', agentKind: 'claude-code', workDir: '/repo', capabilities: {}, isTurnRunning: false },
        { sessionId: 'task-idle', agentKind: 'claude-code', workDir: '/repo', capabilities: {}, isTurnRunning: false },
      ];
      return options?.summary === true && options?.snapshotVersion === 2
        ? { format: 'active-sessions-v2', sessions: rows }
        : rows;
    },
    clearSessionAttention: async (id, intent) => {
      await host.acknowledgeSessionRead(id, intent);
      return { ok: true };
    },
    ackInterrupted: async id => { await ackSessionTurnEndedDurable(String(id)); return { ok: true }; },
    dismissError: (id, cid) => dismissHostErrorMessage(
      id,
      cid,
      message => {
        hub.publish({ type: 'message_created', sessionId: message.sessionId, messageId: message.id, message });
      },
      async (sid, clientId) => {
        if (sid === 'task-1' && clientId === 'c-deferred-err') {
          await new Promise(resolve => setTimeout(resolve, 20));
          await db.drizzle.insert(messages).values({
            id: 'm-deferred-err', clientId: 'c-deferred-err', sessionId: 'task-1', role: 'error',
            content: JSON.stringify({ message: 'overflow', sdkError: 'context_length' }), createdAt: 1500,
          }).run();
        }
      },
    ),
  });
  host = createHostDeviceLink({
    profileDir: profile,
    worktree: createHostWorktreeLifecycle(profile),
    version: 'test',
    getWsUrl: () => url,
    getToken: async () => 'synthetic-host',
    canRegister: () => true,
    invoke: service,
    subscribe: hub.subscribe,
    publish: hub.publish,
    createWebSocket: (u, headers) => new WebSocket(u, { headers }),
  });
  await host.setEnabled(true);
  await waitFor(() => host.state().status === 'online');

  // An attached Desktop consumes this same turn over SSE while the two controllers use Device Link.
  const attached = [];
  const server = createHostServer({ instanceId: 'fixture', token: 'synthetic-stream', events: hub, service });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let connected = false;
  const stop = startHostEventBridge({
    baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'synthetic-stream',
    onConnectionState: state => { connected = state.status === 'connected'; },
    broadcast() {},
    onPluginPush(channel, payload) {
      if (channel === 'agent-island:session-snapshots') attached.push(payload);
    },
  });
  t.after(async () => {
    stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await waitFor(() => connected);

  const mkClient = id => {
    const c = new DeviceLinkClient({
      getWsUrl: () => url,
      getToken: async () => `synthetic-${id}`,
      getHello: () => ({ platform: 'darwin', deviceName: id, appVersion: 'test', remoteControlEnabled: false, busy: false, capabilities: [] }),
      createWebSocket: (u, headers) => new WebSocket(u, { headers }),
    });
    clients.push(c);
    return c;
  };
  const c1 = mkClient('ctrl-1');
  const c2 = mkClient('ctrl-2');
  const c1Pushes = [];
  const c2Pushes = [];
  const off1 = c1.onFrame(frame => {
    if (frame.kind === 'push' && frame.src === 'host') c1Pushes.push({ ch: frame.payload.channel, payload: frame.payload.payload });
  });
  const off2 = c2.onFrame(frame => {
    if (frame.kind === 'push' && frame.src === 'host') c2Pushes.push({ ch: frame.payload.channel, payload: frame.payload.payload });
  });
  t.after(() => { off1(); off2(); });

  c1.start();
  await waitFor(() => c1.getStatus() === 'online');
  await c1.openLink('host', { controllerName: 'Mac 1', protocolVersion: PROTOCOL_VERSION, appVersion: 'test' });
  assert.equal((await c1.invoke('host', { channel: 'device-link:subscribe', args: [{ topics: ['sessions', 'session:task-1'] }] })).ok, true);

  hub.publish({ sessionId: 'task-1', event: { type: 'status', data: { isRunning: true } } });
  await waitFor(() => c1Pushes.some(p => p.ch === SESSION_ACTIVITY_CHANNEL && p.payload?.sessionId === 'task-1' && p.payload?.phase === 'running'));

  hub.publish({
    type: 'interaction_request',
    sessionId: 'task-1',
    request: { kind: 'permission', requestId: 'perm-1', toolName: 'Bash', input: { command: 'pwd' } },
  });
  await waitFor(() => c1Pushes.some(p => p.ch === SESSION_ACTIVITY_CHANNEL && p.payload?.phase === 'needs-interaction' && p.payload?.interactionKind === 'permission'));

  hub.publish({ type: 'interaction_dismissed', sessionId: 'task-1', requestId: 'perm-1', reason: 'resolved' });
  hub.publish({ sessionId: 'task-1', event: { type: 'done', data: {} } });
  await waitFor(() => c1Pushes.some(p => p.ch === SESSION_ACTIVITY_CHANNEL && p.payload?.phase === 'completed' && p.payload?.attention === true));

  markSessionTurnEnded('task-1', 2000);
  await drainSessionActiveTurnWrites('task-1');
  await waitFor(() => c1Pushes.some(p => p.ch === 'local-db:sessions:patched' && p.payload?.sessionId === 'task-1' && p.payload?.patch?.lastTurnEndedAt === 2000));

  c2.start();
  await waitFor(() => c2.getStatus() === 'online');
  await c2.openLink('host', { controllerName: 'Mac 2', protocolVersion: PROTOCOL_VERSION, appVersion: 'test' });
  assert.equal((await c2.invoke('host', { channel: 'device-link:subscribe', args: [{ topics: ['sessions'] }] })).ok, true);
  await waitFor(() => c2Pushes.some(p => p.ch === SESSION_ACTIVITY_CHANNEL && p.payload?.sessionId === 'task-1' && p.payload?.phase === 'completed' && p.payload?.attention === true));

  const fg = await c2.invoke('host', { channel: TASK_ACTIVITY_SNAPSHOT, args: [] });
  assert.equal(fg.ok, true, JSON.stringify(fg));
  assert.equal(fg.result.schemaVersion, 1);
  assert.equal(fg.result.unreadCount, 1);

  const active = await c2.invoke('host', { channel: 'maker:list-active', args: [{ summary: true, snapshotVersion: 2 }] });
  assert.equal(active.ok, true, JSON.stringify(active));
  assert.equal(active.result.format, 'active-sessions-v2');
  const activeMap = new Map(active.result.sessions.map(s => [s.sessionId, s]));
  assert.equal(activeMap.get('task-1')?.activityPhase, 'completed');
  assert.equal(activeMap.get('task-1')?.activityAttention, true);
  assert.equal(activeMap.get('task-idle')?.activityPhase, 'idle');
  assert.equal(activeMap.get('task-idle')?.activityAttention, false);

  await waitFor(() => attached.at(-1)?.some(item => item.sessionId === 'task-1' && item.phase === 'completed' && item.attention));
  const cleared = await c1.invoke('host', { channel: 'notification:clear-session-attention', args: ['task-1', 'explicit'] });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  await waitFor(() => c1Pushes.some(p => p.ch === SESSION_ACTIVITY_CHANNEL && p.payload?.sessionId === 'task-1' && p.payload?.attention === false));

  await waitFor(() => !attached.at(-1).some(item => item.sessionId === 'task-1' && item.attention));

  // An HTTP acknowledgement from another attached client clears this Desktop's unread state too.
  hub.publish({ sessionId: 'task-1', event: { type: 'status', data: { isRunning: true } } });
  hub.publish({ sessionId: 'task-1', event: { type: 'done', data: {} } });
  await waitFor(() => attached.at(-1)?.some(item => item.sessionId === 'task-1' && item.attention));
  const clearResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications/clear-session-attention`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'task-1', intent: 'explicit' }),
  });
  assert.equal(clearResponse.status, 200);
  await waitFor(() => !attached.at(-1).some(item => item.sessionId === 'task-1' && item.attention));

  const view = await c1.invoke('host', { channel: 'local-db:messages:view', args: ['task-1', { lazyDetails: true, workLines: true }] });
  assert.equal(view.ok, true, JSON.stringify(view));
  const workItem = view.result.items.find(item => item.type === 'work');
  assert.ok(workItem, JSON.stringify(view.result.items));

  const intentOk = await c1.invoke('host', { channel: 'local-db:messages:view-intent', args: ['task-1', [{ key: workItem.key }]] });
  assert.equal(intentOk.ok, true, JSON.stringify(intentOk));
  const intentBad = await c1.invoke('host', { channel: 'local-db:messages:view-intent', args: ['task-1', 'not-an-array'] });
  assert.equal(intentBad.ok, false);
  assert.match(intentBad.error?.message ?? '', /INVALID_PARAMS/);

  const legacyView = await c1.invoke('host', { channel: 'local-db:messages:view', args: ['task-1', {}] });
  assert.equal(legacyView.ok, true, JSON.stringify(legacyView));
  assert.ok(legacyView.result.items.some(item => item.type === 'work'));

  const workRef = {
    key: workItem.key,
    firstMessageId: workItem.summary.firstMessageId,
    lastMessageId: workItem.summary.lastMessageId,
    ...(workItem.summary.firstStoredMessageId ? { firstStoredMessageId: workItem.summary.firstStoredMessageId } : {}),
    ...(workItem.summary.lastStoredMessageId ? { lastStoredMessageId: workItem.summary.lastStoredMessageId } : {}),
  };
  const details = await c1.invoke('host', { channel: 'local-db:messages:work-details', args: ['task-1', workRef, {}] });
  assert.equal(details.ok, true, JSON.stringify(details));
  assert.deepEqual(details.result.messages.map(m => m.id), ['m-tool-use', 'm-tool-res']);

  const beforeAckCount = c1Pushes.length;
  const ack = await c1.invoke('host', { channel: 'local-db:sessions:ack-interrupted', args: ['task-1'] });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  await waitFor(() => c1Pushes.slice(beforeAckCount).some(p => p.ch === 'local-db:sessions:patched' && p.payload?.sessionId === 'task-1' && typeof p.payload?.patch?.lastTurnEndedAt === 'number'));

  const dismissed = await c1.invoke('host', { channel: 'local-db:messages:dismiss-error', args: ['task-1', 'c-err'] });
  assert.equal(dismissed.ok, true, JSON.stringify(dismissed));
  const dismissedContent = typeof dismissed.result.content === 'string' ? JSON.parse(dismissed.result.content) : dismissed.result.content;
  assert.equal(dismissedContent.dismissed, true);
  assert.equal(dismissedContent.sdkError, 'rate_limit');
  await waitFor(() => c1Pushes.some(p => p.ch === 'local-db:messages:created' && p.payload?.message?.clientId === 'c-err'));

  const deferredDismiss = await c1.invoke('host', { channel: 'local-db:messages:dismiss-error', args: ['task-1', 'c-deferred-err'] });
  assert.equal(deferredDismiss.ok, true, JSON.stringify(deferredDismiss));
  const deferredContent = typeof deferredDismiss.result.content === 'string' ? JSON.parse(deferredDismiss.result.content) : deferredDismiss.result.content;
  assert.equal(deferredContent.dismissed, true);

  const dismissMissing = await c1.invoke('host', { channel: 'local-db:messages:dismiss-error', args: ['task-1', 'c-reply'] });
  assert.equal(dismissMissing.ok, false);
  assert.match(dismissMissing.error?.message ?? '', /NOT_FOUND/);
});
