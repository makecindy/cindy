import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PassThrough } from 'node:stream';
import { serialize } from 'node:v8';
import { createPluginControlPipe } from '../../desktop/src/main/cindy-brain/nodeRuntimePipe.ts';
import { createHostNodeRuntimeBroker } from './plugins/node-process.ts';

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
      } else result = { value: request.params.value, pid: process.pid,
        filtered: process.env.CINDY_TEST_PRIVATE_HOST_VALUE === undefined,
        privatePort: process.parentPort === undefined && process.send === undefined };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
  `);
  fs.writeFileSync(path.join(dir, 'child.cjs'),
    `process.stdout.write(JSON.stringify({ arg: process.argv[2], nestedSpawn: !!globalThis.__CINDY_NODE__ }));`);
  const previous = process.env.CINDY_TEST_PRIVATE_HOST_VALUE;
  process.env.CINDY_TEST_PRIVATE_HOST_VALUE = 'synthetic-secret-for-filter-test';
  t.after(() => { if (previous === undefined) delete process.env.CINDY_TEST_PRIVATE_HOST_VALUE;
    else process.env.CINDY_TEST_PRIVATE_HOST_VALUE = previous; });
  const ghost = { manifest: { id: 'test-node', version: '1.0.0', node: {
    entry: 'worker.cjs', protocol: 'json-rpc-stdio', entries: ['child.cjs'], childSpawn: true,
  } }, dir, enabled: true };
  const broker = createHostNodeRuntimeBroker(workerEntry, { getGhost: () => ghost });
  try {
    const first = await broker.handleRequest('test-node', { type: 'node-request', method: 'echo', params: { value: '你好' } });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.result.value, '你好');
    assert.equal(first.result.filtered, true);
    assert.equal(first.result.privatePort, true);
    const child = await broker.handleRequest('test-node', { type: 'node-request', method: 'child' });
    assert.equal(child.ok, true, JSON.stringify(child));
    assert.deepEqual(child.result, { arg: 'input', nestedSpawn: false });
    await broker.stopAndWait('test-node');
    assert.throws(() => process.kill(first.result.pid, 0), { code: 'ESRCH' });
    ghost.enabled = false;
    assert.equal((await broker.handleRequest('test-node', { type: 'node-request', method: 'echo' })).ok, false);
  } finally { await broker.stopAndWait('test-node'); broker.destroyAll(); }
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
