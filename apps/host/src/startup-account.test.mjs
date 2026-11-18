import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { mapMembershipToAuthUser } from '../../desktop/src/shared/authUser.ts';
import { resolveSessionDevice, canRegisterHostDevice } from './auth/device-identity.mjs';
import { AUTH_SESSION_KEY } from '../../desktop/src/main/authCredentialKeys.ts';
import { resolveRuntimeDeviceId } from '../../desktop/src/main/deviceId.ts';
import { accessTokenRefreshDelayMs, decodeAccessTokenOrgSlug } from '../../desktop/src/main/authTokenClaims.ts';
import { createServer } from 'node:http';
import { AuthApiError, CindyAuthClient as RealAuthClient, parseAuthSessionRecord, serializeAuthSessionRecord } from '@cindy/auth-client';
import { assertHostSessionRegion } from './auth/region-policy.ts';
import { HostRefreshDeferredError, HostSessionMissingError, refreshHostSession as realRefreshHostSession } from './auth/refresh.mjs';
import { AuthRefreshBackoff } from '../../desktop/src/main/authRefreshBackoff.ts';
import { isDefinitiveRefreshError } from '../../desktop/src/main/authRefreshError.ts';
import { HostCrossRegionPersonalAccountError } from './auth/region-policy.ts';
import { projectAdoptedSession } from './credentials/session.mjs';
import { OwnerDatabaseError } from '../../desktop/src/main/localDb/startupCore.ts';
import { createDesktopScanner, HostProfileInUseError, nodeProfileScanPorts } from './agent/profile-coexistence.ts';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { classifyHostStartFailure, HostAccountMismatchError, HostSignInRequiredError } from './start-failure.ts';
import { projectHostAuthState } from './auth-state.ts';
import { createHostServer } from './server.mjs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createSourceElectronTree } from './test-support/source-electron-tree.mjs';
import { lifoCleanup } from './test-support/cleanup.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retainDbClient, waitForRetainedDbClient } from '../../desktop/src/main/localDb/client/pendingOperations.ts';

