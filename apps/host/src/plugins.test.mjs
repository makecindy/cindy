import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PassThrough } from 'node:stream';
import { serialize } from 'node:v8';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createPluginControlPipe } from '../../desktop/src/main/cindy-brain/nodeRuntimePipe.ts';
import { GhostNetworkSlot } from '../../desktop/src/main/cindy-brain/networkSlot.ts';
import { GhostOauthAccountManager } from '../../desktop/src/main/cindy-brain/ghostOauthAccounts.ts';
import { createHostNodeRuntimeBroker } from './plugins/node-process.ts';
import { HostTerminalService } from '../../desktop/src/main/terminal/hostTerminalService.ts';
import { defaultPtySpawn } from '../../desktop/src/main/terminal/ptyFactory.ts';
import { createHostToolService } from './agent/host-tools.ts';
import { createHostConfirmations } from './host-confirmations.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';

import { dataOwnerStorageKey } from '../../desktop/src/main/dataOwnerPath.ts';
import { listInstalledPlugins } from './plugins.mjs';

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
  const http = createServer((request, response) => {
    if (request.url === '/account') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ authorized: request.headers.authorization === 'Bearer synthetic-host-only-access' }));
    } else { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: ready\n\n'); }
  });
  const websocket = new WebSocketServer({ server: http });
  websocket.on('connection', socket => socket.on('message', (bytes, binary) => socket.send(bytes, { binary })));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = http.address().port;
  t.after(async () => {
    for (const client of websocket.clients) client.terminate();
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  });
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
      } else if (request.method === 'network') {
        const stream = await cindy.fetch({ url: request.params.http + '/events', as: 'stream' });
        if (!stream.ok) throw new Error(JSON.stringify(stream));
        const first = await cindy.network.read({ connectionId: stream.connectionId, waitMs: 1000 });
        await cindy.network.close({ connectionId: stream.connectionId });
        const socket = await cindy.network.open({ url: request.params.ws + '/echo' });
        if (!socket.ok) throw new Error(JSON.stringify(socket));
        await cindy.network.send({ connectionId: socket.connectionId, data: 'plugin-frame' });
        const echoed = await cindy.network.read({ connectionId: socket.connectionId, waitMs: 1000 });
        await cindy.network.close({ connectionId: socket.connectionId });
        result = { status: stream.status, first, echoed };
      } else if (request.method === 'account') {
        const response = await cindy.fetch({ url: 'https://api.example.test/account' });
        result = { response, receivedSecrets: !!request.cindy?.secrets };
      } else if (request.method === 'terminal') {
        const response = await cindy.host.call('cindy_helper', request.params.tool, request.params.args);
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
    secretBindings: [{ key: 'raw_account', label: 'Account', oauthSecret: 'account', methods: ['raw-account'] }],
  }, agent: { hostTools: ['terminal'] }, network: { hosts: ['api.example.test', 'http://127.0.0.1:' + port, 'ws://127.0.0.1:' + port],
    secrets: [{ key: 'account', label: 'Account', source: 'oauth', inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.example.test'] },
      oauth: { authorizeUrl: 'https://accounts.example.test/authorize', tokenUrl: 'https://accounts.example.test/token', scopes: ['read'], clientId: 'fixture-client' } }] } }, dir, enabled: true,
    approval: { state: 'approved', revision: 'real-worker-fixture' }, approvedHostToolGroups: ['terminal'] };
  const original = { ...ghost, manifest: { ...ghost.manifest, id: 'source-account' } };
  const values = new Map([
    ['source-account:account-client-id', 'fixture-client'],
    ['source-account:account-accounts', JSON.stringify({ defaultAccountId: 'original', accounts: [{ id: 'original', label: 'demo@example.test', status: 'connected', createdAt: 1 }] })],
    ['source-account:account-rt-original', 'synthetic-source-refresh'],
  ]);
  const oauth = new GhostOauthAccountManager({
    vault: { read: (id, key) => values.get(id + ':' + key) ?? null, store: (id, key, value) => { values.set(id + ':' + key, value); return true; }, remove: (id, key) => values.delete(id + ':' + key) },
    connectionSources: () => [ghost, original].map(item => ({ instanceKey: item.manifest.id, name: item.manifest.id, manifest: item.manifest })),
    confirmAccountReuse: async () => true, openExternal: () => { throw new Error('reuse must not log in again'); },
    fetchImpl: async () => Response.json({ access_token: 'synthetic-host-only-access', token_type: 'Bearer', expires_in: 3600 }),
  });
  assert.equal((await oauth.reuseAccount('test-node', 'account', ghost.manifest.network.secrets[0].oauth,
    { instanceKey: 'source-account', secretKey: 'account', accountId: 'original' })).ok, true);
  const network = new GhostNetworkSlot({ getGhost: () => ghost, readSecret: () => null, getLoginEmail: () => null,
    // Deterministic transport double: synthetic HTTPS origin reaches this real
    // loopback server. This verifies Host injection, not TLS/DNS behavior.
    fetchImpl: (url, init) => fetch(url === 'https://api.example.test/account' ? 'http://127.0.0.1:' + port + '/account' : url, init),
    fetchPublicImpl: async () => { throw new Error('undeclared request'); },
    oauthTokens: { getFreshAccessToken: (...args) => oauth.getFreshAccessToken(...args), invalidateAccessToken: (...args) => oauth.invalidateAccessToken(...args) },
    readGhostMedia: async () => null, takeDirDeposit: () => null, writeSaveDeposit: async () => null,
    saveGhostMedia: async () => { throw new Error('media not used'); }, isSupportedMediaMime: () => false });
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
  const database = { drizzle: {} }; setCurrentDbClient(database, 'fixture-owner');
  const confirmations = createHostConfirmations({ current: () => true });
  const disconnect = confirmations.connect('web:fixture', event => {
    if (event.channel === 'ghosts:confirm-request') queueMicrotask(() =>
      confirmations.resolve('web:fixture', 'confirm', event.payload.requestId, true));
    return true;
  });
  const hostTools = createHostToolService({ terminal: terminals, profileDir: dir, ownerId: 'fixture-owner', owner,
    getGhost: () => ghost, getSession: () => undefined, current: () => true, confirmations, t: key => key,
    manager: { approveTaskCapability: async () => { throw new Error('fixture group was already approved'); } },
  });
  const broker = createHostNodeRuntimeBroker(workerEntry, { getGhost: () => ghost,
    hostToolRequest: hostTools.request, onStopped: hostTools.stopPlugin,
    resolveOauthSecret: (id, key, accountId) => oauth.getNodeAccessToken(id, key, ghost.manifest.network.secrets[0].oauth, accountId),
    networkRequest: (id, request) => request.op === 'fetch' ? network.handleFetchRequest(id, request) : network.handleNetworkRequest(id, request) });
  try {
    const first = await broker.handleRequest('test-node', { type: 'node-request', method: 'echo', params: { value: '你好' } });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.value, '你好');
    assert.equal(first.result.filtered, true);
    assert.equal(first.result.privatePort, true);
    const child = await broker.handleRequest('test-node', { type: 'node-request', method: 'child' });
    assert.equal(child.ok, true, JSON.stringify(child));
    assert.deepEqual(child.result, { arg: 'input', nestedSpawn: false });
    const connected = await broker.handleRequest('test-node', { type: 'node-request', method: 'network', params: { http: 'http://127.0.0.1:' + port, ws: 'ws://127.0.0.1:' + port } });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(connected.result.status, 200);
    assert.equal(connected.result.first.events[0].data, 'data: ready\n\n');
    assert.equal(connected.result.echoed.events[0].data, 'plugin-frame');
    const account = await broker.handleRequest('test-node', { type: 'node-request', method: 'account' });
    assert.equal(account.ok, true, JSON.stringify(account));
    assert.equal(account.result.response.ok, true);
    assert.equal(JSON.parse(account.result.response.body).authorized, true);
    assert.equal(account.result.receivedSecrets, false);
    assert.equal(JSON.stringify(account).includes('synthetic-host-only-access'), false);
    const raw = await broker.handleRequest('test-node', { type: 'node-request', method: 'raw-account' });
    assert.equal(raw.ok, false);
    assert.equal(raw.errorCode, 'HOST_INJECTION_REQUIRED');
    const terminalCall = async (tool, args = {}) => {
      const result = await broker.handleRequest('test-node', { type: 'node-request', method: 'terminal', params: { tool, args } });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.result.ok, true, JSON.stringify(result));
      return result.result;
    };
    const terminal = await terminalCall('terminal_start', { program: { command: process.execPath, args: [path.join(dir, 'terminal.cjs')] } });
    await ready;
    const output = await terminalCall('terminal_read', { id: terminal.job.id });
    assert.match(output.chunks.map(chunk => chunk.data).join(''), /managed-ready/);
    await terminalCall('terminal_write', { id: terminal.job.id, data: 'managed-input\n' });
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
    disconnect(); confirmations.close(); hostTools.close(); clearCurrentDbClient(database);
    await network.disposeAll(); await broker.stopAndWait('test-node'); broker.destroyAll();
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
