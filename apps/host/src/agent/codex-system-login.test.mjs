/*
 * 测试价值
 * - 生产入口与可观察结果：resolveHostSystemCodexAuthPath 在三种运行方式下给出的系统登录路径。
 * - 规则依据：只有安装版 Host 与系统 Codex 登录对账（与已打包桌面相同，读 ~/.codex/auth.json）；
 *   源码运行（开发、测试、沙箱）一律不对账，测试只能给一个指向隔离 HOME 的绝对路径，
 *   安装版忽略这个覆盖。与桌面的对照见 desktop hostCodexSystemLoginParity.test.ts。
 * - 最小失败输入：源码运行默认读 ~/.codex；安装版接受测试覆盖；相对路径被接受。
 * - tier：unit（纯函数，不读写文件）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { HOST_TEST_SYSTEM_CODEX_AUTH_ENV, resolveHostSystemCodexAuthPath } from './codex-system-login.ts';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

test('only an installed Host reconciles with the system Codex login', { timeout: TEST_TIMEOUT_MS }, () => {
  const fake = path.join(os.tmpdir(), 'isolated-home', '.codex', 'auth.json');
  // Installed: the desktop's packaged path; a test override is ignored.
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: true }, {}), path.join(os.homedir(), '.codex', 'auth.json'));
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: true }, { [HOST_TEST_SYSTEM_CODEX_AUTH_ENV]: fake }), path.join(os.homedir(), '.codex', 'auth.json'));
  // Source runs: off by default; only an absolute test path turns it on.
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: false }, {}), null);
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: false }, { [HOST_TEST_SYSTEM_CODEX_AUTH_ENV]: '  ' }), null);
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: false }, { [HOST_TEST_SYSTEM_CODEX_AUTH_ENV]: 'relative/auth.json' }), null);
  assert.equal(resolveHostSystemCodexAuthPath({ packaged: false }, { [HOST_TEST_SYSTEM_CODEX_AUTH_ENV]: fake }), fake);
  // Anything not marked as installed is a source run.
  assert.equal(resolveHostSystemCodexAuthPath({}, {}), null);
  // This checkout is a source run.
  assert.equal(resolveHostSystemCodexAuthPath(undefined, {}), null);
});

// ---- With real profile files (HOME is never read: the system login is a path in a temp dir) ----
import fs from 'node:fs';
import { configureHostOwner } from './claude-auth.mjs';
import { createCodexLocalCliAuth } from './runtime.ts';
import { createHostCodexSystemLogin } from './codex-system-login.ts';
import { invalidateHostCodexLogin } from './codex-invalidation.ts';
import { createHostCodexCredentials } from './codex-credentials.ts';
import { createBridgeTokenReader, createHeldLoginRefusals, createHostBridgeLoginPorts, createHostEngineLoginPorts } from './codex-runtime.ts';
import { createAnthropicResponsesBridgeHost } from '../../../desktop/src/main/maker-host/anthropicResponsesBridgeHostCore.ts';
import { bindNativeProviderAuth, isNativeProviderAuthBound } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.ts';
import { currentCodexCredentialGeneration } from '../../../desktop/src/main/maker-host/codexCredentialRead.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

const authJson = (token) => JSON.stringify({ account: { email: 'fixture@example.test' }, tokens: { access_token: token, account_id: 'workspace-a' } });

function isolatedProfile(t, ownerId) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-system-login-')));
  t.after(() => { configureHostOwner({ userDataDir: root, ownerId: null }); fs.rmSync(root, { recursive: true, force: true }); });
  const profileDir = path.join(root, 'profile');
  configureHostOwner({ userDataDir: profileDir, ownerId });
  const codexHome = path.join(profileDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  return { root, profileDir, codexHome };
}

function sharedProfile(t, ownerId) {
  const { root, profileDir, codexHome } = isolatedProfile(t, ownerId);
  const systemAuth = path.join(root, 'fake-home', '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  fs.writeFileSync(systemAuth, authJson('system-token-1'), { mode: 0o600 });
  try {
    fs.symlinkSync(systemAuth, path.join(codexHome, 'auth.json'), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    // The same shared-directory topology covered by codex-invalidation.test.mjs.
    // A real junction follows atomic target replacement, unlike a hard link or
    // copied auth.json. The just-created codexHome is empty; never remove data.
    fs.rmdirSync(codexHome);
    fs.symlinkSync(path.dirname(systemAuth), codexHome, 'junction');
    t.diagnostic('native file symlink unavailable; checking shared login through a real directory junction');
  }
  bindNativeProviderAuth('openai', { sharedSystem: true });
  const accounts = { isCodexAccountLoginActive: () => false, isCodexAccountProvider: () => false };
  const systemLogin = createHostCodexSystemLogin({ codexHome, systemAuthPath: systemAuth, loginActive: () => false });
  const auth = createCodexLocalCliAuth(null, undefined, codexHome, accounts, undefined, { systemLogin });
  const relogin = (token) => { fs.writeFileSync(`${systemAuth}.next`, authJson(token), { mode: 0o600 }); fs.renameSync(`${systemAuth}.next`, systemAuth); };
  return { profileDir, codexHome, systemAuth, auth, accounts, relogin };
}

// Release table row 26: the desktop clears "recovery required" after an account request (2e);
// before that the Host keeps the mark. The renewed login must still be usable for tasks.
test('after a system re-login the recovered login is usable on the Host, only marked', {
  timeout: TEST_TIMEOUT_MS,
}, async t => {
  t = lifoCleanup(t);
  const p = sharedProfile(t, 'recovery-owner');
  const localAuth = path.join(p.codexHome, 'auth.json');
  const fileSymlink = fs.lstatSync(localAuth).isSymbolicLink();
  p.relogin('system-token-before-invalidation');
  assert.equal(fs.readFileSync(localAuth, 'utf8'), fs.readFileSync(p.systemAuth, 'utf8'),
    'the shared path follows atomic system-login replacement while still linked');
  await invalidateHostCodexLogin({ codexHome: p.codexHome, systemAuthPath: p.systemAuth, reason: 'token_revoked', hostBound: true,
    credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(localAuth)) });
  assert.deepEqual(await p.auth.getState({ credentialMode: 'oauth-bearer' }),
    { authenticated: false, errorReason: 'token_revoked', credentialScope: 'system-shared' });
  // #10577 CI: invalidation unlinks the local file symlink, but must preserve a
  // directory alias of the system's own entry. Only reconciliation restores it.
  assert.equal(fs.existsSync(localAuth), !fileSymlink,
    'invalidation removes only the local file link, not the shared directory entry');
  p.relogin('system-token-2');
  const state = await p.auth.getState({ credentialMode: 'oauth-bearer' });
  assert.equal(fs.readFileSync(localAuth, 'utf8'), fs.readFileSync(p.systemAuth, 'utf8'),
    'reconciliation restores access to the renewed system login');
  assert.equal(state.authenticated, true);
  assert.equal(state.authSource, 'oauth');
  assert.equal(state.recoveryRequiredReason, 'token_revoked');
  assert.equal(state.credentialScope, 'system-shared');
  // What a task spawn and the subscription bridge read.
  assert.deepEqual(await p.auth.getAuthEnv({ credentialMode: 'oauth-bearer' }), { CODEX_HOME: p.codexHome });
  assert.equal(createHostCodexCredentials(p.profileDir, p.accounts).readAccessToken('openai'), 'system-token-2');
});

test('a successful Cindy login reconciles before its auth boundary; a failed one does not', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  for (const ok of [true, false]) {
    // This unit verifies injected login callbacks, not shared-file topology. Like
    // codex-auth-boundary.test.mjs, it only needs an isolated owner/profile.
    const p = isolatedProfile(t, `login-owner-${ok}`);
    const calls = [];
    const systemLogin = { systemAuthPath: null, reconcile: async () => { calls.push('reconcile'); }, reconcileAfterLogin: async () => { calls.push('after-login'); } };
    const accounts = { loginCodexAccount: async () => (ok ? { ok: true } : { ok: false, reason: 'login_failed' }),
      codexAccountState: () => ({ authenticated: ok }), cancelCodexAccountLogin() {} };
    const auth = createCodexLocalCliAuth(null, undefined, p.codexHome, accounts, undefined,
      { systemLogin, afterLogin: async () => { calls.push('boundary'); } });
    assert.deepEqual(await auth.triggerLogin(), ok
      ? { authenticated: true } : { authenticated: false, errorReason: 'login_failed' });
    assert.deepEqual(calls, ok ? ['after-login', 'boundary'] : [], `login ok=${ok}`);
  }
});

test('the subscription bridge reconciles before it reads the native token', { timeout: TEST_TIMEOUT_MS }, async () => {
  const calls = [];
  const read = createBridgeTokenReader({ check: () => calls.push('check'), systemLogin: { reconcile: async () => { calls.push('reconcile'); } },
    readAccessToken: id => { calls.push(`read:${id ?? 'openai'}`); return 'token'; } });
  assert.equal(await read(), 'token');
  assert.deepEqual(calls.splice(0), ['check', 'reconcile', 'check', 'read:openai']);
  await read('openai');
  assert.deepEqual(calls.splice(0), ['check', 'reconcile', 'check', 'read:openai']);
  // An independent account has its own home; the native login is not reconciled for it.
  await read('codex-account-2');
  assert.deepEqual(calls.splice(0), ['check', 'check', 'read:codex-account-2']);
});

/*
 * 测试价值
 * - 生产入口：createCodexLocalCliAuth 的 getState（/api/agents/auth-state 与 /api/agents/status 都不带参数调用它，
 *   maker.ts getAgentAuthState / getAgentStatus），对账用真实的 createHostCodexSystemLogin 和真实的 profile 文件。
 * - 规则：并存方案 A（审核方 2026-11-17 定）。闸门关着时读 Codex 登录状态不对账：对账会改写 codex-home/auth.json
 *   并把登录绑到账号，这两样都和占用 profile 的桌面共用；只按现有的 auth.json 和作废标记作答。
 * - 现有覆盖缺口：之前读状态一律对账，闸门不管读取路径。
 * - 最小失败输入：系统 Codex 已登录、profile 里还没有链接也没有绑定，闸门关着时读一次状态。
 * - tier：unit（临时目录里的真实文件；系统登录是临时目录下的路径，不读 HOME）。
 */