// Unit regression: run the real startup/auth functions with in-memory network,
// credentials and storage. A valid login for B must never open A's database.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
test('owner storage closes only after retained auxiliary usage has settled', async () => {
  const events = [];
  const client = { dispose: async () => { events.push('dispose'); } };
  const h = setup({
    openOwnerDatabase: async () => ({}),
    createDbClientForHandle: () => client,
    OwnerSessionStorage: class {},
    setCurrentDbClient() {},
    reconcileDeletedTaskViewState: async () => {},
    configureProvisionalSessions() { throw new Error('storage ready'); },
    clearCurrentDbClient: () => events.push('clear'),
    waitForRetainedDbClient,
  });
  await assert.rejects(h.start('account-b'), /storage ready/);
  const release = retainDbClient(client);
  const closing = h.close();
  try {
    await Promise.resolve();
    assert.deepEqual(events, ['clear']);
    events.push('usage-settled');
  } finally { release(); await closing; }
  assert.deepEqual(events, ['clear', 'usage-settled', 'dispose']);
});
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['ensureRuntime', 'resolveAccountUser'].includes(node.name?.text)) {
    functions.push(node.getText(source).replaceAll('import.meta.url', "'file:///test/main.ts'"));
  } else ts.forEachChild(node, visit);
}
visit(source);
const compiled = ts.transpileModule(`
let activeOwner = null, runtimeLease = null, currentSessionToken = null, accountUser = null, currentDeviceId = null, remoteIdentityReady = false;
let closeStorage = null, sessionStorage = null;
let account = { authenticated: false, realm: 'global' };
const runtime = { owner: null };
${functions.join('\n')}
return { start: ensureRuntime, resolve: resolveAccountUser, token: () => currentSessionToken, account: () => account, runtime, lease: () => runtimeLease, close: () => closeStorage() };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup(overrides = {}) {
  const opens = [];
  const steps = [];
  const deps = {
    mapMembershipToAuthUser, decodeAccessTokenOrgSlug, resolveRuntimeDeviceId, resolveSessionDevice, canRegisterHostDevice, AUTH_SESSION_KEY,
    waitForRetainedDbClient,
    resolveHostDataDir: () => 'isolated-test-profile',
    configureHostOwner: ({ ownerId }) => { steps.push(`owner:${ownerId}`); },
    // Row 25 (25a): the Host reads the Skill projection boundary for the owner it just configured.
    observeSkillProjectionBoundary: (ownerId) => { steps.push(`boundary:${ownerId}`); return 'stable'; },
    acquireHostRuntimeLease: () => ({ held: true, release() {} }),
    // No desktop on the profile (coexistence plan A); the refusal below scans a real one.
    createDesktopScanner: () => async () => [], hostLog: { info() {} }, OwnerDatabaseError, HostProfileInUseError,
    HostAccountMismatchError, HostSignInRequiredError,
    readAdoptedSessionState: async () => ({ authenticated: true, realm: 'global' }),
    openOwnerDatabase: async (args) => { opens.push(args); steps.push('open'); throw new Error('database opened'); },
    path: { join: (...parts) => parts.join('/') }, layout: { packaged: false, drizzleDir: 'desktop/drizzle', sqliteVecPath: 'desktop/vec0' }, process,
    resolveHostRegion: () => 'global', readAuthEndpoints: () => ({ authApiBaseUrl: 'https://example.invalid' }),
    createCredentialStore: async () => ({ read: () => null }), createRequire: () => () => ({ machineIdSync: () => 'test-device' }),
    CindyAuthClient: class { async getMe() { return { membership: { id: 'account-b' } }; } },
    refreshHostSession: async () => ({ sessionToken: 'synthetic-test-value' }),
    // The account-vault lock of the profile (auth/refresh.mjs); the cases here hold no other process.
    hostAccountVaultLock: () => task => task(),
    ACCOUNT_DEFAULT_MODEL: 'test-model', ACCOUNT_DEFAULT_EFFORT: 'medium',
    // The former startup refresh swallowed mismatch errors and still opened storage.
    refreshAuthSession: async () => false,
    assertHostSessionRegion, hostPackageRegion: () => 'global', hostAuthFetch: () => { throw new Error('no network in this harness'); },
    ...overrides,
  };
  // import.meta.url is only passed to the injected createRequire stub.
  const code = compiled.replaceAll('import.meta.url', "'file:///test/main.ts'");
  return { ...new Function(...Object.keys(deps), code)(...Object.values(deps)), opens, steps };
}

test('startup rejects a different signed-in owner before opening storage', async () => {
  const h = setup();
  await assert.rejects(h.start('account-a'), /does not match/);
  assert.deepEqual(h.opens, []);
  assert.equal(h.token(), null);
});

test('matching owner authentication proceeds to its own database', async () => {
  const h = setup();
  await assert.rejects(h.start('account-b'), /database opened/);
  assert.equal(h.opens.length, 1);
  assert.equal(h.opens[0].ownerId, 'account-b');
  // Read after the owner is configured (the boundary path follows that profile), before storage.
  assert.deepEqual(h.steps, ['owner:account-b', 'boundary:account-b', 'open']);
});

test('an explicit owner cannot open private data without a verified login', async () => {
  const h = setup({ readAdoptedSessionState: async () => ({ authenticated: false, realm: 'global' }) });
  await assert.rejects(h.start('account-b'), /Sign in/);
  assert.deepEqual(h.opens, []);
  assert.equal(h.token(), null);
});

/*
 * H-2 (release table; user decision 2026-11-17 “和桌面版一致”): adopting a stored session (a
 * Desktop profile's `AUTH_SESSION_KEY` record) applies the Desktop's cold-start and runtime-refresh
 * rule. Production entry: main.ts's ensureRuntime and resolveAccountUser, with the real
 * CindyAuthClient, refreshHostSession and session projection against two fake auth servers.
 * Gap: the cases above stub the auth client and never carry an account kind or a realm.
 * Minimal failure: global package, stored cn personal session → must stay signed out, no database.
 * Tier: unit (loopback HTTP only).
 */
async function adoptStoredSession(packageRegion, sessionRealm, kind) {
  const hits = [];
  const servers = {};
  const memberId = `fixture-${sessionRealm}-member`;
  for (const region of ['cn', 'global']) {
    const server = createServer((request, response) => {
      hits.push(`${region} ${request.url}`);
      const membership = { id: memberId, kind, role: 'owner', displayName: 'Fixture', email: null,
        orgId: kind === 'org' ? 'fixture-org' : null, orgName: kind === 'org' ? 'Fixture Org' : null };
      const json = (value) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (request.url === '/api/auth/refresh') return json({ accessToken: 'fixture-access-value', refreshToken: `fixture-rotated-${region}`, membership });
      if (request.url === '/api/me') return json({ membership, passportId: 'fixture-passport', identities: [membership] });
      return response.writeHead(404).end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers[region] = { server, url: `http://127.0.0.1:${server.address().port}` };
  }
  // The record exactly as the Desktop writes it (no Host device binding).
  const records = new Map([[AUTH_SESSION_KEY, serializeAuthSessionRecord(sessionRealm, 'fixture-desktop-refresh')]]);
  const store = { read: (key) => records.get(key) ?? null, write: (key, value) => records.set(key, value) };
  const h = setup({
    createCredentialStore: async () => store,
    readAdoptedSessionState: async () => projectAdoptedSession(store),
    readAuthEndpoints: (realm) => ({ authApiBaseUrl: servers[realm].url }),
    CindyAuthClient: RealAuthClient, refreshHostSession: realRefreshHostSession, hostAuthFetch: (input, init) => fetch(input, init),
    hostPackageRegion: () => packageRegion,
  });
  const close = () => Promise.all(Object.values(servers).map(({ server }) => new Promise((resolve) => server.close(resolve))));
  return { h, hits, memberId, stored: () => parseAuthSessionRecord(records.get(AUTH_SESSION_KEY)), close };
}

test('an adopted cross-region personal session stays signed out; an organization session is used', async () => {
  for (const [packageRegion, sessionRealm, kind, adopted] of [
    ['global', 'cn', 'personal', false],
    ['cn', 'global', 'personal', false],
    ['global', 'cn', 'org', true],
    ['cn', 'global', 'org', true],
    ['global', 'global', 'personal', true],
  ]) {
    const label = `package ${packageRegion}, stored ${sessionRealm} ${kind}`;
    const run = await adoptStoredSession(packageRegion, sessionRealm, kind);
    try {
      if (adopted) {
        await assert.rejects(run.h.start(run.memberId), /database opened/, label);
        assert.equal(run.h.opens[0]?.ownerId, run.memberId, label);
        assert.equal(run.h.token(), 'fixture-access-value', label);
        assert.equal(run.h.account().realm, sessionRealm, label);
      } else {
        await assert.rejects(run.h.start(run.memberId), (error) => error.code === 'HOST_CROSS_REGION_PERSONAL_ACCOUNT', label);
        assert.deepEqual(run.h.opens, [], `${label}: no account database is opened`);
        assert.equal(run.h.token(), null, `${label}: the session is not adopted`);
        // Cleared, as the Desktop resets to its build realm; an empty realm is what makes the web
        // shim block every statistics collector (甲 21).
        assert.deepEqual(run.h.account(), { authenticated: false, realm: null }, label);
      }
      // As the Desktop: the rotated token stays in the record of its own region either way.
      assert.deepEqual([run.stored()?.realm, run.stored()?.refreshToken], [sessionRealm, `fixture-rotated-${sessionRealm}`], label);
      assert.ok(run.hits.length > 0 && run.hits.every((hit) => hit.startsWith(`${sessionRealm} `)), label);
    } finally {
      await run.close();
    }
  }
});

