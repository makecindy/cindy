// Integration tier: real sandboxed Chromium, shared GhostRuntime and page API.
// Covers owner/installation revocation, cross-plugin storage, network denial and
// logic/panel separation; fake BrowserWindow tests cannot prove these boundaries.
// Run with an isolated browser binary, never a user's browser/profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHeadlessPluginSandbox } from '../src/plugins/chromium-sandbox.ts';
import { createGhostPageHandler } from '../../desktop/src/main/cindy-brain/runtime/ghostPageHandler.ts';
import { GhostRuntime } from '../../desktop/src/main/cindy-brain/runtime/GhostRuntime.ts';
import { GhostPipeDispatcher } from '../../desktop/src/main/cindy-brain/pipeDispatcher.ts';
import { createHostNodeRuntimeBroker } from '../src/plugins/node-process.ts';
import { installedGhostStoragePart } from '../../desktop/src/shared/pluginIdentity.ts';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-plugin-sandbox-e2e-'));
const bridgeSource = process.env.CINDY_TEST_BRIDGE_SOURCE
  ? await fs.readFile(process.env.CINDY_TEST_BRIDGE_SOURCE, 'utf8')
  : (await build({ entryPoints: [fileURLToPath(new URL('../../desktop/src/shared/ghostPageBridge.ts', import.meta.url))],
    write: false, bundle: true, platform: 'browser', format: 'iife', globalName: 'CindyPluginBridge' })).outputFiles[0].text;
