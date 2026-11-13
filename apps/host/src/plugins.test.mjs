import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { PassThrough } from 'node:stream';
import { serialize } from 'node:v8';
import { createPluginControlPipe } from '../../desktop/src/main/cindy-brain/nodeRuntimePipe.ts';
import { createHostNodeRuntimeBroker } from './plugins/node-process.ts';
import { HostTerminalService } from '../../desktop/src/main/terminal/hostTerminalService.ts';
import { GhostFsSlot } from '../../desktop/src/main/cindy-brain/fsSlot.ts';
import { HostStorageService } from '../../desktop/src/main/cindy-brain/storageService.ts';
import { createHostStorageProviders } from '../../desktop/src/main/cindy-brain/storageProviders.ts';
import { GhostHandoffStore } from '../../desktop/src/main/cindy-brain/handoffStore.ts';
import { createGhostKvStore } from '../../desktop/src/main/cindy-brain/ghostKvStore.ts';
import { defaultPtySpawn } from '../../desktop/src/main/terminal/ptyFactory.ts';
import { createHostToolService } from './agent/host-tools.ts';
import { createHostConfirmations } from './host-confirmations.ts';
import { createLiziMcpProviders } from '@cindy/mcps';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';

import { dataOwnerStorageKey } from '../../desktop/src/main/dataOwnerPath.ts';
import { listInstalledPlugins } from './plugins.mjs';
import { Session } from '../../../packages/maker-core/src/session.ts';
import { createTerminalToolExecutor } from '../../desktop/src/main/terminal/terminalToolAccess.ts';

// #9825 C, integration: use a real Session.close and real child PTY through the
// shared task tool adapter. Prior plugin-stop cases did not close a task runtime.
test('closing the actual task Session ends its managed child process', async t => {
  const workDir = tempProfile(t);
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const session = new Session({ id: 'managed-task', agentKind: 'pi', workDir, capabilities: {}, logger,
    handle: { setInteractionResolver() {}, isTurnRunning: () => false, close: async () => {} }, turnStallMs: 0 });
  let ready, exit;
  const started = new Promise(resolve => { ready = resolve; });
  const exited = new Promise(resolve => { exit = resolve; });
  const terminal = new HostTerminalService({ spawn: (...args) => {
    const pty = defaultPtySpawn(...args);
    let output = '';
    pty.onData(data => { output += data; if (output.includes('task-child-ready')) ready(); });
    pty.onExit(exit);
    return pty;
  } });
  const executor = createTerminalToolExecutor({ service: terminal,
    owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }), pending: () => false,
    pluginCall: () => undefined, getGhost: () => null, getSession: () => session,
    pluginDirectory: () => workDir });
  t.after(async () => { terminal.disposeScoped(); await session.close(); });
  const { job } = await executor.call({ agentKind: 'pi', workingDir: workDir, sessionId: session.id,
    sessionInstanceId: session.instanceId }, 'terminal_start', {
    program: { command: process.execPath, args: ['-e', "process.stdout.write('task-child-ready\\n');process.stdin.resume()"] },
  });
  try {
    await started;
    assert.equal(terminal.manager.has(job.id), true);
    await session.close();
    assert.equal(terminal.manager.has(job.id), false, 'Session.close must remove and terminate its exact managed PTY');
    await exited;
  } finally { terminal.disposeScoped(); await exited; }
});

