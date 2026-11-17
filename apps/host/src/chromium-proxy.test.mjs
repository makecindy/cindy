/*
 * Test value (release table row 28, 28c; reviewer 2026-11-18)
 * - Production entry: the Host's outbound proxy resolver (resolveHostOutboundProxy, outbound-proxy.ts, which every
 *   Host outbound request goes through) with the system proxy session main.ts sets (macOS: static settings plus the
 *   Chromium proxy helper; Windows: the helper), and the helper's Host side (createChromiumProxyHelper) on a
 *   stand-in helper process speaking the same line protocol. The real Electron helper is exercised by
 *   scripts/chromium-proxy-worker.e2e.mjs.
 * - Rules: never an answer before the helper is ready (a premature DIRECT would send a proxied request direct);
 *   started on demand only (not with proxy environment variables; on macOS not for static settings); every wait
 *   bounded, with a backoff restart; the fallback while it has no answer (macOS: the static reading, 28b; Windows:
 *   direct, recorded unknown); stopped by its handle; the helper gets the URL without user info or query, and an
 *   environment without any XDT_ / CINDY_ variable.
 * - Gap: nothing ran PAC or auto-discovery on the Host before 28c.
 * - Minimal failing input: a helper that answers DIRECT before it is ready; HTTPS_PROXY set; a helper that never
 *   becomes ready.
 * - Tier: unit with a process stand-in and mocked timers. The startup login case also uses a loopback HTTP proxy.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test, { mock } from 'node:test';
import ts from 'typescript';
import { createHostServer } from './server.mjs';

import {
  ANSWER_WAIT_MS, FIRST_BACKOFF_MS, START_TIMEOUT_MS, WARMUP_WAIT_MS, createChromiumProxyHelper, helperEnv, helperUrl,
} from './chromium-proxy.ts';
import {
  getHostOutboundPathSnapshotFor, resolveHostOutboundProxy, startHostSystemProxySettings, useHostChromiumProxySession, useHostSystemProxySettings,
} from './outbound-proxy.ts';

import { hostAuthFetch } from './auth-fetch.mjs';

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
for (const key of PROXY_ENV_KEYS) delete process.env[key];
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-chromium-proxy-'));
mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
test.after(() => {
  mock.timers.reset();
  useHostSystemProxySettings(null);
  for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(profileDir, { recursive: true, force: true });
});

/**
 * A stand-in for the helper process: records what the Host writes; `behaviour` decides its answers. Like the real
 * helper it quits when its stdin closes, unless `ignoreStdinEnd`.
 */
function standIn(behaviour = {}) {
  const spawned = [];
  const spawnImpl = (binary, args, options) => {
    const child = new EventEmitter();
    child.pid = 4000 + spawned.length;
    child.args = args;
    child.options = options;
    child.signals = [];
    child.written = [];
    child.stdout = new PassThrough();
    child.send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const message = JSON.parse(line);
          child.written.push(message);
          behaviour.onRequest?.(child, message);
        }
        done();
      },
      final(done) {
        child.stdinEnded = true;
        if (!behaviour.ignoreStdinEnd) queueMicrotask(() => child.exit());
        done();
      },
    });
    child.kill = (signal) => { child.signals.push(signal); return true; };
    child.exit = () => { if (!child.exited) { child.exited = true; child.emit('exit', null, null); } };
    spawned.push(child);
    behaviour.onSpawn?.(child);
    return child;
  };
  return { spawned, spawnImpl };
}

const ready = child => child.send({ ready: true, pid: child.pid });
const answer = result => (child, message) => { if (message.method === 'resolve') child.send({ id: message.id, result }); };
const helperFor = (spawnImpl) => createChromiumProxyHelper({ profileDir, spawnImpl, assets: () => ({ binary: 'electron', script: 'worker.cjs' }) });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

/** Starts a resolution and reports whether it settled, and how, without awaiting it. */
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}