// 测试价值
// - 生产入口：main.ts 的 ensureRuntime（本文件按源码取出并注入端口），用真的 createDesktopScanner 扫一个
//   临时 profile 的 `.dev-instances`；登记的是一个活着的子进程。
// - 规则：并存方案 A（审核方 2026-11-17 定）。运行时租约只挡第二个 Host；同一 profile 上有开库的桌面时，
//   Host 启动被拒：释放租约、停在 blocked、不读账号、不开库，也不自动重试。没有 `runtime` 字段的记录（旧版桌面）
//   按开库处理；`runtime: 'client'` 的记录（Host 的客户端）不挡。
// - 现有覆盖缺口：上面的用例只覆盖账号核对；之前 Host 看不到桌面。
// - 最小失败输入：一份没有 runtime 字段、PID 活着的登记记录。tier：unit（一个空转子进程，按 PID 结束）。
test('a desktop that opens the profile refuses the start: lease released, blocked, nothing read or opened', async t => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-coexistence-start-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(profile, { recursive: true, force: true });
  });
  mkdirSync(path.join(profile, '.dev-instances'));
  const record = { schemaVersion: 1, pid: child.pid, startedAtMs: Date.now(), userDataDir: profile, state: 'ready', passive: false };
  const recordFile = path.join(profile, '.dev-instances', `${child.pid}.json`);
  writeFileSync(recordFile, JSON.stringify(record));
  let released = 0;
  let reads = 0;
  const ports = {
    resolveHostDataDir: () => profile, createDesktopScanner,
    acquireHostRuntimeLease: () => ({ held: true, release() { released += 1; } }),
    readAdoptedSessionState: async () => { reads += 1; return { authenticated: true, realm: 'global' }; },
  };
  const refused = setup(ports);
  await assert.rejects(refused.start('account-b'),
    error => error instanceof HostProfileInUseError && error.code === 'HOST_PROFILE_IN_USE_BY_DESKTOP' && error.message.includes(`pid ${child.pid}`));
  assert.equal(released, 1, 'the runtime lease is released');
  assert.equal(refused.lease(), null);
  assert.equal(reads, 0, 'no account read');
  assert.deepEqual(refused.opens, [], 'no database opened');
  assert.equal(refused.runtime.state, 'blocked');
  assert.deepEqual(refused.runtime.coexistence, { state: 'desktop-running', desktops: [child.pid] });

  // A client of a Host (runtime: 'client') on the same profile never opens its database: the start goes on.
  writeFileSync(recordFile, JSON.stringify({ ...record, runtime: 'client' }));
  const allowed = setup(ports);
  await assert.rejects(allowed.start('account-b'), /database opened/);
  assert.equal(allowed.opens.length, 1);
});

// A slow OS lookup is distinguishable from a live desktop only at startup. Run the real
// startup/lease path against changing profile records with an injected OS and clock.
function uncertainDesktopStart(t, betweenRounds, duringLookup) {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'host-startup-identity-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const registry = path.join(profile, '.dev-instances');
  mkdirSync(registry);
  const alive = new Set([41]);
  const identities = new Map();
  const write = pid => writeFileSync(path.join(registry, `${pid}.json`), JSON.stringify({ pid, startedAtMs: 1000, userDataDir: profile }));
  write(41);
  const waits = [], queries = [], rounds = [];
  let elapsed = 0, releases = 0;
  // Advance both clocks so a wall-clock watchdog racing the scan also fires in these tests.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = ms => { elapsed += ms; t.mock.timers.tick(ms); };
  const fixture = { alive, identities, write, registry, advance };
  const clock = { now: () => elapsed, sleep: async ms => {
    waits.push(ms); advance(ms);
    betweenRounds?.(fixture);
  } };
  const ports = { ...nodeProfileScanPorts, selfPid: () => 99, isPidAlive: pid => alive.has(pid),
    readProcessIdentities: async pids => {
      queries.push([...pids]);
      duringLookup?.(fixture, queries.length);
      return new Map(identities);
    } };
  const h = setup({ resolveHostDataDir: () => profile, createDesktopScanner: dir => createDesktopScanner(dir, ports, clock),
    acquireHostRuntimeLease: () => ({ held: true, release() { releases++; } }),
    hostLog: { info: (_message, fields) => rounds.push(fields) } });
  return { h, waits, queries, rounds, releases: () => releases };
}

test('startup rechecks unknown identity and opens when the process has ended', async t => {
  const f = uncertainDesktopStart(t, ({ alive }) => alive.delete(41));
  await assert.rejects(f.h.start('account-b'), /database opened/);
  assert.equal(f.h.opens.length, 1);
  assert.deepEqual(f.waits, [500]);
  assert.equal(f.releases(), 0);
});

test('startup stops rechecking as soon as a desktop identity is confirmed', async t => {
  const f = uncertainDesktopStart(t, ({ identities }) => identities.set(41, { startedAtMs: 1000, command: 'Cindy' }));
  await assert.rejects(f.h.start('account-b'), { code: 'HOST_PROFILE_IN_USE_BY_DESKTOP' });
  assert.deepEqual(f.queries, [[41], [41]]);
  assert.deepEqual(f.waits, [500]);
  assert.deepEqual(f.h.opens, []);
  assert.equal(f.releases(), 1);
});

test('startup exhausts four unknown identities and releases the lease', async t => {
  const f = uncertainDesktopStart(t);
  await assert.rejects(f.h.start('account-b'), { code: 'HOST_PROFILE_IN_USE_BY_DESKTOP' });
  assert.deepEqual(f.queries, [[41], [41], [41], [41]]);
  assert.deepEqual(f.waits, [500, 1000, 2000]);
  assert.equal(f.releases(), 1);
  assert.equal(f.h.lease(), null);
  assert.deepEqual(f.h.opens, []);
  assert.deepEqual(f.rounds.map(r => r.result), Array(4).fill('unknown'));
});