// Rebase #9496 onto #9621: execute the real gateway's registered page-tool
// callback with process/database boundaries injected. A null task must not be
// restored, while task-bound calls must retain their original source context.
test('page tools accept a null task without changing task-bound context', async () => {
  let runPageTool;
  const contexts = [], restored = [];
  const session = { id: 'task', instanceId: 'instance', agentKind: 'codex', workDir: '/workspace' };
  const boundaries = {
    createMcpAppsRuntime: () => ({ setMcpAppsHost() {} }),
    getCurrentDbClientSnapshot: () => undefined,
    createCustomMcpStore: () => ({}), createCustomMcpRegistry: () => ({}),
    createAppServerProxyFactory: () => () => undefined,
    createPluginAppRegistry: () => ({ setPluginPageToolRunner(runner) { runPageTool = runner; } }),
    dataOwnerStorageKey: value => value,
    createMcpAppRevisionKeyStore: () => ({ get: () => 'revision' }),
    createMcpAppsService: () => ({ host: {} }),
    createPluginAppPublisher: () => () => undefined,
    createGhostAttachmentResolver: () => () => undefined,
    createImageCacheStore: () => ({}), hostChatAttachments: {},
    createGhostGateway: () => ({ setPageControlGhostProvider() {}, getCindyGhostsMcpDeps(context) {
      contexts.push(context);
      return { callGhostTool: async () => ({ ok: true, result: { content: [{ type: 'text', text: 'delivered' }] } }) };
    } }),
    pluginAppResult: value => value,
  };
  const built = await build({ entryPoints: [fileURLToPath(new URL('./plugins/gateway.ts', import.meta.url))],
    bundle: false, write: false, platform: 'node', format: 'cjs', target: 'node22' });
  const localRequire = createRequire(import.meta.url), gatewayModule = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(
    name => name.startsWith('node:') ? localRequire(name) : boundaries, gatewayModule, gatewayModule.exports);
  gatewayModule.exports.createHostPluginGateway({
    runtime: { current: () => true, assertCurrent() {}, authorization: { i18n: {} } },
    profileDir: '/unused', ownerId: 'owner', version: 'test', credentials: {}, cards: {},
    restoreSession: async id => { assert.equal(id, session.id); restored.push(id); return session; },
  });
  for (const sessionId of [null, session.id]) {
    const result = await runPageTool({ sessionId, instance: 'plugin', tool: 'read', assertCurrent: async () => {} },
      {}, new AbortController().signal);
    assert.deepEqual(result, { content: [{ type: 'text', text: 'delivered' }] });
  }
  assert.deepEqual(restored, [session.id]);
  assert.deepEqual(contexts, [undefined, { sessionId: session.id, sessionInstanceId: session.instanceId,
    agentKind: session.agentKind, workingDir: session.workDir }]);
});

function tempProfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-plugins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('lists canonical plugin instances with manifest identity', (t) => {
  const userDataDir = tempProfile(t);
  const ownerId = 'owner-1';
  const ownerRoot = path.join(userDataDir, 'owners', dataOwnerStorageKey(ownerId));
  fs.mkdirSync(path.join(ownerRoot, 'ghost-install-state'), { recursive: true });
  fs.mkdirSync(path.join(ownerRoot, 'cindy-brain/_ns/_root/demo'), { recursive: true });
  fs.writeFileSync(path.join(ownerRoot, 'cindy-brain/_ns/_root/demo/ghost.json'),
    JSON.stringify({ name: 'Demo plugin', version: '1.2.3' }));
  fs.writeFileSync(path.join(ownerRoot, 'ghost-install-state/plugin-instances.v2.json'), JSON.stringify({
    schemaVersion: 2,
    instances: {
      _root__demo: {
        instanceKey: '_root__demo', contentRelId: 'cindy-brain/_ns/_root/demo',
        ghostId: 'demo', namespace: null, source: 'market', active: true,
      },
    },
  }));

  const result = listInstalledPlugins(userDataDir, ownerId);
  assert.deepEqual(result.plugins, [{
    instanceKey: '_root__demo', id: 'demo', name: 'Demo plugin', version: '1.2.3',
    namespace: null, source: 'market', active: true,
  }]);
  assert.equal(result.namespace, 'canonical');
  assert.equal(result.legacyNamespacePresent, false);
});

test('reports legacy namespaces without reading them', (t) => {
  const userDataDir = tempProfile(t);
  fs.mkdirSync(path.join(userDataDir, 'owners', 'raw-owner-id'), { recursive: true });
  const result = listInstalledPlugins(userDataDir, 'owner-1');
  assert.deepEqual(result.plugins, []);
  assert.equal(result.legacyNamespacePresent, true);
});

test('a missing profile yields an empty list rather than an error', (t) => {
  const userDataDir = tempProfile(t);
  assert.deepEqual(listInstalledPlugins(userDataDir, 'nobody'), {
    plugins: [], namespace: 'canonical', legacyNamespacePresent: false,
  });
});