test('while a desktop uses the profile, reading the Codex state does not reconcile, write or bind', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const { root, profileDir, codexHome } = isolatedProfile(t, 'held-owner');
  const systemAuth = path.join(root, 'fake-home', '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  fs.writeFileSync(systemAuth, authJson('system-token-held'), { mode: 0o600 });
  const real = createHostCodexSystemLogin({ codexHome, systemAuthPath: systemAuth, loginActive: () => false });
  let reconciles = 0;
  const systemLogin = { ...real, reconcile: (...args) => { reconciles++; return real.reconcile(...args); } };
  let held = true;
  const auth = createCodexLocalCliAuth(null, undefined, codexHome, { isCodexAccountLoginActive: () => false, isCodexAccountProvider: () => false },
    undefined, { systemLogin, isProfileHeld: () => held });
  // Every entry under the profile: kind, link target and bytes.
  const snapshot = () => {
    const out = {};
    const walk = dir => { for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const stat = fs.lstatSync(file); const key = path.relative(profileDir, file);
      if (stat.isSymbolicLink()) out[key] = `link:${fs.readlinkSync(file)}`;
      else if (stat.isDirectory()) { out[key] = 'dir'; walk(file); }
      else out[key] = fs.readFileSync(file).toString('base64');
    } };
    walk(profileDir);
    return out;
  };
  const before = snapshot();
  // auth-state, then status: both read the state without options.
  await auth.getState();
  await auth.getState();
  assert.equal(reconciles, 0, 'no reconciliation while held');
  assert.deepEqual(snapshot(), before, 'nothing under the profile changed');
  assert.equal(isNativeProviderAuthBound('openai'), false, 'the login was not bound to the account');
  // Released, the same read reconciles: it links the system login and binds it, the writes skipped above.
  held = false;
  const state = await auth.getState();
  assert.ok(reconciles > 0);
  assert.notDeepEqual(snapshot(), before);
  assert.equal(isNativeProviderAuthBound('openai'), true);
  assert.equal(state.authenticated, true);
});