test('startup refuses a new desktop registration between identity checks', async t => {
  const f = uncertainDesktopStart(t, ({ alive, write }) => { alive.delete(41); alive.add(42); write(42); });
  await assert.rejects(f.h.start('account-b'), { code: 'HOST_PROFILE_IN_USE_BY_DESKTOP' });
  assert.deepEqual(f.queries, [[41], [42]]);
  assert.deepEqual(f.waits, [500]);
  assert.deepEqual(f.h.runtime.coexistence.desktops, [42]);
  assert.deepEqual(f.h.opens, []);
});

test('startup keeps a vanished record blocked until the OS proves PID reuse', async t => {
  let count = 0;
  const f = uncertainDesktopStart(t, ({ registry, identities }) => {
    if (++count === 1) rmSync(path.join(registry, '41.json'));
    else identities.set(41, { startedAtMs: 60_000, command: 'unrelated program' });
  });
  await assert.rejects(f.h.start('account-b'), /database opened/);
  assert.deepEqual(f.waits, [500, 1000]);
  assert.equal(f.h.opens.length, 1);
});

test('startup retains an unidentified PID if the record disappears during the first lookup', async t => {
  const f = uncertainDesktopStart(t, undefined, ({ registry }) => rmSync(path.join(registry, '41.json'), { force: true }));
  await assert.rejects(f.h.start('account-b'), { code: 'HOST_PROFILE_IN_USE_BY_DESKTOP' });
  assert.equal(f.queries.length, 4);
  assert.deepEqual(f.h.opens, []);
  assert.equal(f.releases(), 1);
});

test('startup refuses without another lookup when a delayed wake exhausts the time budget', async t => {
  const f = uncertainDesktopStart(t, ({ advance }) => advance(10_000));
  await assert.rejects(f.h.start('account-b'), { code: 'HOST_PROFILE_IN_USE_BY_DESKTOP' });
  assert.deepEqual(f.queries, [[41]]);
  assert.deepEqual(f.rounds.map(r => r.result), ['unknown', 'deadline']);
  assert.equal(f.releases(), 1);
});

// A suspend or a slow OS lookup can finish after the retry budget. A completed
// scan still decides whether the real startup path opens storage or releases its lease.
test('startup opens after a slow first scan finds no desktop', async t => {
  const f = uncertainDesktopStart(t, undefined, ({ advance, alive }) => {
    advance(12_000);
    alive.delete(41);
  });
  await assert.rejects(f.h.start('account-b'), /database opened/);
  assert.equal(f.h.opens.length, 1);
  assert.deepEqual(f.waits, []);
});

test('startup reports the live desktop found by a slow first scan', async t => {
  const f = uncertainDesktopStart(t, undefined, ({ advance, identities }) => {
    advance(12_000);
    identities.set(41, { startedAtMs: 1000, command: 'Cindy' });
  });
  await assert.rejects(f.h.start('account-b'), { code: 'HOST_PROFILE_IN_USE_BY_DESKTOP' });
  assert.deepEqual(f.h.runtime.coexistence.desktops, [41]);
  assert.equal(f.releases(), 1);
  assert.deepEqual(f.h.opens, []);
  assert.deepEqual(f.waits, []);
});

test('startup opens when a slow retry finds the process has ended', async t => {
  const f = uncertainDesktopStart(t, undefined, ({ advance, alive }, round) => {
    if (round === 2) {
      advance(12_000);
      alive.delete(41);
    }
  });
  await assert.rejects(f.h.start('account-b'), /database opened/);
  assert.equal(f.h.opens.length, 1);
  assert.deepEqual(f.waits, [500]);
});

test('startup refuses an unknown identity before sleeping past the retry budget', async t => {
  const f = uncertainDesktopStart(t, undefined, ({ advance }) => advance(9_800));
  await assert.rejects(f.h.start('account-b'), { code: 'HOST_PROFILE_IN_USE_BY_DESKTOP' });
  assert.deepEqual(f.waits, []);
  assert.deepEqual(f.h.runtime.coexistence.desktops, [41]);
  assert.equal(f.releases(), 1);
});

/*
 * 测试价值（C，审核方 2026-11-17 定的第 6 步与“四个入口走同一个函数”）
 * - 生产入口：main.ts 的 refreshAuthSession / performAuthRefresh / scheduleAuthRefresh / deferAuthRefresh
 *   与 resolveAccountUser（按源码取出），用真的 refreshHostSession、AuthRefreshBackoff 与
 *   accessTokenRefreshDelayMs，内存里的凭据记录，假的账号服务。
 * - 规则：续期排在 access token 的 exp 减 300 秒（与桌面 scheduleRefresh 同一个函数），不再是固定 30 分钟；
 *   暂时失败按桌面的退避重试；只有确定失败才结束会话、不再排；同时到来的调用方共用一次续期。
 * - 现有覆盖缺口：之前每 30 分钟一次，失败后不重排；没有用例看排期。
 * - 最小失败输入：exp 在一小时后的 access token。tier：unit（node:test 的假时钟）。
 */
const renewalSource = ['refreshAuthSession', 'clearAuthRefreshTimer', 'scheduleAuthRefresh', 'deferAuthRefresh',
  'armAuthRefreshTimer', 'performAuthRefresh', 'endAuthRefreshes', 'resolveAccountUser'];
