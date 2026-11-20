import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';

import { beginAppSessionBoundary, commitVolatileAppSession, LOCAL_DATA_OWNER_ID } from '../../../desktop/src/main/appSessionState.ts';
import { ownerScopedPath } from '../../../desktop/src/main/dataOwnerPath.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { configureGhostSnapshotProcess } from '../../../desktop/src/main/cindy-brain/ghostSnapshotCapability.ts';
import { GhostRuntime } from '../../../desktop/src/main/cindy-brain/runtime/GhostRuntime.ts';
import { installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.ts';
import { configureHostOwner } from '../agent/claude-auth.mjs';
import { createHostProfileCoexistenceMonitor } from '../agent/profile-coexistence.ts';
import { hostOutbound } from '../outbound.mjs';
import { createHostGhostManager } from '../plugins-installed.ts';
import { createSnapshotProcess } from '../snapshot-process.mjs';
import { lifoCleanup } from '../test-support/cleanup.mjs';
import { chromiumUnavailable, testChromiumExecutable } from '../test-support/hook-plugin-fixture.mjs';
import { prepareHostPluginAssets } from './assets.mjs';
import { createHeadlessPluginSandbox } from './chromium-sandbox.ts';
import { createHostPluginRuntime } from './runtime.ts';

const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const JSZip = require('jszip');
const holdMessage = 'HOST_PROFILE_IN_USE_BY_DESKTOP: fixture profile in use';
const held = { ok: false, errorCode: 'PRECONDITION_FAILED', message: holdMessage };
const executablePath = testChromiumExecutable();
const realPage = { skip: !executablePath && chromiumUnavailable, timeout: 20_000 };

// §3.2 integration. Use the installed-plugin Host assembly, the production
// gateway and genuine approval files. The earlier gateway-only tests cannot
// catch a changed owner/active target, restart, config route, or accepted
// upload. The first three cases substitute the browser API, no Chromium process.
// The last five require a dedicated headless Chromium and a temporary profile.
const logic = `
  cindy.onHostMessage(async message => {
    if (message.type === 'event') {
      const events = JSON.parse(localStorage.getItem('events') ?? '[]');
      events.push(message.data?.sessionId);
      localStorage.setItem('events', JSON.stringify(events));
      if (message.hookId) localStorage.setItem('hookId', message.hookId);
      return;
    }
    if (message.type !== 'tool-call') return;
    let result;
    if (message.args.request) result = await cindy.send({ ...message.args.request, callId: message.callId });
    else if (message.args.node) result = await cindy.node.request({
      method: message.args.node === 'pending' ? 'pending' : 'echo',
      params: message.args.marker,
    });
    else result = true;
    if (message.args.loseReceipt) {
      localStorage.setItem('staged', JSON.stringify(result));
      return;
    }
    await cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result });
  });
`;
const nodeWorker = String.raw`
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'pending') {
      require('node:fs').writeFileSync(request.params, 'started');
      return;
    }
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: process.pid }) + '\n');
  });
`;

async function fixture(t, { executable, resident = true, node = false } = {}) {
  const cleanup = lifoCleanup(t);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-plugin-pause-'));
  cleanup.after(() => fs.rm(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: null });
  commitVolatileAppSession('local', null, true);
  configureAppDataDir(path.join(profile, 'app-data'));
  configureGhostSnapshotProcess(createSnapshotProcess);
  const ownerId = LOCAL_DATA_OWNER_ID;
  const root = (...parts) => ownerScopedPath(profile, ownerId, ...parts);
  const manager = createHostGhostManager({ userDataDir: profile, ownerId });
  cleanup.after(() => manager.disposeNotificationIndex());
  const zip = new JSZip();
  zip.file('ghost.json', JSON.stringify({
    schemaVersion: 3, minCindyVersion: '0.1.61', id: 'pause-fixture',
    name: 'Pause fixture', kind: 'chip', version: '1.0.0', entry: 'main.js',
    settingsHtml: 'panel.html', ...(resident ? { launch: 'resident' } : {}),
    subscribe: { hooks: ['will-tool-call', 'did-tool-result'], topics: ['session'] },
    tools: [{ name: 'echo', description: 'synthetic tool', parameters: { type: 'object' } }],
    network: { hosts: ['example.invalid'] }, library: true, notify: true,
    ...(node ? { node: { entry: 'worker.cjs', protocol: 'json-rpc-stdio', lifecycle: 'resident' } } : {}),
  }));
  zip.file('main.js', logic);
  zip.file('panel.html', '<!doctype html><html><body>Isolation fixture</body></html>');
  if (node) zip.file('worker.cjs', nodeWorker);
  const archive = path.join(profile, 'pause.cindy');
  await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  const installed = await manager.install(archive, { namespace: null, uiCapabilityApproved: true });
  assert.ok(installed.ghost, JSON.stringify(installed));
  const id = installedGhostStoragePart(installed.ghost);
  const assets = executable ? { ...await prepareHostPluginAssets(), executablePath: executable }
    : { bridgeSource: '', executablePath: null, nodeWorker: '', libraryWorker: '', close: async () => {} };
  cleanup.after(() => assets.close());
  const pushes = [];
  const warnings = [];
  const terminalCleanup = [];
  const log = { trace() {}, debug() {}, info() {}, warn(message) { warnings.push(message); }, error() {}, fatal() {}, child() { return this; } };
  const runtime = await createHostPluginRuntime({
    profileDir: profile, ownerId, manager, assets, log,
    credentials: { read: () => null, write() {}, remove() {} },
    getLoginEmail: () => null, getSession: () => undefined, requestFileConfirmation: async () => false,
    modelRouteSources: () => ({ localViews: async () => [], localAgents: () => [] }),
    appContext: () => ({ ok: true, context: { region: 'global', locale: 'en' } }),
    onPluginStopped: id => terminalCleanup.push(id),
    publish: (channel, payload) => pushes.push({ channel, payload }),
  });
  cleanup.after(() => runtime.close());
  const gateway = runtime.taskPlugins.getGhostSubscriptionGateway();
  const call = args => runtime.callTool({ ghostId: id, tool: 'echo', args: args ?? {}, timeoutMs: 2_500 });
  const control = () => runtime.taskPlugins.screenGhostControlPoint('will-tool-call',
    { engine: 'pi', phase: 'call', sessionId: 'task', toolName: 'read', toolCallId: 'tool', input: {} },
    { pluginId: id, onFailure: 'block' });
  return { root, manager, runtime, id, gateway, call, control, pushes, warnings, terminalCleanup,
    hold: () => runtime.pauseForDesktop(holdMessage) };
}

function installBrowserSubstitute(t, { beforePage, beforeToolAnswer } = {}) {
  const pages = [];
  let contextCount = 0;
  let closeObserver;
  const received = [];
  t.mock.method(chromium, 'launch', async () => {
    const browser = {
      once() {}, isConnected: () => true, async close() {},
      async newContext() {
        contextCount++;
        return {
          once() {}, on() {}, route() {}, routeWebSocket() {}, async close() {}, browser: () => browser,
          async newPage() {
            await beforePage?.();
            let closed = false;
            let binding, loadUrl;
            const frame = { url: () => loadUrl };
            const page = {
              on() {}, isClosed: () => closed, mainFrame: () => frame, route() {},
              async close() { closed = true; closeObserver?.(); },
              exposeBinding(_name, handler) { binding = handler; },
              async goto(url) { loadUrl = url; },
              async addScriptTag() {},
              async evaluateHandle() {
                return { async evaluate(_deliver, envelope) {
                  received.push(envelope);
                  if (envelope.type === 'tool-call') {
                    const request = envelope.args.request;
                    const result = request ? await page.send('send', { ...request, callId: envelope.callId }) : true;
                    await beforeToolAnswer?.(result);
                    await page.send('send', { type: 'tool-result', callId: envelope.callId, ok: true, result });
                  }
                  return true;
                } };
              },
              send(kind, payload) { return binding({ page, frame }, kind, payload); },
            };
            pages.push(page);
            return page;
          },
        };
      },
    };
    return browser;
  });
  return { pages, received, contexts: () => contextCount, observeClose: observer => { closeObserver = observer; } };
}

async function filesIn(root) {
  const paths = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(await Promise.all(paths.filter(item => item.isFile()).map(async item => {
    const file = path.join(item.parentPath, item.name);
    return [path.relative(root, file), await fs.readFile(file, 'base64')];
  })));
}

test('Host pauses an approved install without changing receipt or KV, and restarts on demand in the same partition', async t => {
  const browser = installBrowserSubstitute(t);
  const f = await fixture(t, { resident: false });
  const kvFile = f.root('ghost-kv', f.id + '.json');
  await fs.mkdir(path.dirname(kvFile), { recursive: true });
  await fs.writeFile(kvFile, '{"saved":"before"}');
  const receipts = await filesIn(f.root('ghost-install-state'));
  assert.ok(Object.keys(receipts).length > 0);
  await f.runtime.reconcile();
  assert.equal(browser.pages.length, 0);
  assert.deepEqual(await f.call(), { ok: true, result: true });

  f.hold();
  assert.equal(browser.pages[0].isClosed(), true);
  assert.deepEqual(await f.call(), held);
  assert.equal(f.runtime.getGhost(f.id).enabled, true);
  await assert.rejects(f.runtime.openPage(f.id, 'panel.html'), { code: 'PRECONDITION_FAILED' });
  await f.runtime.resumeAfterDesktop();
  assert.equal(browser.pages.length, 1);
  assert.deepEqual(await f.call(), { ok: true, result: true });
  assert.equal(browser.contexts(), 1);
  assert.deepEqual(await filesIn(f.root('ghost-install-state')), receipts);
  assert.equal(await fs.readFile(kvFile, 'utf8'), '{"saved":"before"}');
});

test('Host drops held plugin notifications and observer events, then keeps the native block policy', async t => {
  const browser = installBrowserSubstitute(t);
  const f = await fixture(t);
  await f.runtime.reconcile();
  assert.equal((await f.call()).ok, true);
  const page = browser.pages[0];
  assert.equal((await page.send('send', { type: 'notify', text: 'before the hold' })).ok, true);
  assert.ok(f.pushes.some(push => push.channel === 'ghosts:notify'));
  f.pushes.length = 0;
  const installed = f.runtime.getGhost(f.id);
  browser.observeClose(() => f.gateway.publishIndexed([installed], 'session', 'did-session-switched', { sessionId: 'closing' }));
  for (let round = 0; round < 3; round++) {
    const pending = f.control();
    assert.equal(browser.received.at(-1)?.name, 'will-tool-call');
    f.hold();
    if (round === 0) {
      await assert.rejects(page.send('send', { type: 'notify', text: 'while held' }), { code: 'PRECONDITION_FAILED' });
      await assert.rejects(page.send('send', { type: 'host-tool-request', server: 'cindy_helper', tool: 'terminal_start' }),
        { code: 'PRECONDITION_FAILED' });
      assert.deepEqual(f.pushes, [], 'stopping a resident must not publish a plugin state notification');
      assert.deepEqual(f.terminalCleanup, [], 'pause preserves existing plugin terminals');
    }
    assert.equal((await pending).action, 'block');
    for (let turn = 0; turn < 4; turn++) assert.equal((await f.control()).action, 'block');
    f.gateway.publishIndexed([installed], 'session', 'did-session-switched', { sessionId: 'held' });
    await f.runtime.resumeAfterDesktop();
    assert.equal((await f.call()).ok, true);
  }
  browser.observeClose(undefined);
  f.gateway.publishIndexed([installed], 'session', 'did-session-switched', { sessionId: 'resumed' });
  assert.deepEqual(browser.received.filter(event => event.topic === 'session').map(event => event.data.sessionId), ['resumed']);
  assert.ok(f.pushes.every(push => push.channel !== 'ghosts:notify'));
  assert.equal(f.warnings.includes('ghost control point failed'), false);
});

function interruptibleUpload(t) {
  let admitUpload, finishUpload;
  let writes = 0;
  const admitted = new Promise(resolve => { admitUpload = resolve; });
  const finished = new Promise(resolve => { finishUpload = resolve; });
  const fakeFetch = async (_url, init) => {
    writes++;
    admitUpload();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { finishUpload(); reject(new Error('simulated disconnect after acceptance')); }, { once: true });
    });
  };
  t.mock.method(hostOutbound, 'guardedOutboundFetch', fakeFetch);
  t.mock.method(hostOutbound, 'outboundFetch', fakeFetch);
  return { admitted, finished, count: () => writes };
}