/*
 * 测试价值
 * - 生产入口：订阅桥（共用的 anthropicResponsesBridgeHostCore.ts）用 Host 给它的登录端口
 *   （codex-runtime.ts 的 createHostBridgeLoginPorts，createHostCodexRuntime 原样装上）取 ChatGPT 令牌、读
 *   codex-home/auth.json 或单独添加的 Codex 账号目录、必要时续期（getChatgptBridgeAuth，请求发出前就走这一步），
 *   上游拒绝令牌时经 invalidateChatgptBridgeAuth 作废。对账用真实的 createHostCodexSystemLogin，凭据是临时
 *   profile 里的真实文件。
 * - 规则：并存方案 A（审核方 2026-11-17 定）。闸门关着时：桥读令牌不对账（对账会改写桌面也在用的 auth.json）；
 *   快过期的令牌不续期（两边各自续期会把对方的 refresh token 挤掉），请求带原因失败；上游拒绝时不作废（不删登录
 *   文件、不解绑、不写作废标记），只在本进程记住，之后的请求不再发上游、带同一原因失败；闸门放开后第一次读取照常
 *   对账，确实作废的登录走正常路径。单独添加的 Codex 账号的目录也在共用 profile 里，同样处理。
 * - 现有覆盖缺口：上面的“reconciles before it reads the native token”只测了放开时的顺序。
 * - 最小失败输入：闸门关着时取一次令牌（有效、已过期、快过期），上游拒绝一次再取一次。
 * - tier：unit（临时目录里的真实文件；续期请求是记录调用的桩，不联网）。
 */
