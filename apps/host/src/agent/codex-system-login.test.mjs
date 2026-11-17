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
import { createBridgeTokenReader, createHostBridgeLoginPorts } from './codex-runtime.ts';
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
  const ports = createHostBridgeLoginPorts({
    check() {}, systemLogin: { ...real, reconcile: (...args) => { counts.reconcile++; return real.reconcile(...args); } },
    native: credentials, accounts,
    invalidateNative: async reason => { counts.invalidateNative.push(reason); },
    isProfileHeld: () => held,
  });
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
  return { codexHome, accountHome, jwt, writeLogin: login, snapshot, bridge, counts, now, setHeld: value => { held = value; },
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