const externalUpload = { request: { type: 'fetch-request', url: 'https://example.invalid/upload', method: 'POST', body: 'synthetic' } };

// Same monitor as main.ts. Supply scan results and the completion of the input
// rebuild, while the installed plugin, its cleanup and both gates stay real.
function profileMonitor(t, f, beforeInputRelease = () => {}) {
  let desktops = [];
  let inputHeld = false;
  let rebuilt = 0;
  let refreshed = 0;
  const attempts = [];
  const plugins = {
    pauseForDesktop: f.runtime.pauseForDesktop,
    pluginPauseFailure: f.runtime.pluginPauseFailure,
    resumeAfterDesktop() {
      assert.equal(inputHeld, false);
      const attempt = f.runtime.resumeAfterDesktop();
      attempts.push(attempt);
      return attempt;
    },
  };
  const monitor = createHostProfileCoexistenceMonitor({
    scan: async () => desktops, registryDir: f.root('fixture-registry'), message: holdMessage,
    isCurrent: () => true, setState() {}, log: { warn() {} },
    getPlugins: () => plugins, refreshPlugins: async () => { refreshed++; },
    onInputReleased: () => { rebuilt++; },
    input: {
      isHeldForDesktop: () => inputHeld,
      holdForDesktop() { inputHeld = true; },
      async releaseDesktopHold() { beforeInputRelease(); inputHeld = false; return true; },
    },
  });
  t.after(() => monitor.stop());
  return {
    async scan(pids) {
      desktops = pids;
      const count = attempts.length;
      await monitor.scanNow();
      return await Promise.all(attempts.slice(count));
    },
    rebuilt: () => rebuilt, refreshed: () => refreshed,
  };
}