function bridgeFixture(t, ownerId) {
  const { root, profileDir, codexHome } = isolatedProfile(t, ownerId);
  const systemAuth = path.join(root, 'fake-home', '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  const accountHome = path.join(profileDir, 'codex-accounts', 'owner-hash', 'acct');
  fs.mkdirSync(accountHome, { recursive: true });
  const jwt = expSec => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`;
  const writeLogin = (home, token) => {
    const body = JSON.stringify({ tokens: { access_token: token, refresh_token: 'refresh-fixture', account_id: 'workspace-a' } });
    fs.writeFileSync(path.join(home, 'auth.json'), body, { mode: 0o600 });
    // A different system login: a reconciliation would act on it.
    fs.writeFileSync(systemAuth, authJson('system-token-other'), { mode: 0o600 });
  };
  bindNativeProviderAuth('openai', { instanceIsolated: true });
  const snapshot = () => {
    const out = {};
    const walk = dir => { for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const stat = fs.lstatSync(file); const key = path.relative(root, file);
      if (stat.isSymbolicLink()) out[key] = `link:${fs.readlinkSync(file)}`;
      else if (stat.isDirectory()) { out[key] = 'dir'; walk(file); }
      else out[key] = fs.readFileSync(file).toString('base64');
    } };
    walk(root);
    return out;
  };
  let held = true;
  const counts = { reconcile: 0, renew: 0, invalidateNative: [], invalidateAccount: [] };
  // The account service as the bridge and the credential reader see it: one added account, signed in.
  const accounts = { isCodexAccountLoginActive: () => false, isCodexAccountProvider: id => id === 'acct',
    codexAccountHome: id => (id === 'acct' ? accountHome : null), codexAccountState: () => ({ authenticated: true }),
    invalidateCodexAccount: async (...args) => { counts.invalidateAccount.push(args); } };
  const credentials = createHostCodexCredentials(profileDir, accounts);
  const real = createHostCodexSystemLogin({ codexHome, systemAuthPath: systemAuth, loginActive: () => false });
  const systemLogin = { ...real, reconcile: (...args) => { counts.reconcile++; return real.reconcile(...args); } };
  // The runtime's invalidateNative, recorded and real (codex-runtime.ts gives it the same input).
  const invalidateNative = async (reason, context) => {
    counts.invalidateNative.push(reason);
    await invalidateHostCodexLogin({ codexHome, systemAuthPath: systemAuth, reason, ...context, isCodexAccountProvider: id => id === 'acct',
      hostBound: context !== undefined, loginInProgress: () => false, isCurrent: () => true });
  };
  // One memory for the bridge and the engine, as createHostCodexRuntime builds them.
  const refusals = createHeldLoginRefusals(() => held);
  const ports = createHostBridgeLoginPorts({ check() {}, systemLogin, native: credentials, accounts, invalidateNative,
    isProfileHeld: () => held, refusals });
  const engine = createHostEngineLoginPorts({ native: credentials, accounts, invalidateNative, isProfileHeld: () => held, refusals });
  // The Codex engine's auth adapter, with the ports runtime.ts createHostAgentGraph passes it.
  const codexAuth = createCodexLocalCliAuth(null, undefined, codexHome, accounts, undefined,
    { systemLogin, isProfileHeld: () => held, invalidate: engine.invalidate, assertNativeLoginUsable: engine.assertNativeLoginUsable });
  const bridge = createAnthropicResponsesBridgeHost({
    subscriptionRequestAllowsFast: () => false, isXaiSubscriptionProviderId: () => false, app: { getPath: () => profileDir },
    // The renewal request: answered with a failure, so a test run never writes a renewed login.
    outboundFetch: async () => { counts.renew++; return new Response('{}', { status: 500 }); },
    getGrokAccessToken: async () => null, peekGrokAccessToken: () => null, invalidateXaiBridgeAuth: async () => false,
    chatgptAccountIdFromTokens: tokens => tokens?.account_id ?? null,
    ...ports,
    isOpenAiSubscriptionProviderId: id => id === 'openai' || id === 'acct', recordXaiRateLimitSnapshot: () => {},
  });
  const now = () => Math.floor(Date.now() / 1000);
  // A new login on disk is read by the next request, as after a login change (the bridge keeps a token up to 30 s).
  const login = (dir, token) => { writeLogin(dir, token); bridge.clearChatgptBridgeCredentialCache(); };
  return { codexHome, accountHome, jwt, writeLogin: login, snapshot, bridge, codexAuth, counts, now, setHeld: value => { held = value; },
    // What the bridge does with an upstream 401 that names a revoked token.
    reject: (providerId, token) => bridge.invalidateChatgptBridgeAuth({ status: 401,
      body: '{"error":{"code":"token_revoked","message":"Your authentication token has been revoked."}}', failedAccessToken: token }, providerId) };
}

for (const [label, providerId, home] of [['the ChatGPT login', 'openai', 'codexHome'], ['an independently added Codex account', 'acct', 'accountHome']]) {
  test(`while a desktop uses the profile, the subscription bridge neither reconciles nor renews ${label}`, { timeout: TEST_TIMEOUT_MS }, async t => {
    t = lifoCleanup(t);
    const f = bridgeFixture(t, `bridge-held-${providerId}`);
    // Held, a valid token: used as it is.
    const valid = f.jwt(f.now() + 3600);
    f.writeLogin(f[home], valid);
    let before = f.snapshot();
    assert.equal((await f.bridge.getChatgptBridgeAuth(providerId)).accessToken, valid);
    assert.deepEqual([f.counts.reconcile, f.counts.renew], [0, 0]);
    assert.deepEqual(f.snapshot(), before, 'no file under the profile or the system login changed');
    // Held, an expired token, and one the bridge would renew early (within its 120 seconds): the
    // request fails, saying why; nothing is renewed or written.
    for (const exp of [f.now() - 60, f.now() + 60]) {
      f.writeLogin(f[home], f.jwt(exp));
      before = f.snapshot();
      await assert.rejects(f.bridge.getChatgptBridgeAuth(providerId),
        /^Error: HOST_PROFILE_IN_USE_BY_DESKTOP: the ChatGPT sign-in has expired, and it is not renewed while a Cindy desktop app/);
      assert.deepEqual([f.counts.reconcile, f.counts.renew], [0, 0]);
      assert.deepEqual(f.snapshot(), before);
    }
    // Released, the same read tries to renew the expiring token (and reconciles the default login).
    f.setHeld(false);
    await f.bridge.getChatgptBridgeAuth(providerId).catch(() => {});
    assert.equal(f.counts.renew, 1);
    assert.equal(f.counts.reconcile > 0, providerId === 'openai');
  });

  test(`while a desktop uses the profile, an upstream rejection of ${label} writes nothing and is not retried`, { timeout: TEST_TIMEOUT_MS }, async t => {
    t = lifoCleanup(t);
    const f = bridgeFixture(t, `bridge-reject-${providerId}`);
    const token = f.jwt(f.now() + 3600);
    f.writeLogin(f[home], token);
    assert.equal((await f.bridge.getChatgptBridgeAuth(providerId)).accessToken, token);
    const before = f.snapshot();
    // Held: the rejection marks, unbinds and removes nothing.
    await f.reject(providerId, token);
    assert.deepEqual([f.counts.invalidateNative, f.counts.invalidateAccount], [[], []]);
    assert.deepEqual(f.snapshot(), before);
    // Later requests with that token fail before the upstream, with the same reason.
    for (let i = 0; i < 2; i++) {
      await assert.rejects(f.bridge.getChatgptBridgeAuth(providerId),
        /^Error: HOST_PROFILE_IN_USE_BY_DESKTOP: OpenAI rejected this ChatGPT sign-in \(token_revoked\)/);
    }
    assert.deepEqual([f.counts.reconcile, f.counts.renew], [0, 0]);
    assert.deepEqual(f.snapshot(), before);
    // Released: the first read reconciles (the default login) and uses the login again; a
    // rejection now takes the normal invalidation.
    f.setHeld(false);
    assert.equal((await f.bridge.getChatgptBridgeAuth(providerId)).accessToken, token);
    assert.equal(f.counts.reconcile > 0, providerId === 'openai');
    // That read forgot the rejection: a later hold does not refuse the same login for it.
    f.setHeld(true);
    assert.equal((await f.bridge.getChatgptBridgeAuth(providerId)).accessToken, token);
    f.setHeld(false);
    await f.reject(providerId, token);
    if (providerId === 'openai') assert.deepEqual(f.counts.invalidateNative, ['token_revoked']);
    else assert.deepEqual(f.counts.invalidateAccount, [['acct', 'token_revoked', token]]);
  });
}

/*
 * 测试价值
 * - 生产入口：Codex 引擎的认证适配器（runtime.ts createCodexLocalCliAuth，带 createHostAgentGraph 传的
 *   invalidate 与 assertNativeLoginUsable，来自 codex-runtime.ts createHostEngineLoginPorts）：引擎在回合中途报
 *   “服务端拒绝了登录”时调 auth.invalidate（maker-core codex/index.ts onAuthInvalidated，带 credentialAttribution
 *   'unproven'），起本机 Codex 前调 getAuthEnv。作废是真实的 invalidateHostCodexLogin，凭据是临时 profile 里的真实文件。
 * - 规则：并存方案 A（审核方 2026-11-17 定）。闸门关着时引擎报拒绝：写标记、解绑、删登录文件都不做，只记进程内的拒绝，
 *   和订阅桥共用同一份记忆——引擎报过，桥的请求带同一原因失败；桥报过，起本机 Codex 也带同一原因失败；
 *   闸门关着时起本机 Codex 也不对账。放开后同样的拒绝走正常作废。
 * - 现有覆盖缺口：桥那两条只测了桥自己报的拒绝。
 * - 最小失败输入：闸门关着时引擎报一次拒绝，再经桥取令牌；反过来桥报一次，再起本机 Codex。
 * - tier：unit（临时目录里的真实文件；续期请求是桩，不联网）。
 */
test('while a desktop uses the profile, an engine-reported rejection writes nothing and the bridge and the engine share it', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = bridgeFixture(t, 'engine-reject');
  const token = f.jwt(f.now() + 3600);
  f.writeLogin(f.codexHome, token);
  const before = f.snapshot();
  // Held, the engine reports a rejection mid-turn: no marker, no unbinding, auth.json kept as it was.
  await f.codexAuth.invalidate('token_revoked', { credentialAttribution: 'unproven' });
  assert.deepEqual(f.counts.invalidateNative, []);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(isNativeProviderAuthBound('openai'), true);
  // The bridge's next request fails before the upstream with that reason, and so does a native spawn.
  const refusal = /^Error: HOST_PROFILE_IN_USE_BY_DESKTOP: OpenAI rejected this ChatGPT sign-in \(token_revoked\)/;
  await assert.rejects(f.bridge.getChatgptBridgeAuth('openai'), refusal);
  await assert.rejects(f.codexAuth.getAuthEnv({ credentialMode: 'oauth-bearer' }), refusal);
  assert.deepEqual([f.counts.reconcile, f.counts.renew], [0, 0]);
  assert.deepEqual(f.snapshot(), before);
  // Released: the same report takes the real invalidation, which writes its marker.
  f.setHeld(false);
  await f.codexAuth.invalidate('token_revoked', { credentialAttribution: 'unproven' });
  assert.deepEqual(f.counts.invalidateNative, ['token_revoked']);
  assert.notDeepEqual(f.snapshot(), before);
});

test('while a desktop uses the profile, a bridge-reported rejection also stops a native Codex spawn, which does not reconcile', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = bridgeFixture(t, 'bridge-then-engine');
  const token = f.jwt(f.now() + 3600);
  f.writeLogin(f.codexHome, token);
  // Held, a spawn on the login is allowed and does not reconcile.
  assert.deepEqual(await f.codexAuth.getAuthEnv({ credentialMode: 'oauth-bearer' }), { CODEX_HOME: f.codexHome });
  assert.equal(f.counts.reconcile, 0);
  await f.bridge.getChatgptBridgeAuth('openai');
  const before = f.snapshot();
  await f.reject('openai', token);
  await assert.rejects(f.codexAuth.getAuthEnv({ credentialMode: 'oauth-bearer' }),
    /^Error: HOST_PROFILE_IN_USE_BY_DESKTOP: OpenAI rejected this ChatGPT sign-in \(token_revoked\)/);
  assert.deepEqual([f.counts.reconcile, f.counts.invalidateNative], [0, []]);
  assert.deepEqual(f.snapshot(), before);
  // Released: the spawn reconciles again and the remembered rejection is gone.
  f.setHeld(false);
  assert.deepEqual(await f.codexAuth.getAuthEnv({ credentialMode: 'oauth-bearer' }), { CODEX_HOME: f.codexHome });
  assert.ok(f.counts.reconcile > 0);
});

// ---- With a production Codex runtime (createHostCodexRuntime) and its provider configuration ----
import fsp from 'node:fs/promises';

// §3.2 unit with isolated login files: getState already skips reconciliation when
// held at entry. The file read in a running reconciliation must also fence writes.
test('Codex reconciliation that loses profile access during the account read leaves the link and binding alone', async t => {
  const { root, codexHome } = isolatedProfile(t, 'reconcile-race-owner');
  const systemAuth = path.join(root, 'system-auth.json');
  fs.writeFileSync(systemAuth, authJson('fixture-token'));
  const readStarted = Promise.withResolvers();
  const continueRead = Promise.withResolvers();
  let held = false;
  const read = fsp.readFile;
  const mockedRead = t.mock.method(fsp, 'readFile', async (file, ...args) => {
    if (file === systemAuth && !held) {
      readStarted.resolve();
      await continueRead.promise;
    }
    return read(file, ...args);
  });
  const systemLogin = createHostCodexSystemLogin({
    codexHome, systemAuthPath: systemAuth, loginActive: () => false, isProfileHeld: () => held,
  });
  const auth = createCodexLocalCliAuth(null, undefined, codexHome, {
    isCodexAccountLoginActive: () => false, isCodexAccountProvider: () => false,
  }, undefined, { systemLogin, isProfileHeld: () => held });
  const state = auth.getState();
  await Promise.race([readStarted.promise, state]);
  held = true;
  continueRead.resolve();
  await state;
  mockedRead.mock.restore();
  assert.deepEqual(fs.readdirSync(codexHome), []);
  assert.equal(isNativeProviderAuthBound('openai'), false);
});

import { createHostProviderConfig } from './provider-config.ts';
import { createHostModelAccess } from './model-access.ts';
import { createHostCodexRuntime } from './codex-runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { createCredentialStore } from '../credentials/store.mjs';
import { hostOutbound } from '../outbound.mjs';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { createAvailabilityPolicy } from '../../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts';
import { createXaiAuthInvalidationHost } from '../../../desktop/src/main/maker-host/xaiAuthInvalidationCore.ts';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';

/** A production Codex runtime on a temporary profile and database, as codex-thread-routes.test.mjs builds it. */
async function productionRuntime(t, ownerId) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-host-held-runtime-')));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const savedEnv = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });
  process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
  const fixtureHome = process.env.HOME;
  t.mock.method(os, 'homedir', () => fixtureHome);
  await fsp.mkdir(fixtureHome);
  for (const key of ['XDT_OFFICIAL_SHARED_PROFILE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'XDT_CODEX_API_KEY', 'ANTHROPIC_API_KEY', HOST_TEST_SYSTEM_CODEX_AUTH_ENV]) delete process.env[key];
  // Every outbound request (token renewals included) is recorded and answered with a failure.
  const outbound = [];
  t.mock.method(hostOutbound, 'outboundFetch', async url => { outbound.push(String(url)); return new Response('{}', { status: 500 }); });
  const profile = path.join(root, 'profile');
  await fsp.mkdir(path.join(profile, 'codex-home'), { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId });
  t.after(() => configureHostOwner({ userDataDir: profile, ownerId: null }));
  configureAppDataDir(path.join(root, 'app-data'));
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  t.after(async () => { clearCurrentDbClient(database); await database.dispose(); });
  const credentials = await createCredentialStore({ userDataDir: profile, platform: 'linux', keyPromise: Promise.resolve(Buffer.alloc(16, 5)) });
  let held = true;
  let modelAccess;
  const config = createHostProviderConfig({ profileDir: profile, ownerId, credentials, getCodexBinary: () => null, isProfileHeld: () => held,
    gatewayConnected: () => Boolean(modelAccess?.gateway.credential), openExternal: async () => { throw new Error('Unexpected browser request'); } });
  t.after(() => config.close());
  modelAccess = createHostModelAccess({ ownerId, region: 'global', readKey: () => config.builtinStore.get('xd'),
    writeKey: value => config.builtinStore.set('xd', value), request: async () => ({ endpoint: 'http://127.0.0.1:9', apiKey: 'synthetic-gateway-key' }),
    onKeyChanged: () => {}, publish: () => {} });
  await modelAccess.start();
  t.after(() => modelAccess.close());
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: config.remoteBridgeToken });
  t.after(() => mcp.close());
  const runtime = createHostCodexRuntime({ profileDir: profile, binaryPath: path.join(root, 'no-codex-binary'), config, modelAccess, mcp,
    availabilityPolicy: createAvailabilityPolicy(async () => { throw new Error('Unexpected share mutation'); }), publish: () => {},
    isProfileHeld: () => held });
  t.after(() => runtime.close());
  const snapshot = () => {
    const out = {};
    const walk = dir => { for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const stat = fs.lstatSync(file); const key = path.relative(profile, file);
      if (stat.isSymbolicLink()) out[key] = `link:${fs.readlinkSync(file)}`;
      else if (stat.isDirectory()) { out[key] = 'dir'; walk(file); }
      // The database and its journal change on their own; the logins do not live there.
      else if (!/\.(db|sqlite)(-wal|-shm|-journal)?$/.test(name)) out[key] = fs.readFileSync(file).toString('base64');
    } };
    walk(profile);
    return out;
  };
  const jwt = expSec => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`;
  return { profile, config, runtime, snapshot, jwt, outbound, setHeld: value => { held = value; } };
}

/*
 * 测试价值
 * - 生产入口：生产的 createHostCodexRuntime 实例：引擎的作废端口（它返回的 invalidateNative，createHostAgentGraph 交给
 *   Codex 引擎）、起本机 Codex 前的检查（assertNativeLoginUsable）、订阅桥（runtime.subscriptions.bridge）。
 * - 规则：并存方案 A（审核方 2026-11-17 定）。桥和引擎共用同一实例里的同一份“闸门关着时被拒过”的记忆：引擎报过，
 *   桥的请求带同一原因失败；桥报过，起本机 Codex 带同一原因失败。这一条由生产的装配保证，fixture 里的手工装配钉不住。
 * - 现有覆盖缺口：上面几条用的是手工装配的端口。
 * - 最小失败输入：闸门关着时，引擎报一次拒绝再经桥取令牌；桥报一次再起本机 Codex。
 * - tier：unit（真实的临时库与 profile；所有对外请求是记录调用的桩）。
 */
test('one production Codex runtime: the engine and the bridge see each other\'s rejection while held', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = await productionRuntime(t, 'held-runtime-owner');
  const token = f.jwt(Math.floor(Date.now() / 1000) + 3600);
  const writeLogin = value => fs.writeFileSync(path.join(f.profile, 'codex-home', 'auth.json'),
    JSON.stringify({ tokens: { access_token: value, refresh_token: 'refresh-fixture', account_id: 'workspace-a' } }), { mode: 0o600 });
  writeLogin(token);
  bindNativeProviderAuth('openai', { instanceIsolated: true });
  const bridge = f.runtime.subscriptions.bridge;
  const refusal = /^Error: HOST_PROFILE_IN_USE_BY_DESKTOP: OpenAI rejected this ChatGPT sign-in \(token_revoked\)/;
  assert.equal((await bridge.getChatgptBridgeAuth('openai')).accessToken, token);
  const before = f.snapshot();
  // The engine reports; the same runtime's bridge refuses the token.
  await f.runtime.invalidateNative('token_revoked', { credentialAttribution: 'unproven' });
  bridge.clearChatgptBridgeCredentialCache();
  await assert.rejects(bridge.getChatgptBridgeAuth('openai'), refusal);
  assert.throws(() => f.runtime.assertNativeLoginUsable(), refusal);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(isNativeProviderAuthBound('openai'), true);
  // Released, the memory is gone; held again with a new login, the bridge reports and the engine refuses.
  f.setHeld(false);
  f.runtime.assertNativeLoginUsable();
  f.setHeld(true);
  const next = f.jwt(Math.floor(Date.now() / 1000) + 3600) + 'b';
  writeLogin(next);
  bridge.clearChatgptBridgeCredentialCache();
  assert.equal((await bridge.getChatgptBridgeAuth('openai')).accessToken, next);
  await bridge.invalidateChatgptBridgeAuth({ status: 401,
    body: '{"error":{"code":"token_revoked","message":"Your authentication token has been revoked."}}', failedAccessToken: next }, 'openai');
  assert.throws(() => f.runtime.assertNativeLoginUsable(), refusal);
  assert.equal(isNativeProviderAuthBound('openai'), true);
  assert.deepEqual(f.outbound, [], 'nothing left this test');
});