const renewalConstants = ['MAX_TIMER_DELAY_MS', 'DUE_ACCESS_TOKEN_RENEWAL_DELAY_MS'];
const renewalParts = [];
(function visitRenewal(node) {
  if (ts.isFunctionDeclaration(node) && renewalSource.includes(node.name?.text)) renewalParts.push(node.getText(source));
  else if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => renewalConstants.includes(d.name.getText(source))))
    renewalParts.push(node.getText(source));
  else ts.forEachChild(node, visitRenewal);
})(source);
// The source is only compiled and run, never asserted on; a renamed function fails the harness here.
if (renewalParts.length !== renewalSource.length + renewalConstants.length) throw new Error('a renewal function is missing from main.ts');
const renewalCompiled = ts.transpileModule(`
let currentSessionToken = null, accountUser = null, currentDeviceId = null, remoteIdentityReady = false;
let account = { authenticated: true, realm: 'global' };
const runtime = { owner: null };
let refreshTimer = null, authClosed = false, authRefreshFlight = null, authRefreshEpoch = 0;
const authRefreshBackoff = new AuthRefreshBackoff(() => Date.now(), () => 0);
${renewalParts.join('\n').replaceAll('import.meta.url', "'file:///test/main.ts'")}
return { refresh: refreshAuthSession, schedule: scheduleAuthRefresh, end: endAuthRefreshes, adopt: (token) => { currentSessionToken = token; },
  token: () => currentSessionToken, timer: () => refreshTimer };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const fakeJwt = (payload) => ['{"alg":"none"}', JSON.stringify(payload), 'sig'].map((part, i) => (i < 2 ? Buffer.from(part).toString('base64url') : part)).join('.');

function renewalHarness(t, server) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const records = new Map([[AUTH_SESSION_KEY, serializeAuthSessionRecord('global', server.current())]]);
  const store = { read: (key) => records.get(key) ?? null, write: (key, value) => records.set(key, value) };
  const invalidated = [];
  const deps = {
    mapMembershipToAuthUser, decodeAccessTokenOrgSlug, resolveRuntimeDeviceId, resolveSessionDevice, canRegisterHostDevice, AUTH_SESSION_KEY,
    waitForRetainedDbClient,
    resolveHostDataDir: () => 'isolated-test-profile', resolveHostRegion: () => 'global', hostPackageRegion: () => 'global',
    readAuthEndpoints: () => ({ authApiBaseUrl: 'https://example.invalid' }), assertHostSessionRegion, hostAuthFetch: () => assert.fail('no network'),
    createCredentialStore: async () => store, createRequire: () => () => ({ machineIdSync: () => 'test-device' }),
    CindyAuthClient: class { refresh(token) { return server.refresh(token); } async getMe() { return { membership: server.membership, passportId: 'passport-a' }; } },
    refreshHostSession: realRefreshHostSession, hostAccountVaultLock: () => task => task(),
    AuthRefreshBackoff, accessTokenRefreshDelayMs, isDefinitiveRefreshError, HostSessionMissingError, HostRefreshDeferredError,
    HostCrossRegionPersonalAccountError,
    eventHub: { publish() {} }, projectAuthState: () => ({}),
    invalidateHostSession: async (reason) => { invalidated.push(reason); },
  };
  const h = new Function(...Object.keys(deps), renewalCompiled)(...Object.values(deps));
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { ...h, invalidated, settle, stored: () => parseAuthSessionRecord(records.get(AUTH_SESSION_KEY))?.refreshToken };
}

/** A fake auth server: each renewal rotates the refresh token and issues an access token valid for an hour. */
function renewalServer() {
  let current = 'fixture-r0';
  let next = 0;
  let failure = null;
  const requests = [];
  return {
    requests, membership: { id: 'member-a', kind: 'personal', role: 'owner', displayName: 'Fixture', email: null, orgId: null, orgName: null },
    current: () => current,
    fail(error) { failure = error; },
    async refresh(token) {
      requests.push(Date.now());
      if (failure) throw failure;
      if (token !== current) throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'rotated');
      current = `fixture-r${++next}`;
      return { accessToken: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refreshToken: current, membership: this.membership };
    },
  };
}

test('the next renewal is armed at the access token\'s exp minus 300 s and goes through the one renewal', async (t) => {
  const server = renewalServer();
  const h = renewalHarness(t, server);
  const start = Date.now();
  h.adopt(fakeJwt({ exp: Math.floor(start / 1000) + 3600 }));
  h.schedule();
  t.mock.timers.tick(3300_000 - 1);
  await h.settle();
  assert.equal(server.requests.length, 0, 'not before exp - 300 s');
  t.mock.timers.tick(1);
  await h.settle();
  assert.deepEqual(server.requests, [start + 3300_000]);
  assert.equal(h.stored(), 'fixture-r1');
  // The new access token arms the next one, again at its exp minus 300 s.
  t.mock.timers.tick(3300_000);
  await h.settle();
  assert.deepEqual(server.requests, [start + 3300_000, start + 6600_000]);
  // Callers at the same moment (the 401 retry, Device Link, /api/auth/refresh) share one renewal.
  await Promise.all([h.refresh(), h.refresh(), h.refresh()]);
  assert.equal(server.requests.length, 3);
});

// d (reviewer, 2026-11-17): a token without a numeric exp arms nothing, as on the desktop; the server
// API's 401 path still renews it.
test('a token without a numeric exp arms no renewal; the server API\'s 401 still renews', async (t) => {
  const server = renewalServer();
  const h = renewalHarness(t, server);
  h.adopt(fakeJwt({ sub: 'member-a' }));
  h.schedule();
  assert.equal(h.timer(), null, 'nothing is armed');
  t.mock.timers.tick(24 * 3600_000);
  await h.settle();
  assert.equal(server.requests.length, 0);
  assert.equal(await h.refresh({ serverRejectedToken: true }), true, 'the 401 retry renews');
  assert.equal(server.requests.length, 1);
  assert.ok(h.timer(), 'the renewed token has an exp and arms the next renewal');
});

test('a renewal failing for now retries with the desktop\'s backoff; a definitive one ends the session and arms nothing', async (t) => {
  const server = renewalServer();
  const h = renewalHarness(t, server);
  server.fail(new AuthApiError('NETWORK_ERROR', 0, 'offline'));
  assert.equal(await h.refresh(), false);
  assert.ok(h.timer(), 'a retry is armed');
  assert.equal(await h.refresh(), false, 'a caller during the wait gets false');
  assert.equal(server.requests.length, 1, 'and sends nothing');
  t.mock.timers.tick(60_000);
  await h.settle();
  assert.equal(server.requests.length, 2, 'retried after the first backoff step (1 minute here)');
  // As the desktop: after a network failure, the server API's 401 brings one attempt forward.
  assert.equal(await h.refresh({ serverRejectedToken: true }), false, 'the network is still down');
  assert.equal(server.requests.length, 3, 'the 401 evidence sent one attempt at once');
  assert.equal(await h.refresh(), false, 'without new evidence, the wait holds');
  assert.equal(server.requests.length, 3);
  server.fail(null);
  t.mock.timers.tick(120_000);
  await h.settle();
  assert.equal(server.requests.length, 4, 'the second step is 2 minutes');
  assert.equal(h.stored(), 'fixture-r1');
  assert.deepEqual(h.invalidated, []);

  server.fail(new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'revoked'));
  const pending = h.refresh();
  // The desktop's re-reads of the stored sources before a rejection counts (250 ms, then 1 s).
  for (const step of [250, 1000]) { await h.settle(); t.mock.timers.tick(step); }
  assert.equal(await pending, false);
  assert.deepEqual(h.invalidated, ['account-unavailable']);
  assert.equal(h.timer(), null, 'nothing is armed after a definitive failure');
});

/*
 * 甲 (2026-11-17): a failed or refused start now tells the windows why, as one fixed code in the auth state
 * (`hostUnavailable`), so a window does not offer its own sign-in beside a Host that stays down.
 * Production entry: the real errors of ensureRuntime / resolveAccountUser (this harness), the real
 * classification (start-failure.ts, what main.ts's startup catch stores), the real projection
 * (auth-state.ts) and the real `/api/auth/state` route (server.mjs + service.mjs). Gap: before, every
 * failed start projected the same signed-out state as "no session". Minimal input: one failing start per
 * reason, with a sentinel in the error text; an ordinary signed-out start. Tier: unit (loopback HTTP only).
 */
const SENTINEL = 'sentinel-detail-/Users/someone/pid-4242';
const TOKEN = 'start-failure-test-token';

async function authStateAfter(t, error) {
  const unavailable = classifyHostStartFailure(error);
  const server = createHostServer({
    token: TOKEN,
    probe: () => ({ status: 'ok' }),
    me: () => ({ authenticated: false }),
    getAuthState: () => projectHostAuthState({ account: { authenticated: false, realm: 'global' }, accountUser: null,
      owner: null, generation: 1, deviceId: null, unavailable }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}/api/auth/state`,
      { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text, body: JSON.parse(text) }));
      });
    req.on('error', reject);
    req.end('{}');
  });
}