test('Host retries a failed pause cleanup and publishes one current list and state', async t => {
  installBrowserSubstitute(t);
  const f = await fixture(t, { resident: false });
  await f.runtime.reconcile();
  await f.call();
  const dispose = f.runtime.library.disposeGhost.bind(f.runtime.library);
  let calls = 0;
  t.mock.method(f.runtime.library, 'disposeGhost', async id => {
    if (++calls <= 2) throw new Error('temporary fixture cleanup failure /private/fixture');
    await dispose(id);
  });
  let storageAvailable = false;
  const monitor = profileMonitor(t, f, () => {
    if (!storageAvailable) throw new Error('release write failed /private/fixture');
  });
  await monitor.scan([42]);
  assert.deepEqual(await f.call(), held);
  f.pushes.length = 0;
  assert.deepEqual(await monitor.scan([]), []);
  assert.deepEqual(await monitor.scan([]), []);
  const releaseBlocked = await f.call();
  assert.equal(releaseBlocked.errorCode, 'PRECONDITION_FAILED');
  assert.equal(releaseBlocked.reason, 'HOST_PROFILE_RELEASE_FAILED');
  assert.doesNotMatch(releaseBlocked.message, /fixture|HOST_PROFILE_IN_USE_BY_DESKTOP/);
  await monitor.scan([42]);
  assert.deepEqual(await f.call(), held);
  storageAvailable = true;
  assert.deepEqual(await monitor.scan([]), []);
  assert.deepEqual(await monitor.scan([]), [false]);
  const blocked = await f.call();
  assert.equal(blocked.errorCode, 'PRECONDITION_FAILED');
  assert.equal(blocked.reason, 'HOST_PROFILE_RELEASE_FAILED');
  assert.doesNotMatch(blocked.message, /fixture|HOST_PROFILE_IN_USE_BY_DESKTOP/);
  // During restore, reconciliation may await inventory before publishing its final state.
  const inventory = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const list = f.manager.listAsync.bind(f.manager);
  const listing = t.mock.method(f.manager, 'listAsync', async (...args) => {
    inventory.resolve();
    await proceed.promise;
    return list(...args);
  });
  const recovered = monitor.scan([]);
  try {
    await inventory.promise;
    assert.deepEqual(await f.call(), blocked);
  } finally {
    proceed.resolve();
    listing.mock.restore();
  }
  assert.deepEqual(await recovered, [true]);
  assert.equal(calls, 3);
  assert.deepEqual(await monitor.scan([]), []);
  assert.equal(monitor.rebuilt(), 1);
  assert.equal(monitor.refreshed(), 1);
  const events = f.pushes.filter(event => ['ghosts:changed', 'ghosts:runtime-changed'].includes(event.channel));
  assert.deepEqual(events.map(event => event.channel), ['ghosts:changed', 'ghosts:runtime-changed']);
  assert.equal(installedGhostStoragePart(events[0].payload.ghosts[0]), f.id);
  assert.deepEqual(events[1].payload, f.runtime.runtimeStates());
  assert.deepEqual(await f.call(), { ok: true, result: true });
});

