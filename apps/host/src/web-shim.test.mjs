import assert from 'node:assert/strict';
import vm from 'node:vm';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildWebShim } from './web-client-build.mjs';
import { createHostServer } from './server.mjs';
import { createHostService } from './service.mjs';

// Production entry: evaluate the browser shim and invoke its public preload API.
// Regression: auth aliases doubled /api, local entry spread a Promise and
// invented access, and listActive wrapped options in an array. Server tests do
// not exercise this adapter. Tier: unit, no sockets or real account state.
// Measured standalone: node --test apps/host/src/web-shim.test.mjs, < 250 ms.
// Exercise the actual browser bundle (including the shared contract), once per
// file. Regressions: shadowed pricing routes, incompatible approval/steer shapes,
// and success-shaped placeholders. Minimal inputs below hit public API methods.
const source = await buildWebShim(fileURLToPath(new URL('../../web/shim.js', import.meta.url)));
const cleanups = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function browser(respond = () => ({}), script = source, openEvents = (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
})) {
  const calls = [];
  const listeners = new Map();
  const redirects = [];
  const opened = [];
  const window = { open: (...args) => opened.push(args), crypto: { randomUUID: () => 'test-id' }, addEventListener(name, listener) { listeners.set(name, listener); } };
  const context = vm.createContext({
    window, navigator: { language: 'en', platform: 'test', clipboard: { writeText() {} } },
    document: { createElement: () => ({ dataset: {} }), head: { appendChild() {} } },
    location: { href: 'http://127.0.0.1:1234/#/cc-agent/old', replace(url) { redirects.push(url); } }, console, TextDecoder, AbortController, URL, URLSearchParams, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      // Keep the background event subscription pending, without timers/handles.
      if (url.startsWith('/events')) return openEvents(url, options);
      const body = JSON.parse(options.body);
      calls.push({ url, body, credentials: options.credentials });
      const result = await respond(url, body);
      if (result instanceof Response) return result;
      return { ok: true, text: async () => JSON.stringify(result) };
    },
  });
  vm.runInContext(script, context);
  calls.length = 0; // Ignore the independent plugin-list boot read.
  const close = () => listeners.get('pagehide')?.({ persisted: false });
  cleanups.push(close);
  return { api: window.electronAPI, window, calls, redirects, opened, focus: () => listeners.get('focus')?.(), close };
}

// Browser Files have no local filesystem authority, and opening a task must
// stay on this Host origin. These public preload paths were missing entirely.
test('browser-only task actions preserve synchronous paths and same-origin navigation', async () => {
  const b = browser();
  assert.equal(b.api.getFilePath({ name: 'test.txt' }), '');
  await b.api.maker.openSessionInNewWindow('task/a');
  assert.deepEqual(b.opened, [['http://127.0.0.1:1234/#/cc-agent/task%2Fa', '_blank', 'noopener,noreferrer']]);
  await assert.rejects(b.api.maker.openSessionInNewWindow('task', 'another-device'), /HOST_CHANNEL_UNSUPPORTED/);
  assert.equal(b.opened.length, 1);
});

// Regression: a release built with `--harnesses pi-bin` has no Claude Code or
// Codex, and the startup check required both, so the web client stayed on its
// startup failure screen. Minimal inputs: Pi only passes; no ready agent fails.
test('the startup check passes when any bundled agent is ready', async () => {
  const b = browser();
  for (const [harness, passed] of [
    [{ 'claude-code': false, codex: false, pi: true }, true],
    [{ 'claude-code': true, codex: true, pi: false }, true],
    [{ 'claude-code': false, codex: false, pi: false }, false],
  ]) {
    b.window.__cindyBoot = { harness };
    assert.equal((await b.api.checkEnvironment()).allPassed, passed, JSON.stringify(harness));
  }
});