const failedStart = (overrides, owner = 'account-b') => setup(overrides).start(owner).then(() => null, error => error);

for (const [reason, start] of [
  ['HOST_ACCOUNT_MISMATCH', () => failedStart({}, 'account-a')],
  ['HOST_PROFILE_IN_USE_BY_DESKTOP', () => failedStart({ createDesktopScanner: () => async () => [4242] })],
  ['HOST_DATABASE_LOCKED', () => failedStart({ acquireHostRuntimeLease: () => ({ held: false, reason: SENTINEL }) })],
  ['HOST_DATABASE_UNAVAILABLE', () => failedStart({ openOwnerDatabase: async () => { throw new OwnerDatabaseError('MIGRATE_FAILED', SENTINEL); } })],
  // The auth client's own transport failures, typed: a renewal that got no response, and /me without one.
  ['HOST_SIGN_IN_SERVICE_UNREACHABLE', () => failedStart({ refreshHostSession: async () => {
    throw new HostRefreshDeferredError(`the renewal failed for now: ${SENTINEL}`, { networkFailure: true });
  } })],
  ['HOST_SIGN_IN_SERVICE_UNREACHABLE', () => failedStart({
    CindyAuthClient: class { async getMe() { throw new AuthApiError('NETWORK_ERROR', 0, SENTINEL); } },
  })],
  // A renewal deferred for another reason is not "unreachable", whatever its text says.
  ['HOST_START_FAILED', () => failedStart({ refreshHostSession: async () => {
    throw new HostRefreshDeferredError('the network of the vault lock is busy', { networkFailure: false });
  } })],
  ['HOST_START_FAILED', () => failedStart({ openOwnerDatabase: async () => { throw new Error(SENTINEL); } })],
]) {
  test(`a start that fails as ${reason} tells the windows that code and nothing of its text`, async t => {
    const error = await start();
    assert.ok(error, 'the start failed');
    const response = await authStateAfter(t, error);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.hostUnavailable, { reason });
    assert.equal(response.body.authenticated, false);
    assert.ok(!response.text.includes(SENTINEL), 'no error text in /api/auth/state');
  });
}

for (const [name, start] of [
  ['no saved session', () => failedStart({ readAdoptedSessionState: async () => ({ authenticated: false, realm: 'global' }) })],
  ['the saved session is gone', () => failedStart({ refreshHostSession: async () => { throw new HostSessionMissingError(); } })],
  ['the server rejected the session', () => failedStart({ refreshHostSession: async () => {
    throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, SENTINEL);
  } })],
  ['a personal account of another region', () => failedStart({ hostPackageRegion: () => 'cn',
    CindyAuthClient: class { async getMe() { return { membership: { id: 'account-b', kind: 'personal' } }; } } })],
]) {
  test(`an ordinary signed-out start (${name}) carries no start-failure reason`, async t => {
    const error = await start();
    assert.ok(error, 'the start ended signed out');
    const response = await authStateAfter(t, error);
    assert.equal('hostUnavailable' in response.body, false);
    assert.equal(response.body.mode, 'signed-out');
  });
}