test('Host resumes on a later clear scan when the owner was briefly unavailable', async t => {
  installBrowserSubstitute(t);
  const f = await fixture(t, { resident: false });
  await f.runtime.reconcile();
  const monitor = profileMonitor(t, f);
  await monitor.scan([42]);
  await monitor.scan([]);
  const release = beginAppSessionBoundary();
  try {
    assert.deepEqual(await monitor.scan([]), [false]);
    assert.deepEqual(f.runtime.pluginPauseFailure(), held);
  } finally {
    release();
  }
  assert.deepEqual(await monitor.scan([]), [true]);
  assert.equal(monitor.rebuilt(), 1);
  assert.equal(monitor.refreshed(), 1);
  assert.deepEqual(await f.call(), { ok: true, result: true });
});

test('a completed external write is still uncertain when pause interrupts its tool result', async t => {
  let observed;
  const replied = new Promise(resolve => { observed = resolve; });
  installBrowserSubstitute(t, { beforeToolAnswer: async result => {
    observed(result);
    await new Promise(() => {}); // the plugin did not deliver its tool result
  } });
  const send = t.mock.fn(async () => new Response('accepted'));
  t.mock.method(hostOutbound, 'guardedOutboundFetch', send);
  t.mock.method(hostOutbound, 'outboundFetch', send);
  const f = await fixture(t);
  const pending = f.call(externalUpload);
  assert.equal((await replied).ok, true);
  f.hold();
  assert.equal((await pending).errorCode, 'PLUGIN_DELIVERY_UNKNOWN');
  assert.equal(send.mock.callCount(), 1);
});