/*
 * 测试价值
 * - 生产入口：生产的 createHostProviderConfig 里的 xAI 服务（config.grok，订阅桥、Codex 代理的 xAI 观察者、
 *   供应商 OAuth 令牌读取与自动审查都经它），上游拒绝经 createXaiAuthInvalidationHost(config.grok)，与 codex-runtime.ts 同一装配。
 * - 规则：并存方案 A（审核方 2026-11-17 定）。xAI 登录在共用 profile 的 safe-storage 里，桌面也读写；闸门关着时：
 *   快过期的令牌不续期、带原因失败；上游拒绝时不续期、不登出、不解绑，只记进程内，之后同一令牌带原因失败；放开后照常。
 * - 现有覆盖缺口：之前闸门不管 xAI 的续期与登出。
 * - 最小失败输入：闸门关着时取一次快过期的令牌；上游拒绝一次再取一次。
 * - tier：unit（真实的临时库与 profile；续期请求是记录调用的桩，不联网）。
 */
test('while a desktop uses the profile, the xAI login is neither renewed nor signed out', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = await productionRuntime(t, 'held-xai-owner');
  const grok = f.config.grok;
  const writeLogin = (access, expiresAt) => {
    assert.equal(f.config.builtinStore.set('xai', JSON.stringify({ access_token: access, refresh_token: 'xai-refresh-fixture', expires_at: expiresAt })), true);
    grok.resetGrokOAuthMemoryCache();
  };
  bindNativeProviderAuth('xai', { instanceIsolated: true });
  // Held, a valid token: used as it is.
  writeLogin('xai-token-valid', Date.now() + 3_600_000);
  let before = f.snapshot();
  assert.equal(await grok.getGrokAccessToken(), 'xai-token-valid');
  // Held, a token about to expire (within the 120 seconds the service renews ahead): refused, not renewed.
  writeLogin('xai-token-expiring', Date.now() + 60_000);
  before = f.snapshot();
  await assert.rejects(grok.getGrokAccessToken(),
    /^Error: HOST_PROFILE_IN_USE_BY_DESKTOP: the SuperGrok sign-in has expired, and it is not renewed while a Cindy desktop app/);
  assert.deepEqual(f.outbound, []);
  assert.deepEqual(f.snapshot(), before);
  // Held, the upstream rejects a valid token: nothing renewed, signed out or unbound; the token is refused afterwards.
  writeLogin('xai-token-rejected', Date.now() + 3_600_000);
  before = f.snapshot();
  const xai = createXaiAuthInvalidationHost(grok);
  await xai.invalidateXaiBridgeAuth({ status: 403, body: 'unauthenticated: bad-credentials', failedAccessToken: 'xai-token-rejected' });
  assert.deepEqual(f.outbound, []);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(isNativeProviderAuthBound('xai'), true);
  await assert.rejects(grok.getGrokAccessToken(), /^Error: HOST_PROFILE_IN_USE_BY_DESKTOP: xAI rejected this SuperGrok sign-in/);
  // Released: the token is used again, and a rejection takes the service's forced renewal (one request).
  f.setHeld(false);
  assert.equal(await grok.getGrokAccessToken(), 'xai-token-rejected');
  await xai.invalidateXaiBridgeAuth({ status: 403, body: 'unauthenticated: bad-credentials', failedAccessToken: 'xai-token-rejected' });
  assert.equal(f.outbound.length, 1);
});