test('both auth API shapes use the same Host routes', async () => {
  const b = browser(() => ({ isAuthenticated: true }));
  await b.api.auth.getState();
  await b.api.auth.refresh();
  await b.api.authInitialize();
  await b.api.authRefresh();
  assert.deepEqual(b.calls.map(c => c.url), [
    '/api/auth/state', '/api/auth/refresh', '/api/auth/state', '/api/auth/refresh',
  ]);
  assert.ok(b.calls.every(c => c.credentials === 'same-origin'));
});

test('installation and business confirmations use the authenticated Host routes', async () => {
  const b = browser(() => ({ granted: true, handled: true }));
  await b.api.ghosts.resolveInstallConsent('group-request', true);
  await b.api.ghosts.resolveConfirm('command-request', false);
  assert.deepEqual(b.calls.map(call => ({ url: call.url, body: call.body })), [
    { url: '/api/ghosts/install-consent/resolve', body: { requestId: 'group-request', confirmed: true } },
    { url: '/api/ghosts/confirm/resolve', body: { requestId: 'command-request', confirmed: false } },
  ]);
});

test('entering the app preserves the actual Host auth verdict', async () => {
  for (const state of [
    { user: { id: 'test-user' }, mode: 'cloud', canEnterApp: true },
    { user: null, mode: 'signed-out', canEnterApp: false },
  ]) {
    const b = browser(() => state);
    assert.deepEqual(JSON.parse(JSON.stringify(await b.api.authEnterLocal())), state);
  }
});

test('active task queries retain their options object', async () => {
  const b = browser(() => ({ format: 'active-sessions-v2', sessions: [] }));
  const result = await b.api.maker.listActive({ includeRemote: false });
  assert.deepEqual(b.calls[0].body, { options: { includeRemote: false } });
  assert.equal(result.format, 'active-sessions-v2');
});

// Event delivery is part of the same preload contract as IPC. Retractions,
// persisted errors and subagent changes must update a connected browser too.
test('history events reach the browser preload subscribers exactly once', async () => {
  const frames = [
    { seq: 1, type: 'message_deleted', sessionId: 'task', clientId: 'draft', clientIds: ['draft'] },
    { seq: 2, type: 'error_persisted', sessionId: 'task', persistId: 'err' },
    { seq: 3, type: 'subagent_runs_changed', sessionId: 'task' },
    { seq: 4, type: 'task_tags_changed', payload: { tags: [{ id: 'tag', name: 'Review', color: 'blue' }] }, ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 } },
    { seq: 5, type: 'input_receipt', sessionId: 'task', inputClientId: 'stopped', clientId: 'stopped', status: 'interrupted' },
    { seq: 6, type: 'text', sessionId: 'task', inputClientId: 'next', data: { text: 'next reply' } },
  ];
  const b = browser(() => ({}), source, () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')));
  } })));
  const received = [];
  const agentEvents = [];
  b.api.maker.onEvent(event => agentEvents.push(event));
  b.api.localDb.messages.onDeleted(event => received.push(event));
  b.api.localDb.messages.onErrorPersisted(event => received.push(event));
  b.api.localDb.subagentRuns.onChanged(event => received.push(event));
  b.api.localDb.taskTags.onChanged((payload, ownerStamp) => received.push({ payload, ownerStamp }));
  for (let n = 0; n < 40; n++) await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [
    frames[0], { sessionId: 'task', persistId: 'err' }, frames[2],
    { payload: frames[3].payload, ownerStamp: frames[3].ownerStamp },
  ]);
  // Host stop receipts belong to /chat, not the Agent timeline. A real text
  // event must still reach the renderer exactly once after that receipt.
  assert.equal(agentEvents.length, 1);
  assert.equal(agentEvents[0].event.type, 'text');
  assert.equal(agentEvents[0].event.data.text, 'next reply');
  b.close();
});