test('never an answer before the helper is ready: the resolution waits, within its limit, then gets Chromium\'s', async () => {
  // A helper that would answer DIRECT at once; only the Host's wait for `ready` keeps that answer out.
  const { spawned, spawnImpl } = standIn({ onRequest: answer('DIRECT') });
  const helper = helperFor(spawnImpl);
  const early = track(helper.resolveProxy('https://user:secret@api.example.test/v1?token=t#frag'));
  await settle();
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].written, [], 'nothing is asked before ready');
  mock.timers.tick(ANSWER_WAIT_MS);
  await settle();
  assert.equal(early.settled, true);
  assert.equal(early.value, undefined, 'no answer before ready');
  assert.match(String(early.error?.message), /not ready yet/);

  ready(spawned[0]);
  await settle();
  spawned[0].written.length = 0;
  assert.equal(await helper.resolveProxy('https://user:secret@api.example.test/v1?token=t#frag'), 'DIRECT');
  assert.deepEqual(spawned[0].written, [{ id: 1, method: 'resolve', url: 'https://api.example.test/v1' }], 'no user info, query or fragment');
  assert.equal(helper.state(), 'ready');
});

test('started on demand: not with proxy environment variables, not for static macOS settings, at the first need on Windows', async () => {
  const { spawned, spawnImpl } = standIn({ onSpawn: ready, onRequest: answer('PROXY 10.9.9.9:8080') });
  const helper = helperFor(spawnImpl);
  assert.equal(spawned.length, 0, 'creating the helper starts nothing');

  useHostChromiumProxySession(helper);
  process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
  try {
    mock.timers.tick(40_000);
    assert.equal(await resolveHostOutboundProxy('https://env.example.test/'), 'http://127.0.0.1:3128');
  } finally { delete process.env.HTTPS_PROXY; }
  assert.equal(spawned.length, 0, 'proxy environment variables come first; no helper');

  const STATIC = '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 10.0.0.2\n  HTTPSPort : 3129\n}\n';
  useHostSystemProxySettings(async () => STATIC, helper);
  mock.timers.tick(40_000);
  assert.equal(await resolveHostOutboundProxy('https://static.example.test/'), 'http://10.0.0.2:3129');
  assert.equal(spawned.length, 0, 'static macOS settings: the 28b reading, no helper');

  for (const extra of ['  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://pac.example.test/proxy.pac\n', '  ProxyAutoDiscoveryEnable : 1\n']) {
    useHostSystemProxySettings(async () => STATIC.replace('<dictionary> {\n', `<dictionary> {\n${extra}`), helper);
    mock.timers.tick(40_000);
    assert.equal(await resolveHostOutboundProxy(`https://dynamic-${spawned.length}.example.test/`), 'http://10.9.9.9:8080', extra);
  }
  assert.equal(spawned.length, 1, 'PAC and auto-discovery ask Chromium, through one helper');

  useHostChromiumProxySession(helper);
  mock.timers.tick(40_000);
  assert.equal(await resolveHostOutboundProxy('https://windows.example.test/'), 'http://10.9.9.9:8080');
  assert.equal(spawned.length, 1, 'the helper stays running');
  await helper.close();
});