/**
 * The environment of a test's `cindy-host serve` child, so that it reaches no real profile, sign-in or setting
 * whatever terminal runs the test (a Cindy task terminal carries XDT_* and CINDY_* variables such as
 * XDT_OFFICIAL_SHARED_PROFILE). Drops every XDT_ / CINDY_ variable and NODE_OPTIONS / NODE_PATH (any case: Windows
 * keys are case-insensitive), points every home, application-data and temporary directory into `root`, then sets
 * back only what the test passes. `bin` goes first on PATH (stand-in programs).
 */
function isolatedServeEnv(root, bin, set) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(XDT_|CINDY_)/i.test(key) || /^NODE_(OPTIONS|PATH)$/i.test(key)) continue;
    env[key] = value;
  }
  const put = (key, value) => {
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    env[key] = value;
  };
  const dir = (name) => { const full = path.join(root, name); mkdirSync(full, { recursive: true }); return full; };
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  put('PATH', `${bin}${path.delimiter}${process.env[pathKey] ?? ''}`);
  const home = dir('home');
  for (const key of ['HOME', 'USERPROFILE']) put(key, home);
  const temp = dir('temp');
  for (const key of ['TMPDIR', 'TEMP', 'TMP']) put(key, temp);
  put('APPDATA', dir('app-data'));
  put('LOCALAPPDATA', dir('local-app-data'));
  for (const [key, name] of [['XDG_CONFIG_HOME', 'xdg-config'], ['XDG_DATA_HOME', 'xdg-data'], ['XDG_CACHE_HOME', 'xdg-cache'],
    ['XDG_STATE_HOME', 'xdg-state']]) put(key, dir(name));
  for (const [key, value] of Object.entries(set)) put(key, value);
  return env;
}

// Integration: unlike tests with injected binaries, run the default source
// workers against the installed JS package with no dist executable.
test('source proxy and power workers report unavailable without an Electron binary', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-workers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { host, electron } = createSourceElectronTree(root);
  const { createChromiumProxyHelper } = await import(pathToFileURL(path.join(host, 'src/chromium-proxy.ts')));
  const { preparePowerWorker } = await import(pathToFileURL(path.join(host, 'src/platform/assets.mjs')));
  const proxy = createChromiumProxyHelper({ profileDir: root });
  try {
    await proxy.warmUp();
    assert.equal(proxy.state(), 'unavailable');
    await assert.rejects(preparePowerWorker(), { message: 'PLATFORM_MONITOR_UNAVAILABLE' });
    assert.equal(existsSync(path.join(electron, 'entry-ran')), false);
  } finally { await proxy.close(); }
});