// Real preload -> Host service contract. The task menu failed on execute(),
// while search silently returned null. Plain boot/list tests missed both routes.
// Minimal unit input: one tag request and one keyword query; no network or DB.
test('task tags and conversation search reach the Host business service', async () => {
  const requests = [];
  const tags = { tags: [{ id: 'tag', name: 'Review', color: 'blue' }], sessions: [] };
  const search = { query: 'needle', results: [{ sessionId: 'task' }], vectorUsed: false };
  const service = createHostService({
    executeTaskTags: request => { requests.push(request); return tags; },
    searchConversations: request => { requests.push(request); return search; },
  });
  const b = browser(async (route, body) => (await service(route, body)).body);
  const tagRequest = { action: 'get', sessionIds: ['task'] };
  const searchRequest = { query: 'needle', filters: { status: 'active' } };
  assert.deepEqual(JSON.parse(JSON.stringify(await b.api.localDb.taskTags.execute(tagRequest))), tags);
  assert.deepEqual(JSON.parse(JSON.stringify(await b.api.localDb.conversations.search(searchRequest))), search);
  assert.deepEqual(requests, [tagRequest, searchRequest]);
});

// An unsupported write used to resolve successfully even though nothing was
// saved. Exercise both the generic fallback and explicit placeholder routes.
test('unsupported web actions cannot report a successful save or execution', async () => {
  const b = browser();
  for (const action of [
    () => b.api.maker.schedule.create({ prompt: 'test' }),
    () => b.api.maker.createCustomMcpServer({ name: 'test' }),
    () => b.api.maker.setGoal('test-session', { text: 'test' }),
    () => b.api.localDb.sessionImport.start({}),
    () => b.api.profileUpdate({ name: 'test' }),
    () => b.api.authSwitchAccount('another-account'),
    () => b.api.browserBackend.setKind('chrome'),
    () => b.api.maker.plugins.setEnabled(true),
    () => b.api.maker.android.setAdbPath('/adb'),
    () => b.api.maker.memoryReset(),
    () => b.api.setAutoUpdateSettings({ autoUpdate: true }),
    () => b.api.localDb.maintenance.schedule({}),
    () => b.api.cindyMediaStorage.cleanup(),
    () => b.api.discordBot.setConfig({}),
    () => b.api.maker.piKernel.install(),
    () => b.api.remoteDesktop.enable(),
    () => b.api.agentIsland.setEnabled(true),
  ]) {
    await assert.rejects(action(), { code: 'HOST_CHANNEL_UNSUPPORTED' });
  }
  assert.equal(b.calls.length, 0);
});

// Regression: the generic read fallback answered `modelGroups.get()` with `null`;
// the renderer stored it as the model group config and the model picker crashed
// reading `config.routes`. Minimal input: one call, which must reject.
test('the model groups read rejects instead of answering a null config', async () => {
  const b = browser();
  await assert.rejects(b.api.modelGroups.get(), { code: 'HOST_CHANNEL_UNSUPPORTED' });
  assert.equal(b.calls.length, 0);
});

// Real-browser regression: opening a task and finishing a reply invoked these
// desktop presentation hooks without awaiting them, causing unhandled rejections.
// No native window or notification surface exists in this client; settings writes
// above must still reject. Tier: unit, actual bundled shim, no Host side effects.
test('desktop presentation hooks do not reject during the web task lifecycle', async () => {
  const b = browser();
  await assert.doesNotReject(async () => {
    await b.api.agentIsland.setVisibleSession('task-1');
    await b.api.notificationShowSessionEvent({ sessionId: 'task-1', title: 'test', kind: 'done' });
    await b.api.agentIsland.setVisibleSession(null);
  });
  assert.equal(b.calls.length, 0);
});

test('interaction and steer results preserve rejection, matching the preload contract', async () => {
  for (const accepted of [true, false]) {
    const b = browser(url => url.endsWith('/respond') ? { accepted, ok: true } : { ok: accepted });
    const decision = { behavior: 'allow' };
    const answer = await b.api.maker.resolveInteraction('req-1', decision);
    assert.equal(answer.accepted, accepted); // ok is not a permission verdict
    assert.deepEqual(b.calls[0].body, { requestId: 'req-1', decision });
    assert.equal(await b.api.maker.input.steer('task-1', { text: 'next' }), accepted);
  }
});