// Startup regression (row 28c): exercise the startup gate followed by the actual auth transport.
// The PAC answer is delayed past the normal 1.8 s deadline. Only the loopback proxy receives the POST.
test('the first login reaches the PAC proxy after a three-second cold start', async t => {
  const seen = [];
  const proxy = createServer((req, res) => {
    seen.push([req.method, req.url]);
    res.end('via PAC');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const { spawnImpl, spawned } = standIn({
    onRequest: answer(`PROXY 127.0.0.1:${proxy.address().port}`),
  });
  const helper = helperFor(spawnImpl);
  t.after(() => helper.close());
  const url = 'http://cold-auth.example.test/v1/session/refresh';
  const startup = track(startHostSystemProxySettings({ platform: 'darwin', makeHelper: () => helper,
    readSettings: async () => '<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://pac.example.test/proxy.pac\n}\n',
  }));
  await settle();
  assert.equal(spawned.length, 1, 'start before any network request');
  mock.timers.tick(2999);
  await settle();
  assert.equal(startup.settled, false, 'startup must wait for the cold PAC');
  assert.deepEqual(spawned[0].written, []);
  mock.timers.tick(1);
  ready(spawned[0]);
  await settle();
  assert.equal(startup.settled, true);
  assert.ifError(startup.error);
  const response = await hostAuthFetch(url, { method: 'POST' });
  assert.equal(await response.text(), 'via PAC');
  assert.deepEqual(seen, [['POST', url]]);
});

// Row 28c, integration: run main's command preparation and listen/startup callback together, as
// startup-account.test.mjs runs the real startup functions. Substitute profile/account storage;
// exercise the real loopback /health handler, proxy helper protocol and login transport.
function launchServe(t, { startHostSystemProxySettings, resolveAccountUser, warn }) {
  const server = createHostServer({ token: 'fixture-token' });
  // Let early rejections surface before the listener's startup callback runs.
  const listen = server.listen.bind(server);
  server.listen = (port, host, onListening) => listen(port, host, () => setImmediate(() => {
    if (server.listening) onListening();
  }));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));

  const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const preparation = source.slice(source.indexOf('const command ='), source.indexOf("if (command === '--help'"));
  const listener = source.slice(source.indexOf("server.on('error'"), source.indexOf('let shuttingDown ='));
  const ports = {
    server, PORT: 0, profileDir, instanceId: 'fixture', account: {}, runtime: {}, shuttingDown: false,
    process: { argv: ['node', 'main.ts', 'serve'], env: {}, stdout: { write() {} } },
    console: { log() {}, warn, error() {} }, resolveHostRegion() {}, publishHostEndpoint() {}, resolveHostDataDir: () => profileDir,
    discoverHostOwner: () => ({}), readAdoptedSessionState: async () => ({ authenticated: true }),
    startHostSystemProxySettings, resolveAccountUser,
    disposeOwnerRuntime() {}, commitVolatileAppSession() {}, classifyHostStartFailure() {},
  };
  const body = ts.transpileModule(`return async () => {
    let startup, removeEndpoint;
    ${preparation}
    ${listener}
    return () => startup;
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const launch = new Function(...Object.keys(ports), body)(...Object.values(ports));
  return { server, listening: launch() };
}

test('serve answers health before the cold PAC is ready and sends its first login through the proxy', async t => {
  const seen = [];
  const proxy = createServer((req, res) => { seen.push(req.url); res.end('via PAC'); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const { spawned, spawnImpl } = standIn({ onRequest: answer(`PROXY 127.0.0.1:${proxy.address().port}`) });
  const helper = helperFor(spawnImpl);
  t.after(() => helper.close());
  const loginUrl = 'http://listen-first.example.test/v1/session/refresh';
  let loginStarted = false;
  const { server, listening } = launchServe(t, {
    startHostSystemProxySettings: () => startHostSystemProxySettings({ platform: 'win32', makeHelper: () => helper }),
    resolveAccountUser: async () => {
      loginStarted = true;
      const response = await hostAuthFetch(loginUrl, { method: 'POST' });
      await response.text();
      return null;
    },
  });
  await settle();
  assert.ok(server.listening, 'serve must listen while proxy warmup is still pending');
  const startup = await listening;
  const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'cindy-host');
  mock.timers.tick(2999);
  await settle();
  assert.equal(loginStarted, false);
  assert.deepEqual(spawned[0].written, [], 'no proxy resolution for login yet');
  assert.deepEqual(seen, []);
  mock.timers.tick(1);
  ready(spawned[0]);
  await startup();
  assert.deepEqual(seen, [loginUrl]);
});

// Row 28c: a helper factory can throw before startup awaits warmup (for example, a bad profile path).
test('serve keeps listening and continues startup after proxy warmup rejects', async t => {
  const warnings = [];
  let loginRoute;
  const { server, listening } = launchServe(t, {
    startHostSystemProxySettings: () => startHostSystemProxySettings({
      platform: 'darwin',
      makeHelper: () => { throw new TypeError('private profile path'); },
      readSettings: async () => '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 3129\n}\n',
    }),
    resolveAccountUser: async () => {
      loginRoute = await resolveHostOutboundProxy('https://warmup-error.example.test/');
      return null;
    },
    warn: (...args) => warnings.push(args),
  });
  const startup = await listening;
  await settle();
  assert.ok(server.listening);
  await startup();
  assert.equal(loginRoute, 'http://127.0.0.1:3129', 'startup reached login using the static fallback');
  assert.deepEqual(warnings, [['[host] system proxy warmup failed:', 'TypeError']]);
});

// Removing the 8 s bound leaves startup blocked until the independent 15 s watchdog.
test('startup continues at the warmup deadline with the first route unknown', async t => {
  const { spawnImpl, spawned } = standIn();
  const helper = helperFor(spawnImpl);
  t.after(() => helper.close());
  const startup = track(startHostSystemProxySettings({ platform: 'win32', makeHelper: () => helper }));
  await settle();
  assert.equal(spawned.length, 1);
  mock.timers.tick(WARMUP_WAIT_MS - 1);
  await settle();
  assert.equal(startup.settled, false);
  mock.timers.tick(1);
  await settle();
  assert.equal(startup.settled, true, 'startup continued at its own deadline');
  assert.ifError(startup.error);
  const upstream = 'https://auth-timeout.example.test';
  const first = track(resolveHostOutboundProxy(upstream));
  await settle();
  mock.timers.tick(ANSWER_WAIT_MS);
  await settle();
  assert.equal(first.settled, true);
  assert.equal(first.value, null);
  assert.equal(getHostOutboundPathSnapshotFor([upstream]).kind, 'unknown');
  assert.equal(helper.state(), 'starting', 'a slow PAC can still finish within the independent start watchdog');
});

test('startup skips the helper for proxy variables or static macOS settings', async t => {
  const { spawnImpl, spawned } = standIn();
  const helper = helperFor(spawnImpl);
  t.after(() => helper.close());
  let reads = 0;
  const ports = { makeHelper: () => helper, readSettings: async () => { reads++; return '<dictionary> {\n}\n'; } };
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  try {
    for (const platform of ['win32', 'darwin']) await startHostSystemProxySettings({ ...ports, platform });
  } finally { delete process.env.HTTPS_PROXY; }
  assert.equal(reads, 0);
  await startHostSystemProxySettings({ ...ports, platform: 'darwin' });
  assert.equal(reads, 1);
  assert.equal(spawned.length, 0);
});

test('every wait is bounded: a helper that never gets ready is stopped and started again after a growing backoff', async () => {
  const { spawned, spawnImpl } = standIn();
  const helper = helperFor(spawnImpl);
  const first = track(helper.resolveProxy('https://slow.example.test/'));
  await settle();
  mock.timers.tick(ANSWER_WAIT_MS - 1);
  await settle();
  assert.equal(first.settled, false);
  mock.timers.tick(1);
  await settle();
  assert.equal(first.settled, true, 'settled at the limit');
  assert.ok(first.error, 'rejected, so the caller falls back');

  mock.timers.tick(START_TIMEOUT_MS);
  await settle();
  assert.equal(spawned[0].stdinEnded, true, 'stopped by its handle');
  assert.equal(helper.state(), 'backoff');
  await assert.rejects(helper.resolveProxy('https://slow.example.test/'), /restarting/);
  assert.equal(spawned.length, 1, 'no start during the backoff');

  mock.timers.tick(FIRST_BACKOFF_MS);
  const second = track(helper.resolveProxy('https://slow.example.test/'));
  await settle();
  assert.equal(spawned.length, 2, 'started again after the backoff');
  mock.timers.tick(START_TIMEOUT_MS);
  await settle();
  assert.equal(second.settled, true);
  mock.timers.tick(FIRST_BACKOFF_MS);
  await assert.rejects(helper.resolveProxy('https://slow.example.test/'), /restarting/, 'the backoff doubled');
  await helper.close();
});

test('while the helper has no answer: macOS falls back to the static reading, Windows goes direct and is recorded unknown', async () => {
  const { spawned, spawnImpl } = standIn({ onSpawn: ready, onRequest: answer('PROXY 10.9.9.9:8080') });
  const helper = helperFor(spawnImpl);
  useHostChromiumProxySession(helper);
  mock.timers.tick(40_000);
  assert.equal(await resolveHostOutboundProxy('https://before-crash.example.test/'), 'http://10.9.9.9:8080');
  spawned[0].exit();
  await settle();
  assert.equal(helper.state(), 'backoff');

  // Within the backoff (no time passes); each upstream below is new to the resolver's cache.
  // Windows: no system answer, so direct, and the path says the verdict is unknown rather than direct.
  assert.equal(await resolveHostOutboundProxy('https://windows-crash.example.test/'), null);
  const { at: _at, ...snapshot } = getHostOutboundPathSnapshotFor(['https://windows-crash.example.test']);
  assert.deepEqual(snapshot, { source: 'system', kind: 'unknown', reason: 'resolve_failed', upstream: 'https://windows-crash.example.test' });

  // macOS with auto-discovery and a manual proxy: the static reading (28b) answers meanwhile.
  useHostSystemProxySettings(async () => '<dictionary> {\n  ProxyAutoDiscoveryEnable : 1\n  HTTPSEnable : 1\n  HTTPSProxy : 10.0.0.2\n  HTTPSPort : 3129\n}\n', helper);
  assert.equal(await resolveHostOutboundProxy('https://mac-crash.example.test/'), 'http://10.0.0.2:3129');
  await helper.close();
});

test('closed by its handle: stdin first, then SIGTERM, then SIGKILL; nothing starts afterwards', async () => {
  const { spawned, spawnImpl } = standIn({ onSpawn: ready, onRequest: answer('DIRECT'), ignoreStdinEnd: true });
  const helper = helperFor(spawnImpl);
  await helper.resolveProxy('https://close.example.test/');
  const closing = helper.close();
  assert.equal(spawned[0].stdinEnded, true);
  mock.timers.tick(500);
  assert.deepEqual(spawned[0].signals, ['SIGTERM']);
  mock.timers.tick(1000);
  assert.deepEqual(spawned[0].signals, ['SIGTERM', 'SIGKILL']);
  spawned[0].exit();
  await closing;
  await assert.rejects(helper.resolveProxy('https://close.example.test/'), /stopped/);
  assert.equal(spawned.length, 1);
});

test('the helper\'s environment and command line carry nothing of the Host\'s configuration', () => {
  const env = helperEnv('/tmp/profile/proxy-helper', {
    OPENAI_API_KEY: 'fixture-key', GH_TOKEN: 'fixture-token', HTTPS_PROXY: 'http://user:pass@proxy.test',
    PATH: '/bin', XDT_OFFICIAL_SHARED_PROFILE: '/should/not/leak', CINDY_HOST_DATA_DIR: '/leak', cindy_lower: 'leak',
    CINDY_PROXY_WORKER_TEST_CONFIG: '{"mode":"direct"}', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1',
  });
  assert.deepEqual(env, { PATH: '/bin', CINDY_PROXY_WORKER_PROFILE: '/tmp/profile/proxy-helper' });
  assert.equal(helperUrl('wss://a:b@relay.example.test:8443/socket?key=k'), 'wss://relay.example.test:8443/socket');
});