let owner = 'isolated-owner-1';
const enabled = new Set(['alpha', 'beta']);
const kv = new Map();
const messages = [];
const installed = new Map();
const workerEntry = process.env.CINDY_TEST_PLUGIN_WORKER || path.join(dir, 'node-worker.cjs');
if (!process.env.CINDY_TEST_PLUGIN_WORKER) await build({
  entryPoints: [fileURLToPath(new URL('../src/plugins/node-worker.ts', import.meta.url))],
  outfile: workerEntry, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
});
const node = createHostNodeRuntimeBroker(workerEntry, { getGhost: id => installed.get(id) ?? null });
let dispatcher;
const sandboxPorts = {
  executablePath: process.env.CINDY_TEST_CHROMIUM,
  bridgeSource,
  ownerKey: () => owner,
  isCurrent: ghost => enabled.has(ghost.manifest.id),
  send: async (ghost, payload) => {
    const id = installedGhostStoragePart(ghost);
    if (payload?.type === 'node-request') return node.handleRequest(id, payload);
    if (payload?.type === 'tool-result') { dispatcher.handleToolResult(id, payload); return { ok: true }; }
    messages.push({ id: ghost.manifest.id, payload }); return { ok: true, result: payload };
  },
  pageHandler: (ghost, origin, isCurrent) => createGhostPageHandler({
    ghost, origin, isCurrent,
    ghostKvStore: {
      read: id => kv.get(id) ?? {}, write: (id, value) => kv.set(id, value),
      captureTarget: id => enabled.has(id) ? id : null, isTargetCurrent: id => enabled.has(id),
    },
    ghostWakeHandler: null, ghostAppContextProvider: null, ghostModelPickerProvider: null,
    ghostAgentModelsProvider: null, ghostMediaModelsProvider: null, ghostModelsHandler: null,
    ghostSecretsHandler: null, ghostOauthHandler: null, ghostConnectionsHandler: null,
    serveGhostMedia: async () => new Response(null, { status: 404 }),
    serveGhostLibraryFile: async () => new Response(null, { status: 404 }),
    serveGhostGallery: async () => Response.json([]), log: { error() {}, warn() {} },
  }),
};
const platform = createHeadlessPluginSandbox(sandboxPorts);
const runtime = new GhostRuntime({ adapter: platform.adapter,
  onStateChanged: (id, state) => dispatcher?.onRuntimeState(id, state),
});
dispatcher = new GhostPipeDispatcher({
  getGhost: id => installed.get(id) ?? null,
  runtimeStateOf: id => runtime.stateOf(id), spawn: ghost => runtime.spawnForTool(ghost),
  sendToGhost: platform.deliver,
  ownerScope: { capture: () => owner, isCurrent: value => value === owner, isStable: value => value === owner },
});
try {
  const ghosts = await Promise.all(['alpha', 'beta'].map(async id => {
    const root = path.join(dir, id); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'main.js'), `
      localStorage.setItem('logic', ${JSON.stringify(id)});
      const bus = new BroadcastChannel('same-plugin');
      bus.onmessage = event => bus.postMessage({ answer: event.data, plugin: ${JSON.stringify(id)} });
      cindy.onHostMessage(async message => {
        if (message.type === 'tool-call') {
          const result = await cindy.node.request({ method: 'echo', params: message.args });
          await cindy.send({ type: 'tool-result', callId: message.callId, ...result });
        } else await cindy.send({ delivered: message });
      });
      globalThis.pluginReady = true;
    `);
    await fs.writeFile(path.join(root, 'panel.html'), '<!doctype html><html><body>panel</body></html>');
    await fs.writeFile(path.join(root, 'worker.cjs'), String.raw`
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.method) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.params }) + '\n');
      });
    `);
    const ghost = { manifest: { id, version: '1.0.0', entry: 'main.js',
      tools: [{ name: 'echo', description: 'isolated fixture' }],
      node: { entry: 'worker.cjs', protocol: 'json-rpc-stdio' },
    }, dir: root, enabled: true };
    installed.set(installedGhostStoragePart(ghost), ghost);
    return ghost;
  }));
  const [alpha, beta] = ghosts;
  const executablePath = sandboxPorts.executablePath;
  sandboxPorts.executablePath = path.join(dir, 'missing-chromium');
  assert.equal((await runtime.spawn(alpha)).ok, false);
  sandboxPorts.executablePath = executablePath;
  for (const ghost of ghosts) assert.deepEqual(await runtime.spawn(ghost), { ok: true, state: 'running' });
  assert.deepEqual(await dispatcher.callGhostTool({ ghostId: installedGhostStoragePart(alpha), tool: 'echo', args: { message: '真实插件调用' } }),
    { ok: true, result: { message: '真实插件调用' } });
  const panel = await platform.openPage(alpha, '/panel.html');
  assert.deepEqual(await panel.evaluate(() => ({ cindy: typeof cindy, node: typeof process, require: typeof require, storage: localStorage.getItem('logic') })),
    { cindy: 'undefined', node: 'undefined', require: 'undefined', storage: 'alpha' });
  const reply = await panel.evaluate(() => new Promise(resolve => {
    const bus = new BroadcastChannel('same-plugin');
    bus.onmessage = event => { bus.close(); resolve(event.data); };
    bus.postMessage('hello');
  }));
  assert.deepEqual(reply, { answer: 'hello', plugin: 'alpha' });
  const other = await platform.openPage(beta, '/panel.html');
  assert.equal(await other.evaluate(() => localStorage.getItem('logic')), 'beta');
  assert.equal(await panel.evaluate(async () => {
    await fetch('/kv', { method: 'PUT', body: JSON.stringify({ saved: 7 }) }); return (await fetch('/kv')).status;
  }), 200);
  assert.deepEqual(kv.get(installedGhostStoragePart(alpha)), { saved: 7 });
  const foreign = new URL(other.url()).origin;
  assert.deepEqual(await panel.evaluate(async foreign => {
    const denied = async url => { try { await fetch(url); return false; } catch { return true; } };
    return Promise.all([denied('https://example.com/'), denied('http://127.0.0.1:1/'), denied(foreign + '/kv'), denied('file:///etc/passwd')]);
  }, foreign), [true, true, true, true]);
  assert.equal(await platform.deliver(installedGhostStoragePart(alpha), { test: 'one' }), true);
  assert.deepEqual(messages, [{ id: 'alpha', payload: { delivered: { test: 'one' } } }]);
  runtime.stop(installedGhostStoragePart(alpha));
  assert.equal(await platform.deliver(installedGhostStoragePart(alpha), {}), false);
  assert.equal(await panel.evaluate(() => localStorage.getItem('logic')), 'alpha');
  assert.equal((await runtime.spawn(alpha)).ok, true);
  enabled.delete('alpha');
  await platform.revokeStale();
  assert.equal(panel.isClosed(), true);
  assert.equal(other.isClosed(), false);
  owner = 'isolated-owner-2';
  await platform.revokeStale();
  assert.equal(other.isClosed(), true);
  console.log('PASS real Chromium + Node tool call: launch failure recovery, logic/panel isolation, shared per-plugin storage and BroadcastChannel, KV, network denial, delivery, stop/restart, disable and owner revocation');
} finally {
  runtime.destroyAll(); await platform.close();
  await Promise.all([...installed.keys()].map(id => node.stopAndWait(id))); node.destroyAll();
  await fs.rm(dir, { recursive: true, force: true });
}