test('a plugin request keeps its unavailable-page error when the owner changes outside a hold', async t => {
  const f = await fixture(t, { resident: false });
  let release;
  t.mock.method(hostOutbound, 'outboundFetch', async () => {
    release = beginAppSessionBoundary();
    return new Response('outgoing owner');
  });
  try {
    const result = await f.runtime.network.handleFetchRequest(f.id, { url: 'https://example.invalid/read' });
    assert.equal(result.ok, false);
    assert.match(result.message, /PLUGIN_PAGE_UNAVAILABLE/);
  } finally {
    release?.();
  }
});

test('stopping a still-loading logic page rejects its startup waiter', async t => {
  let entered;
  const pageStarting = new Promise(resolve => { entered = resolve; });
  installBrowserSubstitute(t, { beforePage: async () => {
    entered();
    await new Promise(() => {});
  } });
  const f = await fixture(t, { resident: false });
  const sandbox = createHeadlessPluginSandbox({
    ownerKey: () => 'fixture', isCurrent: () => true, bridgeSource: '',
    send: async () => ({ ok: true }), pageHandler: () => () => new Response(),
  });
  t.after(() => sandbox.close());
  const runtime = new GhostRuntime({ adapter: sandbox.adapter, onStateChanged() {} });
  const loading = runtime.spawn(f.runtime.getGhost(f.id));
  await pageStarting;
  runtime.stop(f.id);
  assert.equal((await loading).ok, false);
  assert.equal(runtime.stateOf(f.id), 'off');
});