// Integration: the Node launcher must preserve the production broker's stdio,
// private child-spawn bridge, environment filtering and complete stop. Existing
// broker tests use fake OS processes and cannot cover this platform adapter.
test('runs and reaps real plugin workers through the common broker', async t => {
  const dir = tempProfile(t);
  const workerEntry = process.env.CINDY_TEST_PLUGIN_WORKER || path.join(dir, 'bootstrap.cjs');
  if (!process.env.CINDY_TEST_PLUGIN_WORKER) await build({
    entryPoints: [fileURLToPath(new URL('./plugins/node-worker.ts', import.meta.url))],
    outfile: workerEntry, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    plugins: [{ name: 'node-only', setup(builder) {
      builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => { throw new Error('Electron is not a Node plugin dependency'); });
    } }],
  });
  fs.writeFileSync(path.join(dir, 'worker.cjs'), String.raw`
    require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
      const request = JSON.parse(line);
      if (!request.method) return;
      let result;
      if (request.method === 'child') {
        const child = await globalThis.__CINDY_NODE__.spawnEntry('child.cjs', ['input']);
        let output = '';
        child.stdout.on('data', data => { output += data; });
        await new Promise(resolve => child.once('close', resolve));
        result = JSON.parse(output);
      } else if (request.method === 'terminal') {
        const response = await cindy.host.call(request.params.server || 'cindy_helper', request.params.tool, request.params.args);
        result = JSON.parse(response.content.find(item => item.type === 'text').text);
      } else result = { value: request.params.value, pid: process.pid,
        filtered: process.env.CINDY_TEST_PRIVATE_HOST_VALUE === undefined,
        privatePort: process.parentPort === undefined && process.send === undefined };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
  `);
  fs.writeFileSync(path.join(dir, 'child.cjs'),
    `process.stdout.write(JSON.stringify({ arg: process.argv[2], nestedSpawn: !!globalThis.__CINDY_NODE__ }));`);
  fs.writeFileSync(path.join(dir, 'terminal.cjs'), `
    process.stdout.write('managed-ready\\n');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      process.stdout.write(JSON.stringify({ line, filtered: process.env.CINDY_TEST_PRIVATE_HOST_VALUE === undefined }) + '\\n');
    });
  `);
  const previous = process.env.CINDY_TEST_PRIVATE_HOST_VALUE;
  process.env.CINDY_TEST_PRIVATE_HOST_VALUE = 'synthetic-secret-for-filter-test';
  t.after(() => { if (previous === undefined) delete process.env.CINDY_TEST_PRIVATE_HOST_VALUE;
    else process.env.CINDY_TEST_PRIVATE_HOST_VALUE = previous; });
  const ghost = { manifest: { id: 'test-node', name: 'Node fixture', version: '1.0.0', node: {
    entry: 'worker.cjs', protocol: 'json-rpc-stdio', entries: ['child.cjs'], childSpawn: true,
  }, agent: { hostTools: ['terminal', 'files', 'storage', 'browser', 'discovery'] } }, dir, enabled: true,
    namespace: null, namespaceState: 'confirmed',
    approval: { state: 'approved', revision: 'real-worker-fixture' }, approvedHostToolGroups: ['terminal', 'files', 'storage', 'browser', 'discovery'] };
  const receiverDir = path.join(dir, 'receiver'); fs.mkdirSync(receiverDir);
  fs.copyFileSync(path.join(dir, 'worker.cjs'), path.join(receiverDir, 'worker.cjs'));
  const receiver = { manifest: { id: 'test-receiver', name: 'Receiver fixture', version: '1.0.0',
    agent: { hostTools: ['storage'] }, node: { entry: 'worker.cjs', protocol: 'json-rpc-stdio' } },
    dir: receiverDir, enabled: true, namespace: null, namespaceState: 'confirmed',
    approval: { state: 'approved', revision: 'receiver-fixture' }, approvedHostToolGroups: ['storage'] };
  const getGhost = id => id === 'test-node' ? ghost : id === 'test-receiver' ? receiver : null;
  // Real PTY through the same Host service, gateway and registry. Only native
  // owner confirmation is acknowledged by the fixture; no App install is fabricated here.
  let readyResolve, echoResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const echo = new Promise(resolve => { echoResolve = resolve; });
  const terminalExits = new Map();
  const terminals = new HostTerminalService({ spawn: (...args) => {
    const pty = defaultPtySpawn(...args);
    let text = '';
    pty.onData(chunk => { text += chunk; if (text.includes('managed-ready')) readyResolve(); if (text.includes('"filtered":true')) echoResolve(); });
    terminalExits.set(pty.pid, new Promise(resolve => pty.onExit(resolve)));
    return pty;
  } });
  const owner = () => ({ dataOwnerId: 'fixture-owner', ownerGeneration: 1 });
  const directoryStat = fs.statSync(dir, { bigint: true });
  // Match the native pick issuer's realpath semantics, including Windows casing.
  const selectedDirectory = { ref: 'fixture-files', path: await fs.promises.realpath(dir), dev: directoryStat.dev.toString(), ino: directoryStat.ino.toString() };
  const fileService = new GhostFsSlot({ getGhost: () => ghost, ownerKey: () => 'fixture-owner:1', dataRootDir: () => dir,
    // Only the native-selection receipt is supplied by this fixture. Worker,
    // private control pipe, public gateway, shared registry and filesystem are real.
    resolvePickedDirectory: (id, ref) => id === 'test-node' && ref === selectedDirectory.ref ? selectedDirectory : null,
    callInfo: () => null, inFlightCallInfo: () => null, getSessionSnapshot: async () => null,
    requestWriteConfirm: async () => ({ confirmed: false, reason: 'cancelled' }), writeSaveDeposit: async () => null,
    log: { warn: (message, details) => t.diagnostic(`${message}: ${details.error}`) } });
  const handoff = new GhostHandoffStore({ root: () => path.join(dir, 'handoff') });
  const kv = createGhostKvStore({ getRootDir: () => path.join(dir, 'storage-kv') });
  const sharedValue = { title: 'shared business record', count: 2 };
  kv.write('test-node', { record: sharedValue });
  const database = { drizzle: {} }; setCurrentDbClient(database, 'fixture-owner');
  const confirmations = createHostConfirmations({ current: () => true });
  const disconnect = confirmations.connect('web:fixture', event => {
    if (event.channel === 'ghosts:confirm-request') queueMicrotask(() =>
      confirmations.resolve('web:fixture', 'confirm', event.payload.requestId, true));
    if (event.channel === 'ghosts:install-consent:request') queueMicrotask(() =>
      confirmations.resolve('web:fixture', 'install', event.payload.requestId, false));
    return true;
  });
  const storage = new HostStorageService({ ownerKey: () => 'fixture-owner:1', getGhost, handoff, listGhosts: () => [ghost, receiver],
    providers: createHostStorageProviders({ kv, files: fileService, library: null, handoff,
      media: { describe: async () => null, read: async () => new Response(null, { status: 404 }) } }),
    confirmShare: async (facts, current) => {
      assert.equal(facts.sourceId, 'test-node'); assert.equal(facts.targetId, 'test-receiver');
      assert.equal(facts.fileName, 'record.json');
      const answer = await confirmations.confirm({ ghostId: facts.sourceId, ghostName: facts.sourceName,
        body: `${facts.fileName} → ${facts.targetName}`, confirmText: null, cancelText: null, danger: false });
      return current() && answer;
    } });
  const hostTools = createHostToolService({ terminal: terminals, files: () => fileService, storage: () => storage,
    profileDir: dir, ownerId: 'fixture-owner', owner,
    getGhost, getSession: () => undefined, current: () => true, confirmations, t: key => key,
    manager: { approveTaskCapability: async () => { throw new Error('fixture group was already approved'); } },
  });
  // This fixture supplies a browser driver, as Desktop does. Node Host's default
  // assembly remains unsupported; Worker/FD/gateway/registry are the real path.
  const browserProviders = createLiziMcpProviders({ browser: { getRuntime: () => ({ call: async request =>
    ({ ok: true, action: request.action, data: { source: 'shared-browser-handler' } }) }) } });
  hostTools.providers.push(...browserProviders);
  hostTools.services.replace(hostTools.providers);
  const broker = createHostNodeRuntimeBroker(workerEntry, { getGhost,
    hostToolRequest: hostTools.request, onStopped: hostTools.stopPlugin });
  try {
    const first = await broker.handleRequest('test-node', { type: 'node-request', method: 'echo', params: { value: '你好' } });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.value, '你好');
    assert.equal(first.result.filtered, true);
    assert.equal(first.result.privatePort, true);
    const child = await broker.handleRequest('test-node', { type: 'node-request', method: 'child' });
    assert.equal(child.ok, true, JSON.stringify(child));
    assert.deepEqual(child.result, { arg: 'input', nestedSpawn: false });
    const browser = await broker.handleRequest('test-node', { type: 'node-request', method: 'terminal', params: {
      server: 'cindy_browser', tool: 'browser', args: { action: 'status' } } });
    assert.equal(browser.ok, true, JSON.stringify(browser));
    assert.equal(browser.result.ok, true, JSON.stringify(browser));
    assert.equal(browser.result.data.source, 'shared-browser-handler');
    ghost.approvedHostToolGroups = ghost.approvedHostToolGroups.filter(group => group !== 'browser');
    const unapprovedBrowser = await broker.handleRequest('test-node', { type: 'node-request', method: 'terminal', params: {
      server: 'cindy_browser', tool: 'browser', args: { action: 'status' } } });
    assert.equal(unapprovedBrowser.result.errorCode, 'PERMISSION_DENIED');
    const terminalCall = async (tool, args = {}) => {
      const result = await broker.handleRequest('test-node', { type: 'node-request', method: 'terminal', params: { tool, args } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.result.ok, true, JSON.stringify(result));
      return result.result;
    };
    const capabilities = await terminalCall('host_services');
    assert.equal(capabilities.scope, 'local');
    assert.equal(capabilities.services.find(service => service.group === 'terminal').available, true);
    assert.equal(capabilities.services.find(service => service.group === 'discovery').approved, true);
    assert.equal(capabilities.services.find(service => service.group === 'scheduler').available, false);
    assert.equal(capabilities.services.find(service => service.group === 'computer').available, false);
    // §21 integration: execute a real plugin's host.call across the private FD,
    // approval gateway and common service; the plugin never receives a path.
    const fileCall = (op, args = {}) => terminalCall('file_request', { op, directoryRef: selectedDirectory.ref, ...args });
    await fileCall('write', { path: 'exports/worker.txt', content: 'worker-selected-directory' });
    assert.equal((await fileCall('read', { path: 'exports/worker.txt' })).content, 'worker-selected-directory');
    assert.equal((await fileCall('list', { path: 'exports' })).entries[0].path, 'exports/worker.txt');
    const escaped = await broker.handleRequest('test-node', { type: 'node-request', method: 'terminal',
      params: { tool: 'file_request', args: { op: 'read', directoryRef: selectedDirectory.ref, path: '../outside.txt' } } });
    assert.equal(escaped.result.ok, false);
    await fileCall('delete', { path: 'exports/worker.txt' });
    assert.equal(fs.existsSync(path.join(dir, 'exports/worker.txt')), false);
    // §27 integration: two actual workers use the same provider interface and
    // real KV/handoff persistence. Native confirmation is acknowledged above.
    assert.deepEqual((await terminalCall('storage_request', { op: 'targets' })).targets,
      [{ id: 'test-receiver', name: 'Receiver fixture' }]);
    const share = await terminalCall('storage_request', { op: 'share', targetPluginId: 'test-receiver', source: { provider: 'kv', key: 'record' } });
    const copiedRef = share.files[0].ref;
    await terminalCall('storage_request', { op: 'call', provider: 'kv', request: { op: 'write', value: { record: { title: 'changed after sharing' } } } });
    const received = await broker.handleRequest('test-receiver', { type: 'node-request', method: 'terminal', params: {
      tool: 'storage_request', args: { op: 'call', provider: 'handoff', request: { op: 'read', ref: copiedRef } } } });
    assert.equal(received.ok, true, JSON.stringify(received));
    assert.equal(received.result.ok, true, JSON.stringify(received));
    assert.deepEqual(JSON.parse(Buffer.from(received.result.base64, 'base64').toString()), sharedValue);
    const unowned = await broker.handleRequest('test-node', { type: 'node-request', method: 'terminal', params: {
      tool: 'storage_request', args: { op: 'call', provider: 'handoff', request: { op: 'read', ref: copiedRef } } } });
    assert.equal(unowned.result.ok, false, 'a target handoff ref never grants source access to target storage');
    const terminal = await terminalCall('terminal_start', { program: { command: process.execPath, args: [path.join(dir, 'terminal.cjs')] } });
    await ready;
    const output = await terminalCall('terminal_read', { id: terminal.job.id });
    assert.match(output.chunks.map(chunk => chunk.data).join(''), /managed-ready/);
    // xterm sends CR for Enter; Windows cooked input does not submit on LF.
    await terminalCall('terminal_write', { id: terminal.job.id, data: 'managed-input\r' });
    await echo;
    const resumed = await terminalCall('terminal_read', { id: terminal.job.id, cursor: output.cursor, generation: output.generation });
    assert.match(resumed.chunks.map(chunk => chunk.data).join(''), /managed-input/);
    assert.match(resumed.chunks.map(chunk => chunk.data).join(''), /"filtered":true/);
    assert.equal((await terminalCall('terminal_list')).jobs[0].id, terminal.job.id);
    await terminalCall('terminal_stop', { id: terminal.job.id });
    await terminalExits.get(terminal.job.pid);
    assert.equal((await terminalCall('terminal_list')).jobs[0].status, 'exited');
    await terminalCall('terminal_forget', { id: terminal.job.id });
    assert.deepEqual((await terminalCall('terminal_list')).jobs, []);
    const background = await terminalCall('terminal_start', { program: { command: process.execPath, args: [path.join(dir, 'terminal.cjs')] } });
    await broker.stopAndWait('test-node');
    await terminalExits.get(background.job.pid);
    assert.equal(terminals.manager.has(background.job.id), false);
    assert.throws(() => process.kill(first.result.pid, 0), { code: 'ESRCH' });
    ghost.enabled = false;
    assert.equal((await broker.handleRequest('test-node', { type: 'node-request', method: 'echo' })).ok, false);
  } finally {
    fileService.disposeAll();
    disconnect(); confirmations.close(); hostTools.close(); clearCurrentDbClient(database);
    await broker.stopAndWait('test-node');
    await broker.stopAndWait('test-receiver');
    broker.destroyAll();
  }
});