test('pricing and history use the Host instead of placeholders or losing pagination', async () => {
  const b = browser(() => ({ source: 'host' }));
  for (const get of [
    () => b.api.maker.usage.getModelPricing(),
    () => b.api.maker.usage.getModelPricingV2(),
    () => b.api.maker.usage.getReferenceModelPricing(),
  ]) assert.equal((await get()).source, 'host');
  assert.deepEqual(b.calls.map(c => c.url), [
    '/api/usage/model-pricing', '/api/usage/model-pricing', '/api/usage/reference-model-pricing',
  ]);
  await b.api.localDb.messages.list('task-1', { before: 'm-2', limit: 20 });
  assert.deepEqual(b.calls.at(-1).body, { sessionId: 'task-1', before: 'm-2', limit: 20 });
  // The preload name is listTurnChangeSets, not turnChangeSets.list.
  assert.equal((await b.api.maker.listTurnChangeSets('task-1')).source, 'host');
  assert.deepEqual(b.calls.at(-1), {
    url: '/api/turn-change-sets/list', body: { sessionId: 'task-1' }, credentials: 'same-origin',
  });
});

test('a successful auth check cannot turn a signed-out state into a signed-in result', async () => {
  const b = browser(() => ({ ok: true, isAuthenticated: false, authenticated: false }));
  assert.equal(await b.api.authRefresh(), false);
  assert.equal(await b.api.auth.refresh(), false);
});

test('a failed capabilities request can recover without reloading the page', async () => {
  let attempt = 0;
  const b = browser(url => {
    if (url === '/api/ghosts') return [];
    if (++attempt === 1) throw new Error('temporarily disconnected');
    return { agentKind: 'codex', capabilities: { streaming: true } };
  });
  await assert.rejects(b.api.maker.getCapabilities('codex'), /disconnected/);
  const recovered = await b.api.maker.getCapabilities('codex');
  assert.equal(recovered.streaming, true);
  assert.equal(recovered.agentKind, 'codex');
  assert.equal(await b.api.maker.getCapabilities('codex'), recovered);
  assert.equal(attempt, 2);
});