/*
 * 测试价值
 * - 生产入口：生产的 createHostProviderConfig 里的自定义供应商 OAuth（config.oauth.readGenericOAuthAccessToken：
 *   setOAuthTokenReader 注册给各代理的路由读取与自动审查都经它），续期请求经 provider-config 传给它的 fetch。
 * - 规则：并存方案 A（审核方 2026-11-17 定）。登录存在共用 profile 的 safe-storage 里；闸门关着时不续期（续期请求不发出，
 *   不消耗 refresh token、不写回），还没过期的令牌照用，已过期的按现有路径报 provider_oauth_refresh_failed；放开后照常续期。
 * - 现有覆盖缺口：之前闸门不管自定义供应商 OAuth 的续期。
 * - 最小失败输入：闸门关着时读一次快过期的令牌、一次已过期的令牌。
 * - tier：unit（真实的临时库与 profile；对外请求是记录调用的桩）。
 */
test('while a desktop uses the profile, a custom provider OAuth sign-in is not renewed', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = await productionRuntime(t, 'held-oauth-owner');
  const descriptor = { tokenUrl: 'https://oauth.example.test/token', clientId: 'fixture-client' };
  const writeLogin = (id, expiresAt) => assert.equal(f.config.recipeSecretIo.write(id,
    JSON.stringify({ access_token: `${id}-access`, refresh_token: `${id}-refresh`, expires_at: expiresAt })), true);
  // Held, about to expire (within the 120 seconds it renews ahead): the current token is used, nothing renewed.
  writeLogin('cprov-expiring', Date.now() + 60_000);
  let before = f.snapshot();
  assert.equal(await f.config.oauth.readGenericOAuthAccessToken('cprov-expiring', descriptor), 'cprov-expiring-access');
  assert.deepEqual(f.outbound, []);
  assert.deepEqual(f.snapshot(), before);
  // Held, expired: the existing refusal, still nothing sent or written.
  writeLogin('cprov-expired', Date.now() - 1_000);
  before = f.snapshot();
  await assert.rejects(f.config.oauth.readGenericOAuthAccessToken('cprov-expired', descriptor), /provider_oauth_refresh_failed/);
  assert.deepEqual(f.outbound, []);
  assert.deepEqual(f.snapshot(), before);
  // Released: the renewal goes out (answered with a failure here, so nothing is written).
  f.setHeld(false);
  writeLogin('cprov-released', Date.now() + 60_000);
  await f.config.oauth.readGenericOAuthAccessToken('cprov-released', descriptor);
  assert.deepEqual(f.outbound, ['https://oauth.example.test/token']);
});