test('pause reports an in-flight Node tool as uncertain without an external fetch', realPage, async t => {
  const f = await fixture(t, { executable: executablePath, node: true });
  await f.runtime.reconcile();
  const marker = f.root('node-tool-started');
  const pending = f.call({ node: 'pending', marker });
  for (;;) {
    t.signal.throwIfAborted();
    try { await fs.access(marker); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  f.hold();
  assert.equal((await pending).errorCode, 'PLUGIN_DELIVERY_UNKNOWN');
});

test('Host reports an interrupted external write as uncertain and never resends it', { timeout: 5_000 }, async t => {
  installBrowserSubstitute(t);
  const transport = interruptibleUpload(t);
  const f = await fixture(t);
  await f.runtime.reconcile();
  const delivery = f.call(externalUpload);
  await transport.admitted;
  f.hold();
  await transport.finished;
  assert.match((await delivery).errorCode ?? '', /^PLUGIN_DELIVERY_UNKNOWN$/);
  await f.runtime.resumeAfterDesktop();
  assert.equal((await f.call()).ok, true);
  assert.equal(transport.count(), 1);
});

test('resident logic and Node resume in the old partition without a replacement approval', realPage, async t => {
  const f = await fixture(t, { executable: executablePath, node: true });
  await f.runtime.reconcile();
  assert.equal((await f.call()).ok, true);
  const panel = await f.runtime.openPage(f.id, 'panel.html');
  await panel.evaluate(() => { localStorage.setItem('saved', 'before'); document.cookie = 'fixture=old; path=/'; });
  const before = await f.call({ node: true });
  assert.equal(before.ok, true, JSON.stringify(before));
  const receipts = await filesIn(f.root('ghost-install-state'));
  f.hold();
  assert.equal(f.runtime.node.stateOf(f.id), 'off');
  assert.deepEqual(await f.call({ node: true }), held);
  await f.runtime.resumeAfterDesktop();
  const after = await f.call({ node: true });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(before.result.ok, true, JSON.stringify(before.result));
  assert.equal(after.result.ok, true, JSON.stringify(after.result));
  assert.notEqual(before.result.result, after.result.result);
  assert.deepEqual(await panel.evaluate(() => [localStorage.getItem('saved'), document.cookie]), ['before', 'fixture=old']);
  assert.deepEqual(await filesIn(f.root('ghost-install-state')), receipts);
});

test('a real in-flight hook blocks on three intentional stops and paused native targets stay visible', realPage, async t => {
  const f = await fixture(t, { executable: executablePath });
  await f.runtime.reconcile();
  assert.equal((await f.call()).ok, true);
  const panel = await f.runtime.openPage(f.id, 'panel.html');
  for (let round = 0; round < 3; round++) {
    const before = await panel.evaluate(() => localStorage.getItem('hookId'));
    const pending = f.control();
    await panel.waitForFunction(old => localStorage.getItem('hookId') !== old, before, { timeout: 900 });
    f.hold();
    assert.equal((await pending).action, 'block');
    for (let call = 0; call < 4; call++) assert.equal((await f.control()).action, 'block');
    await f.runtime.resumeAfterDesktop();
    assert.equal((await f.call()).ok, true);
  }
  assert.ok(!f.warnings.includes('ghost control point failed'));
  assert.ok(!f.warnings.includes('ghost control points fused; failures follow user policy'));
});

test('an open settings page cannot wake a plugin or change KV during the hold', realPage, async t => {
  const f = await fixture(t, { executable: executablePath });
  await f.runtime.reconcile();
  const panel = await f.runtime.openPage(f.id, 'panel.html');
  const write = value => panel.evaluate(async body => {
    const response = await fetch('/kv', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: response.status === 204 ? null : await response.json() };
  }, value);
  assert.equal((await write({ value: 'before' })).status, 204);
  f.hold();
  assert.deepEqual(await write({ value: 'during' }), { status: 409, json: held });
  const wake = await panel.evaluate(async () => { const response = await fetch('/wake'); return { status: response.status, json: await response.json() }; });
  assert.deepEqual(wake, { status: 409, json: held });
  await f.runtime.resumeAfterDesktop();
  assert.deepEqual(await panel.evaluate(async () => (await fetch('/kv')).json()), { value: 'before' });
});

test('real observer delivery resumes on the next event without replaying a held event', realPage, async t => {
  const f = await fixture(t, { executable: executablePath, resident: false });
  const panel = await f.runtime.openPage(f.id, 'panel.html');
  const installed = f.runtime.getGhost(f.id);
  await f.runtime.reconcile();
  // Queue before the first logic page is ready, then enter the hold in the
  // same turn. The next event should flush this one, but no held event.
  f.gateway.publishIndexed([installed], 'session', 'did-session-switched', { sessionId: 'before' });
  f.hold();
  f.gateway.publishIndexed([installed], 'session', 'did-session-switched', { sessionId: 'held' });
  assert.equal(await f.gateway.preparePublish('session'), null);
  await f.runtime.resumeAfterDesktop();
  assert.equal(await panel.evaluate(() => localStorage.getItem('events')), null);
  f.gateway.publishIndexed([installed], 'session', 'did-session-switched', { sessionId: 'resumed' });
  await panel.waitForFunction(() => JSON.parse(localStorage.getItem('events') ?? '[]').includes('resumed'));
  assert.deepEqual(await panel.evaluate(() => JSON.parse(localStorage.getItem('events'))), ['before', 'resumed']);
});

test('an interrupted external upload is not resent and committed staging remains discoverable', realPage, async t => {
  const transport = interruptibleUpload(t);
  const f = await fixture(t, { executable: executablePath });
  await f.runtime.reconcile();
  const panel = await f.runtime.openPage(f.id, 'panel.html');
  const staging = (op, extra, loseReceipt = false) => f.call({ request: { type: 'library-request', op: 'staging.' + op, ...extra }, loseReceipt });
  const data = Buffer.from('fixture');
  const begin = taskId => staging('begin', { taskId, sourceRevision: 'v1', totalBytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), mime: 'image/png',
    recovery: { filename: 'fixture.png' } });
  const committed = (await begin('committed')).result;
  const unfinished = (await begin('unfinished')).result;
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.equal(unfinished.ok, true, JSON.stringify(unfinished));
  assert.equal((await staging('chunk', { stagingId: committed.stagingId, seq: 1, content: data.toString('base64'), encoding: 'base64' })).result.ok, true);
  const lost = staging('commit', { stagingId: committed.stagingId }, true);
  await panel.waitForFunction(() => Boolean(localStorage.getItem('staged')));
  assert.equal(await panel.evaluate(() => JSON.parse(localStorage.getItem('staged')).ok), true);

  const upload = f.call(externalUpload);
  await transport.admitted;
  f.hold();
  await transport.finished;
  const interrupted = await upload;
  assert.equal(interrupted.ok, false, JSON.stringify(interrupted));
  assert.equal(interrupted.errorCode, 'PLUGIN_DELIVERY_UNKNOWN');
  assert.equal((await lost).errorCode, 'PLUGIN_DELIVERY_UNKNOWN');
  await f.runtime.resumeAfterDesktop();
  const listing = (await staging('list', {})).result;
  assert.equal(listing.ok, true, JSON.stringify(listing));
  assert.deepEqual(listing.items.map(item => item.stagingId), [committed.stagingId]);
  assert.equal((await staging('read', { stagingId: committed.stagingId })).result.ok, true);
  assert.equal((await staging('chunk', { stagingId: unfinished.stagingId, seq: 1, content: data.toString('base64'), encoding: 'base64' })).result.ok, false);
  assert.equal((await staging('commit', { stagingId: unfinished.stagingId })).result.ok, false);
  assert.equal(transport.count(), 1);
});
