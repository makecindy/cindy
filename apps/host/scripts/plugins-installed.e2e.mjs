// Integration tier: actual installed receipts, disk stores, Chromium and Node.
// A synthetic encrypted codec is used ONLY in this isolated fixture; this does
// not validate an OS keyring or a real account. No user's profile is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { GhostManager } from '../../desktop/src/main/cindy-brain/GhostManager.ts';
import { configureGhostSnapshotProcess } from '../../desktop/src/main/cindy-brain/ghostSnapshotCapability.ts';
import { createSnapshotProcess } from '../src/snapshot-process.mjs';
import { configureHostOwner } from '../src/agent/claude-auth.mjs';
import { createCredentialStore } from '../src/credentials/store.mjs';
import { createHostPluginRuntime } from '../src/plugins/runtime.ts';
import { createHostPluginGateway } from '../src/plugins/gateway.ts';
import { createHostMcpRuntime } from '../src/agent/mcp-runtime.ts';
import { createCustomMcpStore } from '../../desktop/src/main/maker-host/custom-mcp-store.ts';
import { startMockAppServer } from '../../desktop/scripts/mcp-apps-mock.mjs';
import { createMakerLogger } from '../../desktop/src/main/maker-host/logger-adapter.ts';
import { hostRuntimeLayout } from '../src/runtime-layout.mjs';
import { createHostMessageStore } from '../src/message-store.ts';
import { GhostGrantConfirmBridge } from '../../desktop/src/main/cindy-brain/ghostGrantConfirmBridge.ts';
import { openOwnerDatabase } from '../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, getCurrentDbClientSnapshot, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { sessions, messages } from '../../desktop/src/main/localDb/schema.ts';
import { ownerScopedPath } from '../../desktop/src/main/dataOwnerPath.ts';
import { ghostInstallApprovalToken } from '../../desktop/src/shared/ghost.ts';
import { installedGhostStoragePart } from '../../desktop/src/shared/pluginIdentity.ts';
import { commitVolatileAppSession } from '../../desktop/src/main/appSessionState.ts';
const require = createRequire(new URL('../../desktop/package.json', import.meta.url));
const JSZip = require('jszip');
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(require.resolve('@modelcontextprotocol/sdk/inMemory.js'));
const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-installed-plugins-e2e-')));
// This newly allocated directory is the fixture's only database target. Do not
// inherit the hosting app's formal-profile marker into its child test process.
const inheritedFormalProfile = process.env.XDT_OFFICIAL_SHARED_PROFILE;
delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
const ownerId = 'isolated-plugin-test';
configureHostOwner({ userDataDir: profile, ownerId });
configureGhostSnapshotProcess(createSnapshotProcess);
const root = (...parts) => ownerScopedPath(profile, ownerId, ...parts);
const credentials = await createCredentialStore({ userDataDir: profile, platform: 'linux', keyPromise: Promise.resolve(Buffer.alloc(16, 9)) });
let manager, runtime, gateway, mcpClient, mcpServer, database, nativeMcp, externalMcp;
const events = [];
const taskId = 'plugin-gateway-task';
const insertMessage = createHostMessageStore({ getOwner: getCurrentDbClientSnapshot, publish: event => events.push(event) });
const makeManager = () => new GhostManager({ getRootDir: () => root('cindy-brain'), getStateDir: () => root('ghost-install-state') });
const boot = async () => {
  manager = makeManager();
  runtime = await createHostPluginRuntime({ profileDir: profile, ownerId, manager, credentials,
    getSession: () => undefined, requestFileConfirmation: async () => ({ confirmed: false, reason: 'session_closed' }),
    getLoginEmail: () => 'fixture@example.invalid', appContext: () => ({ ok: true, context: { region: 'global', locale: 'en' } }), publish() {},
  });
  await runtime.reconcile();
  gateway = createHostPluginGateway({ runtime, profileDir: profile, ownerId, version: '0.1.999', credentials,
    fileConfirmation: new GhostGrantConfirmBridge({ broadcast: (channel, payload) => events.push({ channel, payload }) }),
    getSession: () => undefined,
    restoreSession: async () => { throw new Error('No Agent is running in this plugin-only fixture'); },
    requestHostPermission: async () => null,
    cards: {
      writeMessage: (owner, id, input, options) => { assert.equal(getCurrentDbClientSnapshot(), owner); return insertMessage(id, input, options); },
      publishMessage: (owner, sessionId, message) => { assert.equal(getCurrentDbClientSnapshot(), owner); events.push({ type: 'message_created', sessionId, message }); },
      request: async () => { throw new Error('An unexpected page permission was requested'); },
      send: async () => { throw new Error('An unexpected page message was sent'); },
    },
  });
  await gateway.refresh();
  const config = gateway.provider.toClaudeSdkConfig({ sessionId: taskId, sessionInstanceId: 'test-instance',
    agentKind: 'claude-code', workingDir: profile });
  mcpServer = config.instance;
  mcpClient = new Client({ name: 'installed-plugin-fixture', version: '1' });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverWire); await mcpClient.connect(clientWire);
};
const stop = async () => {
  await nativeMcp?.close(); nativeMcp = null;
  await mcpClient?.close(); await mcpServer?.close(); await gateway?.close();
  await runtime?.close(); runtime = null;
  manager?.disposeNotificationIndex();
};
try {
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId, isPackaged: false,
    drizzleDir: hostRuntimeLayout().drizzleDir, sqliteVecExtPath: hostRuntimeLayout().sqliteVecPath });
  database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  await database.drizzle.insert(sessions).values({ id: taskId, title: 'Fixture', workingDir: profile,
    source: 'desktop', status: 'active', createdAt: Date.now(), updatedAt: Date.now() });
  manager = makeManager();
  const zip = new JSZip();
  zip.file('ghost.json', JSON.stringify({ schemaVersion: 3, minCindyVersion: '0.1.61', id: 'installed-fixture',
    name: 'Installed fixture', kind: 'chip', version: '1.0.0', entry: 'main.js', settingsHtml: 'panel.html',
    tools: [{ name: 'test', description: 'isolated compatibility test', parameters: { type: 'object' } }], fs: true, library: true,
    mcpApps: { ui: { resources: [{ uri: 'ui://installed-fixture', file: 'panel.html' }],
      tools: { test: { resourceUri: 'ui://installed-fixture' } } } },
    node: { entry: 'worker.cjs', protocol: 'json-rpc-stdio' },
    network: { hosts: ['example.invalid'], secrets: [{ key: 'api_key', label: 'Fixture key', inject: { header: 'X-Api-Key', format: '{value}', hosts: ['example.invalid'] } }] },
  }));
  zip.file('main.js', `cindy.onHostMessage(async message => {
    if (message.type !== 'tool-call') return;
    let result;
    if (message.args.kind === 'node') result = await cindy.node.request({ method: 'echo', params: message.args.value });
    else result = await cindy.send(message.args.request);
    await cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result });
  });`);
  zip.file('panel.html', '<!doctype html><html><body>isolated plugin</body></html>');
  zip.file('worker.cjs', String.raw`require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { value: request.params, pid: process.pid } }) + '\n');
  });`);
  const archive = path.join(profile, 'fixture.cindy'); await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await manager.install(archive, { namespace: null, uiCapabilityApproved: true });
  assert.ok(result.ghost, JSON.stringify(result));
  const id = installedGhostStoragePart(result.ghost);
  const approval = ghostInstallApprovalToken(result.ghost.approval);
  manager.disposeNotificationIndex();
  await boot();
  const invoke = async args => {
    const wire = await mcpClient.callTool({ name: 'ghost_call', arguments: { ghost_id: id, tool: 'test', args } }, undefined, { timeout: 15_000 });
    const result = JSON.parse(wire.content.find(item => item.type === 'text').text);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
  };
  const panel = await runtime.openPage(id, '/panel.html');
  assert.deepEqual(await panel.evaluate(async () => {
    const kv = await fetch('/kv', { method: 'PUT', body: JSON.stringify({ saved: 'before restart' }) });
    const secret = await fetch('/secrets/api_key', { method: 'PUT', body: JSON.stringify({ value: 'synthetic-encrypted-test-value' }) });
    return { kv: kv.status, secret: secret.status };
  }), { kv: 204, secret: 204 });
  assert.equal(runtime.secret.readGhostSecret(id, 'api_key'), 'synthetic-encrypted-test-value');
  const first = await invoke({ kind: 'node', value: 'roundtrip' });
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.result.value, 'roundtrip');
  // An existing custom MCP row must reach the same Host Apps facade as Desktop,
  // with its encrypted headers kept out of the CLI's public configuration.
  externalMcp = await startMockAppServer();
  const customStore = createCustomMcpStore({ getDbClient: () => database,
    credentials: { ...credentials, assertAvailable: runtime.assertCurrent } });
  await customStore.createCustomMcpServer({ id: 'external-fixture', name: 'External fixture',
    transport: 'http', url: externalMcp.url, headers: { 'X-Fixture-Key': 'synthetic-custom-header' } });
  const customRows = await opened.db.prepare('SELECT headers FROM custom_mcp_servers').all();
  assert.equal(JSON.stringify(customRows).includes('synthetic-custom-header'), false);
  const providers = await gateway.prepareMcpProviders([gateway.provider]);
  const externalProvider = providers.find(provider => provider.name === 'external-fixture');
  assert.ok(externalProvider, 'persisted custom MCP is included in the actual Agent provider array');
  const externalConfig = externalProvider.toClaudeSdkConfig({ sessionId: taskId,
    sessionInstanceId: 'external-fixture-instance', agentKind: 'claude-code', workingDir: profile });
  assert.equal(externalConfig.type, 'sdk');
  const externalClient = new Client({ name: 'custom-fixture', version: '1' });
  const [externalClientWire, externalServerWire] = InMemoryTransport.createLinkedPair();
  try {
    await externalConfig.instance.connect(externalServerWire); await externalClient.connect(externalClientWire);
    const reply = await externalClient.callTool({ name: 'model_only', arguments: {} });
    assert.equal(reply.content[0].text, 'model only');
  } finally { await externalClient.close(); await externalConfig.instance.close(); }
  // Exercise the very HTTP transports passed to the native agents, including
  // task/instance identity and token retirement. This is transport integration,
  // not a real model invocation or an OS credential test.
  nativeMcp = createHostMcpRuntime({ appServerIds: gateway.appServerIds, getRemoteMcpBridgeToken: () => null });
  const codexMcp = await nativeMcp.codexDeps.prepareCodexExtraSpawnConfig(providers, {});
  nativeMcp.codexDeps.registerCodexMcpThreadContext({ threadId: 'fixture-thread', sessionId: taskId,
    sessionInstanceId: 'codex-fixture-instance', workingDir: profile, vendorOptions: {} });
  const codexUrl = new URL(codexMcp.buildSessionMcpConfig('codex-fixture-instance')['mcp_servers.cindy.url']);
  const piMcp = await nativeMcp.preparePiMcpBridge(providers, createMakerLogger('fixture-mcp'), {
    sessionId: taskId, sessionInstanceId: 'pi-fixture-instance', workingDir: profile, vendorOptions: {},
  });
  const piServer = piMcp.mcpBridge.servers.find(server => server.name === 'cindy');
  assert.ok(piServer);
  for (const [engine, url, token, meta] of [
    ['codex', codexUrl, codexMcp.extraEnv.LIZI_MCP_TOKEN, { threadId: 'fixture-thread' }],
    ['pi', new URL(piServer.url), piMcp.mcpBridge.token, undefined],
  ]) {
    const client = new Client({ name: `${engine}-transport-fixture`, version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const wire = await client.callTool({ name: 'ghost_call', arguments: { ghost_id: id, tool: 'test',
        args: { kind: 'node', value: engine } }, ...(meta ? { _meta: meta } : {}) });
      const answer = JSON.parse(wire.content.find(item => item.type === 'text').text);
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.equal(answer.result.result.value, engine);
    } finally { await client.close(); }
  }
  nativeMcp.codexDeps.unregisterCodexMcpThreadContext('fixture-thread', 'codex-fixture-instance');
  piMcp.disposeSessionCtx();
  const retired = await fetch(piServer.url, { method: 'POST', headers: { authorization: `Bearer ${piMcp.mcpBridge.token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }) });
  assert.equal(retired.status, 401, 'retired Pi task cannot reuse its token');
  const persistedCards = await database.drizzle.select().from(messages);
  const card = persistedCards.find(row => JSON.parse(row.agentMeta ?? '{}').mcpApp);
  assert.ok(card, 'the real gateway publishes a durable App card for the completed tool');
  assert.ok(JSON.parse(card.content).mcpApp.result, 'pending card becomes completed without rerunning the tool');
  const document = await gateway.invoke('device:test-phone', taskId, { op: 'open', clientId: card.clientId, context: {} });
  assert.ok(document.viewId);
  await assert.rejects(gateway.invoke('device:other-phone', taskId, { op: 'poll', viewId: document.viewId }), /MCP_APP_/);
  await gateway.releaseCaller('device:test-phone');
  await assert.rejects(gateway.invoke('device:test-phone', taskId, { op: 'poll', viewId: document.viewId }), /MCP_APP_/);
  const write = await invoke({ request: { type: 'library-request', op: 'write', path: 'saved.txt', content: 'library content' } });
  assert.equal(write.ok, true, JSON.stringify(write));
  assert.equal((await invoke({ request: { type: 'library-request', op: 'db.open', dbPath: 'library.db' } })).ok, true);
  const sql = await invoke({ request: { type: 'library-request', op: 'db.exec', dbPath: 'library.db', sql: 'CREATE TABLE items (value TEXT)' } });
  assert.equal(sql.ok, true, JSON.stringify(sql));
  assert.equal((await invoke({ request: { type: 'library-request', op: 'db.exec', dbPath: 'library.db', sql: "INSERT INTO items VALUES ('persistent row')" } })).ok, true);
  const data = await invoke({ request: { type: 'fs-request', op: 'write', root: 'data', path: 'private.txt', content: 'private content' } });
  assert.equal(data.ok, true, JSON.stringify(data));
  const denied = await invoke({ request: { type: 'fs-request', op: 'write', root: 'workdir', path: 'unauthorized.txt', content: 'denied', callId: 'unregistered' } });
  assert.equal(denied.ok, false);
  await stop();
  assert.equal(panel.isClosed(), true);
  assert.throws(() => process.kill(first.result.pid, 0), { code: 'ESRCH' });
  manager.disposeNotificationIndex();
  await boot();
  assert.equal(ghostInstallApprovalToken((await runtime.list())[0].approval), approval);
  assert.equal(runtime.secret.readGhostSecret(id, 'api_key'), 'synthetic-encrypted-test-value');
  const reopened = await runtime.openPage(id, '/panel.html');
  assert.deepEqual(await reopened.evaluate(async () => (await fetch('/kv')).json()), { saved: 'before restart' });
  const read = await invoke({ request: { type: 'library-request', op: 'read', path: 'saved.txt' } });
  assert.equal(read.content, 'library content', JSON.stringify(read));
  assert.equal((await invoke({ request: { type: 'library-request', op: 'db.open', dbPath: 'library.db' } })).ok, true);
  const rows = await invoke({ request: { type: 'library-request', op: 'db.exec', dbPath: 'library.db', sql: 'SELECT value FROM items' } });
  assert.equal(rows.ok, true, JSON.stringify(rows));
  assert.deepEqual(rows.rows, [{ value: 'persistent row' }]);
  const readData = await invoke({ request: { type: 'fs-request', op: 'read', root: 'data', path: 'private.txt' } });
  assert.equal(readData.content, 'private content', JSON.stringify(readData));
  assert.equal((await runtime.setEnabled(id, false, approval)).ok, true);
  assert.equal(reopened.isClosed(), true);
  assert.equal((await runtime.callTool({ ghostId: id, tool: 'test', args: {} })).ok, false);
  console.log('PASS installed plugin: Claude/Codex/Pi MCP transports; encrypted custom MCP through shared Apps facade; durable cards, isolated callers, receipts, browser-to-Node, encrypted state and Library survive restart, workdir denial, disable and child cleanup');
} finally {
  await externalMcp?.close();
  await stop();
  if (database) { clearCurrentDbClient(database); await database.dispose(); }
  commitVolatileAppSession('signed-out', null, true);
  await fs.rm(profile, { recursive: true, force: true });
  if (inheritedFormalProfile === undefined) delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  else process.env.XDT_OFFICIAL_SHARED_PROFILE = inheritedFormalProfile;
}
