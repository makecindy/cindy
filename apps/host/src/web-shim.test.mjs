import assert from 'node:assert/strict';
import vm from 'node:vm';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildWebShim } from './web-client-build.mjs';
import { createHostServer } from './server.mjs';
import { createHostService } from './service.mjs';
import { createEventHub } from './events.mjs';
import { createWebAuth } from './web-auth.mjs';
import { projectHostAuthState } from './auth-state.ts';

// Production entry: evaluate the browser shim and invoke its public preload API.
// Regression: auth aliases doubled /api, local entry spread a Promise and
// invented access, and listActive wrapped options in an array. Server tests do
// not exercise this adapter. Tier: unit, no sockets or real account state.
// Measured standalone: node --test apps/host/src/web-shim.test.mjs, < 250 ms.
// Exercise the actual browser bundle (including the shared contract), once per
// file. Regressions: shadowed pricing routes, incompatible approval/steer shapes,
// and success-shaped placeholders. Minimal inputs below hit public API methods.
const source = await buildWebShim(fileURLToPath(new URL('../../web/shim.js', import.meta.url)));
const emptyOwnerProfile = { sidebar: {}, voiceInput: { settings: {}, history: [] } };
const cleanups = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function browser(respond = () => ({}), script = source, openEvents = (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
}), schedule = setTimeout) {
  const calls = [];
  const listeners = new Map();
  const redirects = [];
  const opened = [];
  const window = { open: (...args) => opened.push(args), crypto: { randomUUID: () => 'test-id' }, addEventListener(name, listener) { listeners.set(name, listener); } };
  const context = vm.createContext({
    window, navigator: { language: 'en', platform: 'test', clipboard: { writeText() {} } },
    document: { createElement: () => ({ dataset: {} }), head: { appendChild() {} } },
    location: { href: 'http://127.0.0.1:1234/#/cc-agent/old', replace(url) { redirects.push(url); } }, console, TextDecoder, AbortController, URL, URLSearchParams, setTimeout: schedule, clearTimeout,
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

// #10601: a state query silently accepted local entry. Unit: public shim API;
// no Host identity exists, so entry must reject without querying signed-out auth.
test('browser local entry is unavailable without querying Host auth', async () => {
  const b = browser();
  assert.equal(b.api.hostConnection.client, 'browser');
  await assert.rejects(b.api.authEnterLocal(), /HOST_CHANNEL_UNSUPPORTED/);
  assert.equal(b.calls.length, 0);
});

test('initializing auth preserves the actual Host auth verdict', async () => {
  for (const state of [
    { user: { id: 'test-user' }, mode: 'cloud', canEnterApp: true },
    { user: null, mode: 'signed-out', canEnterApp: false },
  ]) {
    const b = browser(() => state);
    assert.deepEqual(JSON.parse(JSON.stringify(await b.api.authInitialize())), state);
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
    if (url === '/api/profile') return emptyOwnerProfile;
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

// #10600: the actual shim must forward login actions and keep paired browsers
// on the account login page after logout. Existing alias tests only read auth.
test('web login uses real Host state and logout does not navigate to pairing', async () => {
  const b = browser((url, body) => url.endsWith('login-state')
    ? { success: true, state: { step: 'identifier', providers: { social: ['google'] } } }
    : { success: true, state: { step: 'identifier' } });
  assert.equal((await b.api.authGetLoginState()).state.step, 'identifier');
  b.window.open = () => ({ close() {} });
  await b.api.authDispatchLoginAction({ type: 'discover-sso-org', org: 'example' });
  await b.api.authLogout();
  assert.deepEqual(b.calls.map(({ url, body }) => ({ url, body })), [
    { url: '/api/auth/login-state', body: {} },
    { url: '/api/auth/login-action', body: { action: { type: 'discover-sso-org', org: 'example' } } },
    { url: '/api/auth/logout', body: {} },
  ]);
  assert.deepEqual(b.redirects, []);
});

test('browser authorization opens on the controller and waits for the Host outcome', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const popup = { location: 'about:blank', opener: {}, close() {} };
  const b = browser(url => url.endsWith('login-action')
    ? { success: true, state: { step: 'browser-redirect', label: 'Google' }, authorizeUrl: 'https://auth.example.invalid/authorize' }
    : { success: true, state: { step: 'completed', membership: { id: 'owner' } } });
  b.window.open = () => popup;
  const pending = b.api.authDispatchLoginAction({ type: 'start-browser', kind: 'social', providerOrConnectionId: 'google', label: 'Google' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.location, 'https://auth.example.invalid/authorize');
  assert.equal(popup.opener, null);
  t.mock.timers.tick(1000);
  assert.equal((await pending).state.step, 'completed');
  assert.deepEqual(b.calls.map(call => call.url), ['/api/auth/login-action', '/api/auth/login-state']);
});

test('blocked browser authorization does not leave a Host login running', async () => {
  const b = browser();
  b.window.open = () => null;
  const result = await b.api.authDispatchLoginAction({ type: 'start-browser', kind: 'social', providerOrConnectionId: 'google', label: 'Google' });
  assert.equal(result.code, 'BROWSER_OPEN_FAILED');
  assert.equal(b.calls.length, 0);
});


test('sole SSO auto-start reuses the tab reserved before asynchronous discovery', async () => {
  const popup = { close() {} };
  let opens = 0;
  const b = browser((url, body) => body?.action?.type === 'discover-sso-org'
    ? { success: true, state: { step: 'method-choice', methods: [{ type: 'sso', connectionId: 'idp' }] } }
    : { success: true, state: { step: 'completed' }, authorizeUrl: 'https://auth.example.invalid/sso' });
  b.window.open = () => { opens++; return popup; };
  await b.api.authDispatchLoginAction({ type: 'discover-sso-org', org: 'example' });
  await b.api.authDispatchLoginAction({ type: 'start-browser', kind: 'sso', providerOrConnectionId: 'idp', label: 'SSO' });
  assert.equal(opens, 1);
  assert.equal(popup.location, 'https://auth.example.invalid/sso');
});

// Account expiry changes the account projection on the existing paired page;
// it must not start another pairing flow or navigate away from the login shell.
test('account expiry returns the paired browser to the signed-out projection', async () => {
  let stream;
  const b = browser(url => {
    if (url === '/api/profile') return emptyOwnerProfile;
    if (url.endsWith('login-state')) return { success: true, state: { step: 'identifier' } };
    return { user: { id: 'owner' }, dataOwnerId: 'owner', canEnterApp: true, isAuthenticated: true };
  }, source,
    () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  const auth = [];
  b.api.onAuthStateChange(state => auth.push(state));
  for (let n = 0; n < 30; n++) await Promise.resolve();
  stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ seq: 1, type: 'auth_changed', user: null,
    dataOwnerId: null, mode: 'signed-out', canEnterApp: false, isAuthenticated: false }) + '\n\n'));
  for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.equal(auth.at(-1).canEnterApp, false);
  assert.equal(auth.at(-1).user, null);
  assert.equal((await b.api.authGetLoginState()).state.step, 'identifier');
  assert.equal(b.calls.some(call => call.url === '/web/session'), false);
  assert.deepEqual(b.redirects, []);
});


// #10600: raw SSE assertions missed cursor gaps after filtering. Exercise the
// actual server, protocol=2 decoder and shim; only the reconnect clock is sped up.
test('signed-out protocol-2 streams stay idle through hidden events and reconcile at auth boundaries', { timeout: 5000 }, async t => {
  const events = createEventHub();
  events.publish({ type: 'text', data: { text: 'hidden-replay' } });
  let ready = false;
  let ownerGeneration = 0;
  let opens = 0;
  let closes = 0;
  const webAuth = createWebAuth();
  const cookie = `cindy_host_web=${webAuth.exchange(webAuth.pair())}`;
  // main.ts uses this full projection for both HTTP snapshots and auth events.
  const authState = () => projectHostAuthState({ account: { authenticated: ready, realm: 'global' },
    accountUser: ready ? { id: 'owner' } : null, owner: ready ? 'owner' : null,
    generation: ownerGeneration, deviceId: null });
  const server = createHostServer({ token: 'unused-test-token', events, webAuth, isOwnerReady: () => ready,
    getAuthState: authState, profile: () => emptyOwnerProfile,
  });
  server.on('request', (request, response) => {
    if (request.url.startsWith('/events')) response.on('close', () => { closes++; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = browser((url, body) => fetch(base + url, { method: 'POST', headers: { cookie }, body: JSON.stringify(body) }),
    source, (url, { signal }) => { opens++; return fetch(base + url, { headers: { cookie }, signal }); },
    (callback, ms) => setTimeout(callback, ms === 1000 ? 0 : ms));
  t.after(() => { b.close(); server.closeAllConnections(); server.close(); });
  const states = [];
  const auth = [];
  const waiters = [];
  b.api.onAuthStateChange(state => auth.push(state));
  b.api.hostConnection.onStateChanged(state => {
    states.push(state);
    for (const check of waiters) check();
  });
  const connected = n => new Promise(resolve => {
    const check = () => { if (states.at(-1)?.status === 'connected' && states.at(-1).connection === n) resolve(); };
    waiters.push(check); check();
  });
  const received = [];
  b.api.maker.onEvent(event => received.push(event));
  await connected(1);
  assert.equal(auth.at(-1).canEnterApp, false);
  assert.equal(b.api.maker.claimLegacyModelVisibilityOwner().ownerGeneration, 0);
  for (let batch = 0; batch < 2; batch++) {
    for (let i = 0; i < 100; i++) events.publish({ type: 'text', data: { text: 'hidden-live' } });
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(opens, batch + 1);
    assert.equal(closes, batch);
    assert.equal(received.length, 0);
    events.publish({ type: 'auth_changed', ...authState() });
    await connected(batch + 2);
    assert.equal(opens, batch + 2);
    assert.equal(auth.at(-1).canEnterApp, false);
  }
  ready = true;
  ownerGeneration = 3;
  events.clear();
  events.publish({ type: 'auth_changed', ...authState() });
  await connected(4);
  assert.equal(auth.at(-1).canEnterApp, true);
  assert.deepEqual(auth.slice(-2).map(state => state.ownerGeneration), [3, 3]);
  assert.ok(auth.slice(-2).every(state => state.dataOwnerId === 'owner'));
  assert.equal(b.api.maker.claimLegacyModelVisibilityOwner().ownerGeneration, 3);
  assert.equal(b.api.maker.claimLegacyModelVisibilityOwner().dataOwnerId, 'owner');
  assert.equal(b.api.sidebarSettings.loadSnapshot().ownerGeneration, 3);
  const delivered = new Promise(resolve => b.api.maker.onEvent(resolve));
  events.publish({ type: 'text', sessionId: 'task', data: { text: 'ready-live' } });
  assert.equal((await delivered).event.data.text, 'ready-live');
  ready = false;
  ownerGeneration = 4;
  events.publish({ type: 'text', data: { text: 'expired-hidden' } });
  await connected(5);
  assert.equal(auth.at(-1).canEnterApp, false);
  assert.equal(opens, 5);
  assert.equal(b.api.maker.claimLegacyModelVisibilityOwner().ownerGeneration, 4);
  assert.deepEqual(b.redirects, []);
});

// fnOS VM #10600: in-process login reached generation 3, but the cached claim
// stayed at generation 1 and left modelVisibilityPrefs in owner-pending. The
// public shim boundary is sufficient; no renderer/React harness is needed.
test('account events refresh synchronous model and sidebar owner stamps', async () => {
  let stream;
  const signedOut = { user: null, dataOwnerId: null, ownerGeneration: 0 };
  const b = browser(url => url === '/api/profile' ? emptyOwnerProfile : signedOut,
    source, () => new Response(new ReadableStream({ start(controller) {
    stream = controller;
    for (const phase of ['start', 'ready']) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
      type: 'host_stream', phase, runtime: 'owner-stamp-test', seq: 0, reason: 'initial',
    }) + '\n\n'));
  } }), { headers: { 'x-cindy-event-protocol': '2' } }));
  const previousClaim = b.api.maker.claimLegacyModelVisibilityOwner();
  const previousSidebar = b.api.sidebarSettings.loadSnapshot();
  assert.equal(previousClaim.dataOwnerId, null);
  assert.equal(previousClaim.ownerGeneration, 0);
  assert.equal(previousClaim.canWriteOwnerScoped, false);
  assert.equal(b.api.maker.claimLegacyModelVisibilityOwner(), previousClaim);
  let seq = 0;
  const publish = auth => new Promise(resolve => {
    const unsubscribe = b.api.onAuthStateChange(value => {
      if (value.ownerGeneration !== auth.ownerGeneration) return;
      unsubscribe(); resolve(b.api.maker.claimLegacyModelVisibilityOwner());
    });
    stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'auth_changed', seq: ++seq, ...auth }) + '\n\n'));
  });
  const loggedIn = await publish({ user: { id: 'owner' }, dataOwnerId: 'owner', ownerGeneration: 3 });
  assert.equal(loggedIn.dataOwnerId, 'owner');
  assert.equal(loggedIn.ownerGeneration, 3);
  assert.equal(loggedIn.canWriteOwnerScoped, true);
  assert.notEqual(loggedIn, previousClaim);
  assert.equal(b.api.maker.claimLegacyModelVisibilityOwner(), loggedIn);
  const sidebar = b.api.sidebarSettings.loadSnapshot();
  assert.notEqual(sidebar, previousSidebar);
  assert.equal(sidebar.dataOwnerId, 'owner');
  assert.equal(sidebar.ownerGeneration, 3);
  const renewed = await publish({ user: { id: 'owner' }, dataOwnerId: 'owner', ownerGeneration: 4 });
  assert.equal(renewed.ownerGeneration, 4);
  assert.notEqual(renewed, loggedIn);
  assert.equal(b.api.sidebarSettings.loadSnapshot().ownerGeneration, 4);
  const loggedOut = await publish({ user: null, dataOwnerId: null, ownerGeneration: 5 });
  assert.equal(loggedOut.ownerGeneration, 5);
  assert.equal(loggedOut.dataOwnerId, null);
  assert.equal(loggedOut.canWriteOwnerScoped, false);
});

