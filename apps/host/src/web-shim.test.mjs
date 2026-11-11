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
  return { api: window.electronAPI, calls, redirects, opened, focus: () => listeners.get('focus')?.(), close };
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
  ];
  const b = browser(() => ({}), source, () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')));
  } })));
  const received = [];
  b.api.localDb.messages.onDeleted(event => received.push(event));
  b.api.localDb.messages.onErrorPersisted(event => received.push(event));
  b.api.localDb.subagentRuns.onChanged(event => received.push(event));
  b.api.localDb.taskTags.onChanged((payload, ownerStamp) => received.push({ payload, ownerStamp }));
  for (let n = 0; n < 40; n++) await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [
    frames[0], { sessionId: 'task', persistId: 'err' }, frames[2],
    { payload: frames[3].payload, ownerStamp: frames[3].ownerStamp },
  ]);
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