// The served script must execute before the renderer without a module loader.
// This exercises HTTP delivery and the actual bundle, not source text patterns.
test('the Host serves an executable browser bundle with shared RPC routes', async (t) => {
  const server = createHostServer({
    token: 'test-token',
    webDir: 'unused-by-shim-route',
    shimPath: fileURLToPath(new URL('../../web/shim.js', import.meta.url)),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/shim.js`, {
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(response.status, 200);
  const b = browser(() => ({ accepted: false, ok: true }), await response.text());
  assert.equal((await b.api.maker.resolveInteraction('r1', { behavior: 'allow' })).accepted, false);
  assert.equal(b.calls[0].url, '/api/interactions/respond');
});

// Local setters must invalidate synchronous reads without waiting for SSE:
// otherwise the next drag or appearance edit starts from the old snapshot.
test('local setting writes and resets invalidate their synchronous snapshots', async () => {
  const b = browser(url => url.includes('/reset') ? { value: 'reset' } : { value: 'saved' });
  for (const [get, write, reset, unwrap] of [
    [() => b.api.layout.getStateSync(), () => b.api.layout.set({}), () => b.api.layout.reset(), x => x.layout],
    [() => b.api.appearanceSettings.getSync(), () => b.api.appearanceSettings.setPatch({}), () => b.api.appearanceSettings.reset(), x => x],
  ]) {
    get(); await write(); assert.equal(unwrap(get()).value, 'saved');
    await reset(); assert.equal(unwrap(get()).value, 'reset');
  }
});

// The browser stays mounted through both SSE and RPC 401. Pairing uses the
// existing short-lived cookie; returning to this tab resumes reads, not inputs.
test('an expired browser pairing keeps the page and can reconnect after pairing again', async t => {
  let authorized = false;
  const b = browser(url => {
    if (url === '/api/ghosts') return [];
    if (!authorized) return new Response('pair again', { status: 401 });
    return { dataOwnerId: 'owner', user: { id: 'user' }, isAuthenticated: true };
  }, source, () => {
    if (!authorized) return new Response(null, { status: 401 });
    return new Response(new ReadableStream({ start(controller) {
      for (const phase of ['start', 'ready']) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
          type: 'host_stream', phase, runtime: 'restarted', seq: 0, reason: 'initial',
        }) + '\n\n'));
      }
    } }), { headers: { 'x-cindy-event-protocol': '2' } });
  });
  t.after(b.close);
  const states = [];
  const auth = [];
  b.api.hostConnection.onStateChanged(state => states.push(state));
  b.api.onAuthStateChange(state => auth.push(state));
  for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.equal(states.at(-1).status, 'authorization-required');
  await assert.rejects(b.api.localDb.sessions.list(), { code: 'HTTP_401' });
  assert.deepEqual(b.redirects, []);
  authorized = true;
  b.focus();
  for (let n = 0; n < 60; n++) await Promise.resolve();
  assert.equal(states.at(-1).status, 'connected');
  assert.equal(states.at(-1).recovery, 1);
  assert.equal(auth.at(-1).dataOwnerId, 'owner');
  assert.ok(b.calls.every(c => !c.url.includes('/enqueue')));
  assert.deepEqual(b.redirects, []);
});

/*
 * 甲-1 (release table): the Host web page runs a prebuilt renderer whose TapDB collector was fixed
 * when it was built; the Host must not add a cross-region upload of the signed-in account's usage.
 * Production entry: the real shim bundle plus the real vendored TapDB SDK, initialized the way the
 * renderer's tapdbClient does (ajax, device_login). The fake collector is the page's own
 * XMLHttpRequest, navigator.sendBeacon and image pixel, recording what would leave the browser.
 * Gap: the shim tests above stub no network primitives, and the renderer's TapDB tests run in
 * Electron where the build region and the account region are checked by the Desktop.
 * Minimal failure: account realm cn, renderer collector global: any recorded request is a leak.
 * Tier: unit (vm, no sockets).
 */
// Bundled once, only by the test that needs it (the other shim tests do not pay for it).
let tapdbSdk;
async function loadTapdbSdk() {
  const { build: bundle } = await import('esbuild');
  tapdbSdk ??= (await bundle({
    entryPoints: [fileURLToPath(new URL('../../desktop/src/renderer/vendor/tapdb/tapdb.esm.min.js', import.meta.url))],
    bundle: true, write: false, format: 'iife', globalName: 'TapDBLib', platform: 'browser', logLevel: 'silent',
  })).outputFiles[0].text;
}
const COLLECTOR = { cn: 'https://e.tapdb.com/event', global: 'https://e.tapdb.ap-sg.tapapis.com/event' };

function analyticsPage(auth, frames = [], authState = { authenticated: Boolean(auth), realm: auth?.realm ?? 'global' }) {
  const sent = [];
  class FakeXhr {
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    send() { sent.push(['xhr', this.url]); }
  }
  class FakeImage {}
  Object.defineProperty(FakeImage.prototype, 'src', { configurable: true, set(value) { sent.push(['img', value]); }, get() { return ''; } });
  const storage = new Map();
  const timers = [];
  const window = { addEventListener() {}, removeEventListener() {}, crypto: { randomUUID: () => 'test-id' }, __cindyBoot: { auth } };
  const context = vm.createContext({
    window, console, URL, URLSearchParams, TextDecoder, AbortController, JSON, Math, Date, encodeURIComponent, decodeURIComponent,
    XMLHttpRequest: FakeXhr, HTMLImageElement: FakeImage, Image: FakeImage,
    navigator: { language: 'en', languages: ['en', 'en'], userAgent: 'test', platform: 'test', clipboard: { writeText() {} },
      sendBeacon: (url) => { sent.push(['beacon', url]); return true; } },
    document: { referrer: '', title: 't', URL: 'http://127.0.0.1:1234/', cookie: '', addEventListener() {},
      createElement: () => ({ dataset: {} }), getElementsByTagName: () => [], head: { appendChild() {} } },
    location: { href: 'http://127.0.0.1:1234/', protocol: 'http:', host: '127.0.0.1:1234', hostname: '127.0.0.1', pathname: '/', search: '', hash: '', replace() {} },
    screen: { width: 1, height: 1 },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    TextEncoder, ReadableStream, Response,
    // The stream's opening /api/auth/state read answers authState; the event stream carries the
    // frames (auth_changed); every other request stays pending.
    fetch: (url) => {
      if (String(url).startsWith('/api/auth/state')) {
        return Promise.resolve({ ok: true, text: async () => JSON.stringify({ ...authState, user: null, dataOwnerId: null }) });
      }
      if (String(url).startsWith('/events')) {
        // Open (never closed), so the stream reaches its opening auth read for every case.
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          if (frames.length) controller.enqueue(new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')));
        } })));
      }
      return new Promise(() => {});
    },
  });
  for (const key of ['XMLHttpRequest', 'HTMLImageElement', 'Image', 'navigator', 'document', 'location', 'localStorage', 'sessionStorage', 'screen']) window[key] = context[key];
  vm.runInContext(source, context);
  vm.runInContext(`${tapdbSdk};globalThis.__tapdb = TapDBLib.default;`, context);
  return { sent, tapdb: context.__tapdb, beacon: (url) => context.navigator.sendBeacon(url), pixel: (url) => { new FakeImage().src = url; } };
}

test('Host web usage statistics leave only for the signed-in account region', async () => {
  await loadTapdbSdk();
  const signedOut = { seq: 1, type: 'auth_changed', authenticated: false, user: null, dataOwnerId: null, realm: 'global' };
  for (const [label, auth, renderer, leaves, frames] of [
    ['same region', { realm: 'global' }, 'global', true],
    ['same region (cn)', { realm: 'cn' }, 'cn', true],
    ['account cn, renderer global', { realm: 'cn' }, 'global', false],
    ['account global, renderer cn', { realm: 'global' }, 'cn', false],
    ['no signed-in account', undefined, 'global', false],
    // auth_changed keeps the stored realm when signed out; the shim must not keep reporting.
    ['signed out after boot', { realm: 'global' }, 'global', false, [signedOut]],
  ]) {
    const page = analyticsPage(auth, frames);
    for (let n = 0; n < 40; n++) await Promise.resolve();
    page.tapdb.init({ appId: 'fixture-app', serverUrl: COLLECTOR[renderer], send_method: 'ajax', textContent: 'form',
      isInitDeviceLogin: true, autoTrack: { pageShow: false, pageHide: false } });
    page.tapdb.optInTracking();
    page.tapdb.setUser('fixture-member');
    page.tapdb.track('fixture_event');
    page.beacon(COLLECTOR[renderer]);
    page.pixel(COLLECTOR[renderer]);
    const toCollector = page.sent.filter(([, url]) => String(url).startsWith(new URL(COLLECTOR[renderer]).origin));
    if (leaves) {
      assert.ok(toCollector.some(([kind]) => kind === 'xhr'), `${label}: the SDK reports through XHR`);
      assert.ok(toCollector.some(([kind]) => kind === 'beacon') && toCollector.some(([kind]) => kind === 'img'), label);
    } else {
      assert.deepEqual(toCollector, [], `${label}: nothing reaches the other region's collector`);
    }
    // Other origins are untouched by the guard.
    page.beacon('https://example.invalid/collect');
    assert.deepEqual(page.sent.at(-1), ['beacon', 'https://example.invalid/collect'], label);
  }
});