test('in-place sign-in loads owner settings before publishing auth or allowing sidebar writes', { timeout: 5000 }, async () => {
  let stream;
  const { promise: profileRequested, resolve: requestProfile } = Promise.withResolvers();
  const { promise: profile, resolve: finishProfile } = Promise.withResolvers();
  const signedOut = { user: null, dataOwnerId: null, ownerGeneration: 0 };
  const sidebar = { pinnedOrder: ['saved-pin'], hiddenProjectKeys: ['saved-project'], hiddenMainViewGhostIds: ['saved-ghost'] };
  const voiceInput = { settings: { enabled: true }, history: [] };
  const b = browser((url, body) => {
    if (url === '/api/profile') { requestProfile(); return profile; }
    if (url === '/api/settings/sidebar/set') return body.value;
    return signedOut;
  }, source, () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  const signedIn = [];
  const voiceChanges = [];
  const pinChanges = [];
  const loggedIn = new Promise(resolve => b.api.onAuthStateChange(auth => {
    if (auth.dataOwnerId) {
      signedIn.push(b.api.sidebarSettings.loadSnapshot());
      resolve();
    }
  }));
  b.api.voiceInput.onDataChanged(value => voiceChanges.push(value));
  b.api.sidebarSettings.onPinnedOrderChanged((order, stamp) => pinChanges.push({ order, stamp }));
  assert.equal(b.api.sidebarSettings.loadSnapshot().dataOwnerId, null);
  assert.deepEqual(Array.from(b.api.voiceInput.getDataSnapshot().history), []);
  stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
    seq: 1, type: 'auth_changed', user: { id: 'owner' }, dataOwnerId: 'owner', ownerGeneration: 3,
  }) + '\n\n'));

  // The old shim announces auth immediately with an empty, authoritative sidebar.
  await Promise.race([profileRequested, loggedIn]);
  assert.equal(signedIn.length, 0);
  await assert.rejects(b.api.sidebarSettings.setProjectHidden('new-project', true));
  assert.equal(b.calls.some(call => call.url === '/api/settings/sidebar/set'), false);
  finishProfile({ sidebar, voiceInput });
  await loggedIn;

  assert.deepEqual(Array.from(signedIn[0].pinnedOrder), sidebar.pinnedOrder);
  assert.equal(signedIn[0].pinnedOrderIsAuthoritative, true);
  assert.equal(b.api.voiceInput.getDataSnapshot().settings.enabled, true);
  assert.equal(voiceChanges[0].settings.enabled, true);
  assert.deepEqual(Array.from(pinChanges[0].order), sidebar.pinnedOrder);
  assert.equal(pinChanges[0].stamp.ownerGeneration, 3);
  await b.api.sidebarSettings.setProjectHidden('new-project', true, {
    dataOwnerId: 'owner', ownerGeneration: 3,
  });
  assert.deepEqual(b.calls.at(-1).body.value, {
    ...sidebar, hiddenProjectKeys: ['saved-project', 'new-project'],
  });
});

test('boot owner generation is available synchronously before the event connection opens', () => {
  const boot = { auth: { user: { id: 'boot-owner' }, ownerId: 'boot-owner', ownerGeneration: 7 } };
  const b = browser(() => ({}), `window.__cindyBoot = ${JSON.stringify(boot)};\n${source}`);
  const claim = b.api.maker.claimLegacyModelVisibilityOwner();
  assert.equal(claim.dataOwnerId, 'boot-owner');
  assert.equal(claim.ownerGeneration, 7);
  assert.equal(b.api.sidebarSettings.loadSnapshot().ownerGeneration, 7);
});