// Source serve e2e: an empty native vault used to run Electron's npm installer
// synchronously after publishing the endpoint. Start the real CLI, time the
// first client request, and observe all child-process launches up to refresh.
test('source serve keeps health responsive and refreshes an empty native profile without child processes', {
  skip: !['darwin', 'win32'].includes(process.platform) && 'Linux uses Secret Service instead of Electron',
  timeout: 120_000,
}, async t => {
  t = lifoCleanup(t);
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-no-electron-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { host, electron } = createSourceElectronTree(root);
  const profile = path.join(root, 'profile');
  const launches = path.join(root, 'child-launches');
  writeFileSync(launches, '');
  const env = isolatedServeEnv(root, path.join(root, 'bin'), {
    CINDY_HOST_DATA_DIR: profile, CINDY_HOST_PORT: '0', XDT_DEVICE_ID_OVERRIDE: 'synthetic-host',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost',
  });
  const preload = path.join(host, 'monitor.mjs');
  // Initialize tsx's compiler before observing the application, even with a
  // cold cache. Block and record attempts before they can start any process.
  writeFileSync(path.join(host, 'warm.ts'), 'export const n: number = 1;');
  writeFileSync(preload, `
    import './warm.ts';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendFileSync } from 'node:fs';
    function unexpected(command) {
      appendFileSync(${JSON.stringify(launches)}, String(command?.file ?? command) + '\\n');
      throw new Error('unexpected child process');
    }
    cp.ChildProcess.prototype.spawn = unexpected;
    cp.spawnSync = cp.execSync = cp.execFileSync = unexpected;
    syncBuiltinESMExports();
  `);
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs',
    '--import', './monitor.mjs', 'src/main.ts', 'serve'], { cwd: host, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const lines = createInterface({ input: child.stdout });
  const baseUrl = await new Promise((resolve, reject) => {
    lines.on('line', line => {
      const match = /^cindy-host listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (match) resolve(match[1]);
    });
    exited.then(() => reject(new Error('serve exited before listening: ' + stderr)), reject);
  });
  const headers = { authorization: 'Bearer ' + readFileSync(path.join(profile, 'host-api-token'), 'utf8').trim() };
  const start = performance.now();
  const deadline = AbortSignal.timeout(1000);
  const health = await fetch(baseUrl + '/health', { headers, signal: deadline }).catch(error => {
    if (deadline.aborted) assert.fail('First /health response exceeded its 1000 ms deadline');
    throw error;
  });
  assert.equal(health.status, 200);
  await health.json();
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1000, `/health took ${elapsed} ms`);
  t.diagnostic(`First /health response including its body: ${Math.ceil(elapsed)} ms`);
  const refresh = await fetch(baseUrl + '/api/auth/refresh', { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(readFileSync(launches, 'utf8'), '');
  assert.equal(existsSync(path.join(electron, 'entry-ran')), false);
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).ok, false);
  // The missing-session callback completes asynchronously after the response.
  const teardown = AbortSignal.timeout(5000);
  while (true) {
    const { runtime } = await (await fetch(baseUrl + '/health', { headers, signal: teardown })).json();
    if (runtime.detail?.startsWith('Sign-in expired')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
});

/*
 * Test value (reviewer 2026-11-18): the serve child of the next test cannot reach real data from any terminal.
 * Production entry: the environment isolatedServeEnv builds, as a real child process reads it. Minimal input:
 * variables a Cindy task terminal carries. Tier: unit (one short child process).
 */
test('the serve child environment carries no XDT_ or CINDY_ variable of the terminal and no real directory', async t => {
  const planted = { XDT_OFFICIAL_SHARED_PROFILE: '/should/not/leak', CINDY_SOMETHING: 'leak', CINDY_HOST_DATA_DIR: '/should/not/leak' };
  const before = Object.fromEntries(Object.keys(planted).map(key => [key, process.env[key]]));
  Object.assign(process.env, planted);
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-serve-env-'));
  t.after(() => {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const env = isolatedServeEnv(root, path.join(root, 'bin'), { CINDY_HOST_DATA_DIR: path.join(root, 'profile') });
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  await once(child, 'exit');
  const seen = JSON.parse(out);
  const upper = Object.fromEntries(Object.entries(seen).map(([key, value]) => [key.toUpperCase(), value]));
  assert.deepEqual(Object.keys(upper).filter(key => /^(XDT_|CINDY_)/.test(key)), ['CINDY_HOST_DATA_DIR']);
  assert.equal(upper.CINDY_HOST_DATA_DIR, path.join(root, 'profile'));
  assert.ok(!out.includes('/should/not/leak'), 'no planted value reaches the child');
  for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    assert.ok(upper[key]?.startsWith(root), `${key} is inside the temporary directory`);
  }
  assert.ok(upper.PATH.startsWith(path.join(root, 'bin') + path.delimiter));
});

/*
 * Test value (甲, reviewer 2026-11-18): the reason of a failed start survives a refresh.
 * - Bug: a window in client mode calls /api/auth/refresh as it starts (authManager initialize). With no
 *   saved session that refresh ends the session (HostSessionMissingError), and the session's teardown
 *   disposed the runtime again and cleared the reason: the window was given a sign-in form while the Host
 *   stayed down (walked through on 2026-11-18). A session the server rejects takes the same branch of
 *   performAuthRefresh (the renewal case above asserts it reaches invalidateHostSession).
 * - Production entry: the real `cindy-host serve` (main.ts) in a child process on a temporary profile, its
 *   runtime lease held by this process, so the start is refused as HOST_DATABASE_LOCKED.
 * - Gap: the cases above build the state from a classified error; none runs a refresh after a failed start.
 * - Not covered: a rejected saved session end to end. A saved session needs the system credential store
 *   (keychain or keyring) and the auth endpoint must be https; neither belongs in a unit run.
 * - Credentials: no saved session, so no record is ever decrypted. On macOS and Windows the store only checks
 *   that a record file exists (credentials/store.mjs read; the native codec runs only to decrypt). On Linux
 *   building the store looks up the keyring at once (store.mjs createCredentialStore, secret-tool); a stand-in
 *   `secret-tool` first on PATH answers instead, so no real keyring is read and the session ends as elsewhere.
 * - Environment: isolatedServeEnv (asserted by the test above).
 * - Tier: unit (loopback HTTP and one child process; no network, nothing outside the temporary directory).
 */
test('a refresh after a failed start keeps the start-failure reason (no saved session)', async t => {
  const { acquireHostRuntimeLease } = await import('./runtime-lock.ts');
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-host-start-reason-'));
  const profile = path.join(root, 'profile');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'secret-tool'), `#!${['', 'bin', 'sh'].join('/')}\necho cindy-host-start-reason-test-secret\n`, { mode: 0o755 });
  const lease = acquireHostRuntimeLease(profile, 'owner-locked');
  assert.equal(lease.held, true);
  const hostDir = fileURLToPath(new URL('..', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs', 'src/main.ts', 'serve'], {
    cwd: hostDir, stdio: ['ignore', 'ignore', 'pipe'],
    env: isolatedServeEnv(root, bin, { CINDY_HOST_DATA_DIR: profile, CINDY_HOST_APP_DATA_DIR: path.join(root, 'app-data'),
      CINDY_HOST_OWNER: 'owner-locked', CINDY_HOST_PORT: '0', XDT_DEVICE_ID_OVERRIDE: 'synthetic-host', CINDY_HOST_KEYRING_APPLICATION: 'cindy-host-start-reason-test',
      // Anything that leaves the machine fails at once.
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1' }),
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    lease.release();
    rmSync(root, { recursive: true, force: true });
  });
  const until = async (read, what) => {
    for (let i = 0; i < 600; i++) {
      if (child.exitCode !== null) assert.fail(`cindy-host exited (${child.exitCode}) while waiting for ${what}: ${stderr}`);
      const value = await read().catch(() => null);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const { baseUrl } = await until(async () => JSON.parse(readFileSync(path.join(profile, 'host-endpoint.json'), 'utf8')), 'the endpoint');
  const token = readFileSync(path.join(profile, 'host-api-token'), 'utf8').trim();
  const call = async (method, pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    return { status: response.status, body: await response.json() };
  };
  await until(async () => (await call('POST', '/api/auth/state')).body.hostUnavailable, 'the start to fail');

  const refreshed = await call('POST', '/api/auth/refresh');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.ok, false);
  // The refresh ends the session in the background: wait until its teardown has finished.
  await until(async () => /^Sign-in expired/.test((await call('GET', '/health')).body.runtime?.detail ?? ''), 'the session teardown');
  const state = await call('POST', '/api/auth/state');
  assert.deepEqual(state.body.hostUnavailable, { reason: 'HOST_DATABASE_LOCKED' });
  assert.equal(state.body.authenticated, false);
});