/*
 * 测试价值
 * - 生产入口：生产的 createHostProviderConfig 的 recipeSecretIo（main.ts 交给浏览器运行时，browser.ts 的 recipeSecrets
 *   以 browserRecipeSecretId 的 id 读写它），配方本身是 opencli-vendor 里真实的小宇宙与 Spotify 代码，在 withRecipeHost 里运行。
 * - 规则：并存方案 A（审核方 2026-11-17 定）。续期会轮换 refresh token 的配方（名单只在 held-credentials.ts 一处：小宇宙），
 *   闸门关着时读密钥直接带原因失败，挡在它自己发续期请求之前；Spotify 不轮换，照常；放开后两个都照常。
 * - 现有覆盖缺口：之前闸门不管浏览器配方的密钥。
 * - 最小失败输入：闸门关着时，小宇宙的令牌已到续期时间，发一次请求。
 * - tier：unit（真实的临时库与 profile；配方的 fetch 是记录调用的桩，不联网）。
 */
test('while a desktop uses the profile, the Xiaoyuzhou recipe reads no secret and sends nothing; Spotify is unaffected', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const f = await productionRuntime(t, 'held-recipe-owner');
  const { withRecipeHost, readSecretJSON } = await import('../../../../packages/opencli-vendor/cindy/host.ts');
  const { requestXiaoyuzhouJson } = await import('../../../../packages/opencli-vendor/clis/xiaoyuzhou/auth.js');
  const io = f.config.recipeSecretIo;
  // As browser.ts recipeSecrets: the recipe key under its store id.
  const secrets = { read: key => io.readStrict(`browser-recipe-${key}`), write: (key, value) => io.write(`browser-recipe-${key}`, value) };
  // A token due for renewal, so the recipe's first request would be its renewal.
  assert.equal(io.write('browser-recipe-xiaoyuzhou', JSON.stringify({ access_token: 'xyz-access', refresh_token: 'xyz-refresh', expires_at: Date.now() - 1_000 })), true);
  assert.equal(io.write('browser-recipe-spotify', JSON.stringify({ access_token: 'sp-access', refresh_token: 'sp-refresh', expires_at: Date.now() + 3_600_000 })), true);
  const sent = [];
  const fetchImpl = async url => { sent.push(String(url)); return new Response(JSON.stringify({ success: false }), { status: 500 }); };
  const before = f.snapshot();
  await assert.rejects(withRecipeHost(secrets, () => requestXiaoyuzhouJson('/v1/profile', {}, fetchImpl)),
    /^Error: HOST_PROFILE_IN_USE_BY_DESKTOP: this browser recipe sign-in, whose renewal replaces its refresh token, is not used while a Cindy desktop app/);
  assert.deepEqual(sent, [], 'no renewal and no request left');
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await withRecipeHost(secrets, async () => readSecretJSON('spotify'))).access_token, 'sp-access');
  // Released: the Xiaoyuzhou recipe reads its secret and starts with its renewal; Spotify as before.
  f.setHeld(false);
  await assert.rejects(withRecipeHost(secrets, () => requestXiaoyuzhouJson('/v1/profile', {}, fetchImpl)));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /xiaoyuzhou/i);
  assert.equal((await withRecipeHost(secrets, async () => readSecretJSON('spotify'))).access_token, 'sp-access');
});
