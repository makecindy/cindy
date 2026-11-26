/*
 * 测试价值
 * - 生产入口与可观察结果：
 *   1. Host 的插件运行时与 page handler（createGhostPageHandler + handleGhostHarnessesRequest +
 *      configurePluginHarnessRegistry + createHostNodeRuntimeBroker）处理 PUT/GET /harnesses，
 *      经真实 Node 子进程以 raw-stdio 模式（node-process.ts + createAcpProcessTransport）启动并通信。
 *   2. createHostAgentGraph 在插件引擎注册表上线后自动注册 AcpAgent，注入 Host 的 MCP 桥、
 *      花名册与 listSessionSkills（含禁用 Skill 过滤），并在 disposePluginEngines 后退订。
 *   3. createHostPluginEngines 与 createHostDeviceLink 暴露 PLUGIN_ENGINES_INVOKE（list / refresh /
 *      usage / set-remote-use / set-prefs），区分本机与远控视图、执行准入，并通过同账号
 *      REMOTE_AGENT_CHANNEL（caps.pluginEngines: true + open）承载远程插件引擎任务。
 * - 规则依据：docs/dev-rules/protocol-compatibility/plugin-harnesses.md 与 architecture-invariants §5。
 * - 最小失败输入：/harnesses 仍 404；AcpAgent 未注册或销毁后仍留在订阅表；远控视图泄露本机设置字段或允许改写；
 *   远端控制端看不到 pluginEngines 能力或未开放远程调用的引擎被放行。
 * - tier：integration（真实临时目录、真实 raw-stdio Node 子进程与回环 Device Link，不调外部模型）。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import { DeviceLinkClient, PROTOCOL_VERSION, REMOTE_AGENT_CHANNEL } from '@cindy/device-link';
import { configureHostOwner } from '../agent/claude-auth.mjs';
import { createHostAgentGraph } from '../agent/runtime.ts';
import { createHostMcpRuntime } from '../agent/mcp-runtime.ts';
import { createHostDeviceLink } from '../device-link.ts';
import { createHostService } from '../service.mjs';
import { createHostNodeRuntimeBroker } from './node-process.ts';
import { createHostPluginEngines } from './plugin-engines.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

import { commitVolatileAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { createGhostKvStore } from '../../../desktop/src/main/cindy-brain/ghostKvStore.ts';
import { createGhostPageHandler } from '../../../desktop/src/main/cindy-brain/runtime/ghostPageHandler.ts';
import { handleGhostHarnessesRequest } from '../../../desktop/src/main/cindy-brain/runtime/ghostHarnessesEndpoint.ts';
import {
  configurePluginHarnessRegistry,
  getPluginHarnessRegistry,
  reconcilePluginHarnesses,
} from '../../../desktop/src/main/cindy-brain/pluginHarnesses.ts';
import { createAvailabilityPolicy } from '../../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts';
import { setRemoteBotSessionLookup } from '../../../desktop/src/main/device-link/remoteBotSessionBoundary.ts';
import { createAcpProcessTransport } from '../../../desktop/src/main/maker-host/acp-transport.ts';
import { admitPluginEngineSession } from '../../../desktop/src/main/maker-ipc/pluginEngineSessionAdmission.ts';
import { pluginEngineModelsOf, pluginEngineSettingsOf } from '../../../desktop/src/main/maker-ipc/pluginEnginesIpc.ts';
import { setCindySkillEnabled } from '../../../desktop/src/main/skillhub/activationPreferences.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { validateGhostManifest } from '../../../desktop/src/shared/ghost.ts';
import { installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.ts';
import { PLUGIN_ENGINES_INVOKE, PLUGIN_ENGINES_PUSH } from '../../../desktop/src/shared/pluginEngines.ts';

const TEST_TIMEOUT_MS = 120_000;

function fixtureHarnessRoot(profile) {
  const root = path.join(profile, 'harnesses');
  const dir = path.join(root, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  return root;
}

function makeHarnessGhost(dir, extra = {}) {
  const parsed = validateGhostManifest({
    schemaVersion: 3,
    minCindyVersion: '0.1.61',
    id: 'demo-acp',
    name: 'Demo ACP Plugin',
    version: '1.0.0',
    entry: 'main.js',
    node: { entry: 'worker.js', protocol: 'json-rpc-stdio', entries: ['acp.js'] },
    harnesses: [{ id: 'engine', name: 'Demo Engine', protocol: 'acp', entry: 'acp.js' }],
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    manifest: parsed.manifest,
    dir,
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    approvedHarnesses: ['engine'],
    approvedNode: true,
    ...extra,
  };
}

function createMemoryRelay() {
  const sockets = new Map();
  const platforms = new Map();
  const onlineWaiters = new Map();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (socket, request) => {
    const match = /^Bearer synthetic-(host|desktop)$/.exec(request.headers.authorization ?? '');
    if (!match) { socket.close(1008); return; }
    const id = match[1];
    sockets.set(id, socket);
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.kind === 'hello') {
        platforms.set(id, frame.payload.platform);
        socket.send(JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: 'hello-ack',
          payload: {
            serverProtocolVersion: PROTOCOL_VERSION,
            deviceId: id,
            userId: 'synthetic-user',
            capabilities: [],
          },
        }));
        for (const [peer, target] of sockets) {
          for (const [deviceId, platform] of platforms) {
            if (peer !== deviceId && target.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify({
                v: PROTOCOL_VERSION,
                kind: 'presence-changed',
                payload: { deviceId, platform, online: true, remoteControlEnabled: true },
              }));
            }
          }
        }
        onlineWaiters.get(id)?.forEach((resolve) => resolve());
        onlineWaiters.delete(id);
      } else if (frame.kind === 'ping') {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'pong' }));
      } else if (frame.dst && sockets.get(frame.dst)?.readyState === WebSocket.OPEN) {
        sockets.get(frame.dst).send(JSON.stringify({ ...frame, src: id }));
      }
    });
    socket.once('close', () => {
      if (sockets.get(id) === socket) sockets.delete(id);
    });
  });
  return {
    async url() {
      if (!wss.address()) await once(wss, 'listening');
      return `ws://127.0.0.1:${wss.address().port}`;
    },
    waitOnline(id) {
      if (platforms.has(id)) return Promise.resolve();
      return new Promise((resolve) => {
        const list = onlineWaiters.get(id) ?? [];
        list.push(resolve);
        onlineWaiters.set(id, list);
      });
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

test('Host /harnesses endpoint, plugin harness registry, and raw-stdio spawnHarness work end-to-end', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-harnesses-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-harnesses' });
  configureAppDataDir(path.join(profile, 'app-data'));

  const pluginDir = path.join(profile, 'plugin-demo-acp');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'main.js'), '// logic');
  fs.writeFileSync(path.join(pluginDir, 'worker.js'), '// worker');
  // Raw-stdio echo harness: replies with a JSON-RPC line including the launch args it received.
  fs.writeFileSync(path.join(pluginDir, 'acp.js'), `
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: msg.id, args: process.argv.slice(2), echo: msg.method }) + '\\n');
      }
    });
  `);

  const ghost = makeHarnessGhost(pluginDir);
  const ghostKey = installedGhostStoragePart(ghost);
  const harnessKey = `${ghostKey}:engine`;
  const harnessesStore = createGhostKvStore({ getRootDir: () => path.join(profile, 'ghost-published-harnesses') });

  const broker = createHostNodeRuntimeBroker(path.join(pluginDir, 'worker.js'), {
    getGhost: (id) => (id === ghostKey ? ghost : null),
    ownerScope: { capture: () => 'owner-harnesses', isCurrent: (v) => v === 'owner-harnesses', isStable: (v) => v === 'owner-harnesses' },
    readSecret: () => null,
    secretSaved: () => false,
    sendToGhost: () => {},
    log: { info() {}, warn() {}, error() {} },
  });
  t.after(() => broker.destroyAll());

  configurePluginHarnessRegistry({
    listGhosts: () => [ghost],
    isAvailable: (id) => id === ghostKey,
    readAvailability: (id) => harnessesStore.read(id),
    uiLocale: () => 'en',
    spawn: (id, hId, opts) => broker.spawnHarness(id, hId, opts),
  });
  reconcilePluginHarnesses([ghost]);
  t.after(() => reconcilePluginHarnesses([]));

  const pageHandler = createGhostPageHandler({
    ghost,
    origin: 'https://demo.cindy-ghost.invalid',
    isCurrent: () => true,
    ghostHarnessesHandler: (input) => handleGhostHarnessesRequest({
      ...input,
      declared: () => ghost.manifest.harnesses,
      store: harnessesStore,
      onChanged: () => reconcilePluginHarnesses([ghost]),
    }),
    log: { info() {}, warn() {}, error() {} },
  });

  // PUT /harnesses publishes availability + models + remoteWorkspace and updates the registry.
  const putRes = await pageHandler(new Request('https://demo.cindy-ghost.invalid/harnesses', {
    method: 'PUT',
    body: JSON.stringify({
      harnesses: [{
        id: 'engine',
        available: true,
        version: '1.2.3',
        remoteWorkspace: true,
        models: [{ id: 'demo-pro', name: 'Demo Pro', efforts: ['low', 'high'], defaultEffort: 'high' }],
      }],
    }),
  }));
  assert.equal(putRes.status, 200);
  const getRes = await pageHandler(new Request('https://demo.cindy-ghost.invalid/harnesses', { method: 'GET' }));
  assert.equal(getRes.status, 200);
  assert.equal((await getRes.json()).harnesses[0].version, '1.2.3');

  const listed = getPluginHarnessRegistry().list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].key, harnessKey);
  assert.equal(listed[0].availability.state, 'available');
  assert.equal(listed[0].remoteWorkspace, true);

  // Spawn raw-stdio harness via Host broker and exchange lines through AcpProcessTransport.
  const proc = await getPluginHarnessRegistry().spawn(harnessKey, { remoteWorkspace: true });
  const transport = createAcpProcessTransport(proc, { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } });
  const received = [];
  const gotLine = new Promise(resolve => {
    transport.onLine((line) => {
      received.push(JSON.parse(line));
      resolve();
    });
  });
  transport.write(JSON.stringify({ id: 1, method: 'initialize' }));
  await gotLine;
  assert.deepEqual(received, [{ id: 1, args: ['--cindy-remote-workspace'], echo: 'initialize' }]);
  await transport.close();
});

test('createHostAgentGraph registers AcpAgent with Skills/roster/MCP bridge and cleans up on dispose', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-acp-graph-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-acp-graph' });
  configureAppDataDir(path.join(profile, 'app-data'));

  let listedGhosts = [];
  configurePluginHarnessRegistry({
    listGhosts: () => listedGhosts,
    isAvailable: () => true,
    readAvailability: () => ({}),
    uiLocale: () => 'en',
    spawn: async () => { throw new Error('unused'); },
  });
  reconcilePluginHarnesses([]);
  t.after(() => {
    listedGhosts = [];
    reconcilePluginHarnesses([]);
  });

  const keptSkill = path.join(profile, 'skills', 'kept-skill', 'SKILL.md');
  const disabledSkill = path.join(profile, 'skills', 'off-skill', 'SKILL.md');
  for (const file of [keptSkill, disabledSkill]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\nname: test\n---\n');
  }
  await setCindySkillEnabled(disabledSkill, false);

  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: () => null });
  t.after(() => mcp.close());
  const rosterPrompt = ({ workingDir }) => `host-roster:${workingDir}`;
  const graph = createHostAgentGraph({
    userDataDir: profile,
    harnessRoot: fixtureHarnessRoot(profile),
    appVersion: '0.9.9-test',
    gateway: null,
    mcpRuntime: mcp,
    mcpProviders: [],
    storage: {},
    getGhostRosterPrompt: rosterPrompt,
    getManagedSkills: async () => [
      { name: 'cindy:kept', description: 'kept', path: keptSkill },
      { name: 'cindy:off', description: 'off', path: disabledSkill },
    ],
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [],
      readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false },
    },
  });
  t.after(() => {
    graph.disposePluginEngines();
    graph.piPackages.close();
  });

  // Before any plugin harness is reconciled, `acp` is not registered.
  assert.equal(graph.hasEngine('acp'), false);
  assert.deepEqual(graph.maker.listAvailableAgents(), []);

  // Reconciling a harness dynamically registers `acp` on Maker.
  listedGhosts = [makeHarnessGhost(profile)];
  reconcilePluginHarnesses(listedGhosts);
  assert.equal(graph.hasEngine('acp'), true);
  // Built-in listAvailableAgents keeps excluding `acp` (same contract as Desktop).
  assert.deepEqual(graph.maker.listAvailableAgents(), []);

  // AcpAgent lists managed Skills with disabled-Skill filtering applied.
  const skillsRes = await graph.maker.listAgentSkills('acp', { workingDir: profile });
  const names = skillsRes.skills.map(s => s.name);
  assert.ok(names.includes('cindy:kept'), `expected cindy:kept in ${JSON.stringify(names)}`);
  assert.ok(!names.includes('cindy:off'), `disabled skill must be filtered out: ${JSON.stringify(names)}`);

  // A second graph disposed before reconciliation never receives a late registration.
  const graph2 = createHostAgentGraph({
    userDataDir: profile,
    harnessRoot: fixtureHarnessRoot(profile),
    gateway: null,
    mcpRuntime: mcp,
    mcpProviders: [],
    storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [],
      readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false },
    },
  });
  listedGhosts = [];
  reconcilePluginHarnesses([]);
  graph2.disposePluginEngines();
  t.after(() => graph2.piPackages.close());
  // Re-check a fresh graph created while empty and disposed before reconcile:
  const graph3 = createHostAgentGraph({
    userDataDir: profile,
    harnessRoot: fixtureHarnessRoot(profile),
    gateway: null,
    mcpRuntime: mcp,
    mcpProviders: [],
    storage: {},
    providerConfig: {
      grok: { hasGrokOAuthLogin: () => false, grokAccountIdentity: () => null },
      list: async () => [],
      readKey: () => null,
      oauth: { readCachedGenericOAuthAccessToken: () => null },
      codexAccounts: { setCodexAccountRetirement: () => {}, isCodexAccountProvider: () => false },
    },
  });
  graph3.disposePluginEngines();
  t.after(() => graph3.piPackages.close());
  listedGhosts = [makeHarnessGhost(profile)];
  reconcilePluginHarnesses(listedGhosts);
  assert.equal(graph3.hasEngine('acp'), false, 'disposed graph must not register ACP on later reconcile');
});

test('Host PLUGIN_ENGINES_INVOKE, admission, Device Link projection, and remote-agent host pluginEngines work', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-plugin-ipc-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: 'owner-plugin-ipc' });
  configureAppDataDir(path.join(profile, 'app-data'));

  const ghost = makeHarnessGhost(profile);
  const ghostKey = installedGhostStoragePart(ghost);
  const engineKey = `${ghostKey}:engine`;
  const providerId = `acp-plugin:${engineKey}`;
  let refreshCount = 0;
  let usageCount = 0;

  configurePluginHarnessRegistry({
    listGhosts: () => [ghost],
    isAvailable: () => true,
    readAvailability: () => ({
      harnesses: [{
        id: 'engine',
        available: true,
        version: '2.0.0',
        remoteWorkspace: true,
        reportsUsage: true,
        models: [
          { id: 'demo-pro', name: 'Demo Pro', efforts: ['low', 'high'], defaultEffort: 'high' },
          { id: 'demo-mini', name: 'Demo Mini' },
        ],
      }],
    }),
    uiLocale: () => 'en',
    spawn: async () => { throw new Error('unused'); },
    requestRefresh: () => { refreshCount += 1; return true; },
    readUsage: async () => { usageCount += 1; return { updatedAt: 100, balances: [{ currency: 'USD', amount: '5.00' }] }; },
  });
  reconcilePluginHarnesses([ghost]);
  t.after(() => reconcilePluginHarnesses([]));

  const pushed = [];
  const availabilityPolicy = createAvailabilityPolicy(async () => {});
  const pluginEngines = createHostPluginEngines({
    availabilityPolicy,
    publish: (channel, payload) => pushed.push({ channel, payload }),
  });
  t.after(() => pluginEngines.dispose());

  // Local prefs + remote-use toggle + broadcast.
  await pluginEngines.setPrefs({ key: engineKey, name: 'Host DeepSeek', models: { ids: ['demo-mini'], disabled: true } });
  await pluginEngines.setRemoteUse({ key: engineKey, enabled: true });
  assert.ok(pushed.some(p => p.channel === PLUGIN_ENGINES_PUSH.CHANGED));

  const localList = pluginEngines.list();
  assert.equal(localList.length, 1);
  assert.equal(localList[0].name, 'Host DeepSeek');
  assert.equal(localList[0].declaredName, 'Demo Engine');
  assert.deepEqual(localList[0].models.map(m => m.id), ['demo-pro']);
  assert.deepEqual(localList[0].disabledModels?.map(m => m.id), ['demo-mini']);
  assert.equal(localList[0].remoteUse.enabled, true);

  // Session admission accepts enabled model and rejects turned-off model.
  const admitted = admitPluginEngineSession(
    { agentKind: 'acp', providerId, model: 'demo-pro', effort: 'low' },
    getPluginHarnessRegistry().list(),
    pluginEngineModelsOf,
    pluginEngineSettingsOf,
  );
  assert.equal(admitted.model, 'demo-pro');
  assert.equal(admitted.effort, 'low');
  assert.throws(() => admitPluginEngineSession(
    { agentKind: 'acp', providerId, model: 'demo-mini' },
    getPluginHarnessRegistry().list(),
    pluginEngineModelsOf,
    pluginEngineSettingsOf,
  ), /已.*关闭/);

  // Wire through real createHostService + createHostDeviceLink over loopback relay.
  const service = createHostService({ pluginEngines });
  const relay = createMemoryRelay();
  t.after(() => relay.close());
  const wsUrl = await relay.url();

  const hostedStarts = [];
  let resolveHostedStart;
  const hostedStarted = new Promise((resolve) => { resolveHostedStart = resolve; });
  const hostLink = createHostDeviceLink({
    profileDir: profile,
    worktree: {},
    version: '0.9.9-test',
    getWsUrl: () => wsUrl,
    getToken: async () => 'synthetic-host',
    canRegister: () => true,
    invoke: (pathname, body, context) => service(pathname, body, context),
    isBusyForProjectArchive: () => false,
    sessionInTurn: () => false,
    onProjectTaskStatus: () => {},
    preparePiSkillRuntime: async () => {},
    createRuntimeSession: async () => ({}),
    closeRuntimeSession: async () => {},
    send: async () => ({}),
    assertRemoteInputControlBoundary: async () => ({}),
    setExtraDirs: async () => [],
    isSessionClaimed: async () => false,
    subscribe: () => () => {},
    availabilityPolicy,
    disableShareAvailability: async () => {},
    remoteAgentPluginEngines: {
      getMaker: () => ({
        startHostedAgentSession: async (kind, opts) => {
          hostedStarts.push({ kind, opts });
          resolveHostedStart();
          return {
            id: 'hosted-acp-1',
            agentKind: kind,
            model: opts.model,
            getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
            send: async () => {},
            abort: async () => {},
            close: async () => {},
            async *events() {},
          };
        },
      }),
      isOffered: (pid, model) =>
        !pluginEngines.remoteUse.isPluginEngineModelTurnedOff(pid, model)
        && pluginEngines.remoteUse.isPluginEngineOfferedRemotely(pid)
        && (model === undefined || pluginEngines.remoteModelAccess.allows(pid, model)),
      onAccessChanged: (listener) => pluginEngines.onAccessChanged(listener),
    },
  });
  t.after(async () => {
    setRemoteBotSessionLookup(null);
    await hostLink.stop();
    commitVolatileAppSession('signed-out', null, true);
  });
  // This test exercises Device Link transport without mounting SQLite.
  setRemoteBotSessionLookup(async () => 'ordinary');
  await hostLink.setEnabled(true);

  const controller = new DeviceLinkClient({
    getWsUrl: () => wsUrl,
    getToken: async () => 'synthetic-desktop',
    getHello: () => ({
      deviceName: 'Controller',
      platform: 'darwin',
      appVersion: '0.9.9',
      remoteControlEnabled: false,
    }),
    createWebSocket: (address, headers) => new WebSocket(address, { headers }),
  });
  t.after(() => controller.stop());
  const controllerReady = new Promise((resolve) => {
    const off = controller.onStatusChange((status) => {
      if (status === 'online') { off(); resolve(); }
    });
  });
  controller.start();
  await Promise.all([relay.waitOnline('host'), relay.waitOnline('desktop'), controllerReady]);

  const hostDeviceId = 'host';
  await controller.openLink(hostDeviceId, { controllerName: 'Controller', protocolVersion: PROTOCOL_VERSION, appVersion: '0.9.9' });

  // 1. Remote LIST strips local settings-only fields (`declaredName`, `disabledModels`).
  const listReply = await controller.invoke(hostDeviceId, { channel: PLUGIN_ENGINES_INVOKE.LIST, args: [] });
  assert.equal(listReply.ok, true, JSON.stringify(listReply));
  assert.equal(listReply.result.length, 1);
  assert.equal(listReply.result[0].name, 'Host DeepSeek');
  assert.equal(listReply.result[0].declaredName, undefined, 'remote view must not expose declaredName');
  assert.equal(listReply.result[0].disabledModels, undefined, 'remote view must not expose disabledModels');
  assert.equal(listReply.result[0].remoteUse.enabled, true);

  // 2. Remote REFRESH triggers plugin refresh.
  const refreshReply = await controller.invoke(hostDeviceId, { channel: PLUGIN_ENGINES_INVOKE.REFRESH, args: [] });
  assert.equal(refreshReply.ok, true, JSON.stringify(refreshReply));
  assert.equal(refreshCount, 1);

  // 3. Remote USAGE queries plugin worker usage.
  const usageReply = await controller.invoke(hostDeviceId, { channel: PLUGIN_ENGINES_INVOKE.USAGE, args: [engineKey] });
  assert.equal(usageReply.ok, true, JSON.stringify(usageReply));
  assert.equal(usageCount, 1);
  assert.equal(usageReply.result.balances[0].amount, '5.00');

  // 4. Remote SET_PREFS and SET_REMOTE_USE are refused by Device Link allowlist.
  for (const forbidden of [PLUGIN_ENGINES_INVOKE.SET_PREFS, PLUGIN_ENGINES_INVOKE.SET_REMOTE_USE]) {
    const res = await controller.invoke(hostDeviceId, { channel: forbidden, args: [{ key: engineKey, enabled: false }] });
    assert.equal(res.ok, false, forbidden);
    assert.equal(res.error.code, 'CHANNEL_NOT_ALLOWED', forbidden);
  }

  // 5. Same-account REMOTE_AGENT_CHANNEL caps advertise `pluginEngines: true` and open starts `acp`.
  const capsReply = await controller.invoke(hostDeviceId, { channel: REMOTE_AGENT_CHANNEL, args: [{ op: 'caps' }] });
  assert.equal(capsReply.ok, true, JSON.stringify(capsReply));
  assert.equal(capsReply.result.pluginEngines, true);
  assert.equal(
    capsReply.result.agents.every((a) => a.available === false),
    true,
    `built-in remote agent hosting stays disabled on Node Host: ${JSON.stringify(capsReply.result.agents)}`,
  );

  // Opening a turned-off model is refused; opening an offered model starts hosted `acp`.
  const openDenied = await controller.invoke(hostDeviceId, {
    channel: REMOTE_AGENT_CHANNEL,
    args: [{
      op: 'open',
      runId: '00000000-0000-4000-8000-000000000011',
      agentKind: 'acp',
      payload: {
        json: {
          sessionId: 'remote-task-1',
          virtualWorkspace: true,
          options: { model: 'demo-mini', providerId },
          workspace: { workingDir: '/remote/repo', platform: 'darwin', extraDirs: [], writableDirs: [], shell: 'bash', isGitRepo: false },
          projectFiles: [],
          ancestorFiles: [],
          personal: { files: [] },
          mcpServers: [],
        },
      },
    }],
  });
  assert.equal(openDenied.ok, false, 'disabled model must be refused over remote-agent');
  assert.match(openDenied.error?.message ?? '', /REMOTE_AGENT_PROVIDER_NOT_ALLOWED|not allowed|disabled|unavailable/i);

  const openAllowed = await controller.invoke(hostDeviceId, {
    channel: REMOTE_AGENT_CHANNEL,
    args: [{
      op: 'open',
      runId: '00000000-0000-4000-8000-000000000012',
      agentKind: 'acp',
      payload: {
        json: {
          sessionId: 'remote-task-2',
          virtualWorkspace: true,
          options: { model: 'demo-pro', providerId },
          workspace: { workingDir: '/remote/repo', platform: 'darwin', extraDirs: [], writableDirs: [], shell: 'bash', isGitRepo: false },
          projectFiles: [],
          ancestorFiles: [],
          personal: { files: [] },
          mcpServers: [],
        },
      },
    }],
  });
  assert.equal(openAllowed.ok, true, JSON.stringify(openAllowed));
  await hostedStarted;
  assert.equal(hostedStarts.length, 1);
  assert.equal(hostedStarts[0].kind, 'acp');
  assert.equal(hostedStarts[0].opts.providerId, providerId);
  assert.equal(hostedStarts[0].opts.model, 'demo-pro');
  const pollReply = await controller.invoke(hostDeviceId, {
    channel: REMOTE_AGENT_CHANNEL,
    args: [{ op: 'poll', runs: [{ runId: '00000000-0000-4000-8000-000000000012', cursor: 0 }], waitMs: 5000 }],
  });
  assert.equal(pollReply.ok, true, JSON.stringify(pollReply));
  await controller.invoke(hostDeviceId, {
    channel: REMOTE_AGENT_CHANNEL,
    args: [{ op: 'close', runId: '00000000-0000-4000-8000-000000000012', mode: 'close', reason: 'controller-closed' }],
  });
});