// Unit: private IPC must decode arbitrary OS fragmentation and settle pending
// broker calls on abrupt descriptor loss. Real-worker happy paths above cannot
// deterministically produce truncated/invalid frames or a close without end.
test('plugin control pipe preserves fragmented binary frames and reports abrupt close once', async () => {
  const stream = new PassThrough();
  const messages = [];
  let failures = 0;
  const pipe = createPluginControlPipe(stream, message => messages.push(message), () => failures++);
  const payloads = [{ text: '你好', bytes: new Uint8Array([0, 255]) }, { value: 2 }];
  const frames = payloads.map(value => {
    const body = serialize(value);
    const frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame;
  });
  const wire = Buffer.concat(frames);
  for (const [start, end] of [[0, 1], [1, 3], [3, 7], [7, wire.length]]) stream.write(wire.subarray(start, end));
  assert.deepEqual(messages, payloads);
  stream.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failures, 1);
  assert.throws(() => pipe.send({ ignored: true }), /closed/);
  pipe.dispose();
  assert.equal(failures, 1);
});

test('plugin control pipe rejects invalid frame lengths and payloads before delivery', async () => {
  for (const frame of [Buffer.alloc(4), Buffer.from([255, 255, 255, 255]), Buffer.from([0, 0, 0, 1, 0])]) {
    const stream = new PassThrough();
    let failures = 0, delivered = false;
    const pipe = createPluginControlPipe(stream, () => { delivered = true; }, () => failures++);
    stream.write(frame);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failures, 1); assert.equal(delivered, false);
    pipe.dispose();
  }
});
