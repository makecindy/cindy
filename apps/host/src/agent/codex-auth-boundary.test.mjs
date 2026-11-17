/*
 * 测试价值（放行表第 26 行与 Codex 登录边界）
 * - 可观察结果：Host 的 Codex 登出、登录成功、服务端作废三处收口，逐步对应桌面 maker-host/index.ts 的
 *   setOnLogoutSuccess（2087 行）、setOnLoginSuccess（2104 行）、setOnInvalidatedBroadcast（2131 行）：
 *   退役所有持本机登录的 Codex 进程、清代理注入、发路由变化、清订阅桥的凭据缓存、让 Pi 的 MCP 桥失效、
 *   作废时通知 AUTH_STATE_CHANGED；退役失败时通知照发。Host 的登出与登录成功确实走到这些步骤，
 *   owner 变了就不走。
 * - 规则依据：桌面的三个钩子；桌面的模型自动刷新冷却与补拉状态在 Host 上没有对应物（放行表第二节）。
 * - 最小失败输入：登出只停共用的那一个进程、不清代理注入、不发路由、不让 Pi 桥失效；退役失败吞掉通知。
 * - tier：unit（只记步骤，不起进程；假账号服务，假 token）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexAuthBoundary } from './codex-auth-boundary.ts';
import { createCodexLocalCliAuth } from './runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { MAKER_PUSH } from '../../../desktop/src/main/maker-ipc/channels.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

function recorder({ retireFails = false } = {}) {
  const steps = [];
  const boundary = createCodexAuthBoundary({
    retireLocalHosts: async reason => { steps.push(`retire local hosts: ${reason}`); if (retireFails) throw new Error('fixture retirement failure'); },
    clearProxyAuthInjection: () => steps.push('clear proxy auth injection'),
    publishRuntimeRoute: () => steps.push('publish runtime route'),
    clearBridgeCredentialCache: () => steps.push('clear bridge credential cache'),
    invalidatePiEnvironment: () => steps.push('invalidate Pi environment'),
    publish: (channel, payload) => steps.push([channel, payload]),
    warn: message => steps.push(`warn: ${message}`),
  });
  return { steps, boundary };
}

test('logout follows the desktop onLogoutSuccess step for step', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { steps, boundary } = recorder();
  await boundary.afterLogout();
  // desktop: forceDisposeLocalHostForAuthChange → clearCodexProxyAuthInjection → broadcastCodexRuntimeRoute → invalidatePiEnvironment
  assert.deepEqual(steps, ['retire local hosts: Codex auth logout', 'clear proxy auth injection', 'publish runtime route', 'invalidate Pi environment']);
});

test('a successful login follows the desktop onLoginSuccess step for step', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { steps, boundary } = recorder();
  await boundary.afterLogin();
  // desktop: clearChatgptBridgeCredentialCache → forceDisposeLocalHostForAuthChange → broadcastCodexRuntimeRoute → invalidatePiEnvironment
  assert.deepEqual(steps, ['clear bridge credential cache', 'retire local hosts: Codex auth login', 'publish runtime route', 'invalidate Pi environment']);
});

test('an invalidation follows the desktop onInvalidatedBroadcast, and still announces when retirement fails', { timeout: TEST_TIMEOUT_MS }, async () => {
  const payload = { agentKind: 'codex', authenticated: false, errorReason: 'token_revoked', credentialScope: 'instance-isolated' };
  const ok = recorder();
  await ok.boundary.afterInvalidation('token_revoked', 'instance-isolated');
  // desktop: forceDispose → clearChatgptBridgeCredentialCache → (catalog refresh) → AUTH_STATE_CHANGED → invalidatePiEnvironment
  assert.deepEqual(ok.steps, ['retire local hosts: Codex credential invalidated: token_revoked', 'clear bridge credential cache',
    [MAKER_PUSH.AUTH_STATE_CHANGED, payload], 'invalidate Pi environment']);
  const failing = recorder({ retireFails: true });
  await failing.boundary.afterInvalidation('token_revoked', 'instance-isolated');
  assert.deepEqual(failing.steps, ['retire local hosts: Codex credential invalidated: token_revoked',
    'warn: Codex invalidation catalog cleanup failed', [MAKER_PUSH.AUTH_STATE_CHANGED, payload], 'invalidate Pi environment']);
});

test('the Host Codex adapter runs the hooks after its own login and logout, and not across an owner change', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-auth-boundary-'));
  t.after(() => { configureHostOwner({ userDataDir: profile, ownerId: null }); fs.rmSync(profile, { recursive: true, force: true }); });
  configureHostOwner({ userDataDir: profile, ownerId: 'boundary-owner-a' });
  const steps = [];
  let loginOk = true;
  const accounts = {
    loginCodexAccount: async () => { steps.push('account login'); return loginOk ? { ok: true } : { ok: false, reason: 'login_failed' }; },
    retireCodexAccount: async () => { steps.push('account retire'); },
    codexAccountState: () => ({ authenticated: true, authSource: 'oauth' }),
    cancelCodexAccountLogin: () => {},
  };
  const native = {
    afterLogin: async () => { steps.push('after login'); },
    afterLogout: async () => { steps.push('after logout'); },
    onAuthBoundary: () => steps.push('clear bridge cache'),
  };
  fs.mkdirSync(path.join(profile, 'codex-home'), { recursive: true });
  const auth = createCodexLocalCliAuth(null, undefined, path.join(profile, 'codex-home'), accounts, undefined, native);
  await auth.logout();
  assert.deepEqual(steps.splice(0), ['account retire', 'after logout', 'clear bridge cache']);
  await auth.triggerLogin();
  assert.deepEqual(steps.splice(0), ['account login', 'after login', 'clear bridge cache']);
  loginOk = false;
  await auth.triggerLogin();
  assert.deepEqual(steps.splice(0), ['account login', 'clear bridge cache'], 'a failed login is not a login success');
  // The owner changed: this adapter's hooks no longer run.
  configureHostOwner({ userDataDir: profile, ownerId: 'boundary-owner-b' });
  await auth.logout().catch(() => {});
  assert.deepEqual(steps, []);
});

// As the desktop's logout (runLogout, disconnectCodexOAuth): a login started before the logout and
// finishing during it does not bind; a login started during it waits for it; and an invalidation
// that rewrote the marker in between is overruled by the logout's last commit.
test('the Host Codex logout wins over a login and an invalidation running alongside it', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const { createHostCodexAccounts } = await import('./provider-config.ts');
  const { invalidateHostCodexLogin, readHostCodexInvalidation } = await import('./codex-invalidation.ts');
  const { readInvalidatedSystemCodexAuthMarker } = await import('../../../desktop/src/main/maker-host/codex-auth-invalidation.ts');
  const { currentCodexCredentialGeneration } = await import('../../../desktop/src/main/maker-host/codexCredentialRead.ts');
  const { bindNativeProviderAuth, isNativeProviderAuthBound } = await import('../../../desktop/src/main/maker-host/nativeProviderAuthBinding.ts');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-logout-'));
  t.after(() => { configureHostOwner({ userDataDir: profile, ownerId: null }); fs.rmSync(profile, { recursive: true, force: true }); });
  configureHostOwner({ userDataDir: profile, ownerId: 'logout-owner' });
  const codexHome = path.join(profile, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const authPath = path.join(codexHome, 'auth.json');
  const write = token => fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: token, account_id: 'fixture-workspace' } }), { mode: 0o600 });

  // 1. A login in progress when the logout starts: it completes, but the logout wins.
  write('fixture-token-1');
  bindNativeProviderAuth('openai', { instanceIsolated: true });
  let finishLogin;
  const accounts = {
    ...createHostCodexAccounts({ profileDir: profile }, { owner: '', check: () => {}, closed: () => false }),
    loginCodexAccount: () => new Promise(resolve => { finishLogin = () => { write('fixture-token-2'); resolve({ ok: true }); }; }),
  };
  const auth = createCodexLocalCliAuth(null, undefined, codexHome, accounts);
  const login = auth.triggerLogin();
  await new Promise(resolve => setImmediate(resolve));
  const logout = auth.logout();
  finishLogin();
  assert.deepEqual(await login, { authenticated: false, errorReason: 'login_cancelled' });
  await logout;
  assert.equal(isNativeProviderAuthBound('openai'), false);
  assert.equal(readInvalidatedSystemCodexAuthMarker(codexHome)?.reason, 'user_disconnected');

  // 2. A login started during a logout waits for it, then runs.
  const order = [];
  const waiting = { ...accounts, loginCodexAccount: async () => { order.push('login'); return { ok: false, reason: 'login_failed' }; },
    retireCodexAccount: async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('logout retired'); } };
  const auth2 = createCodexLocalCliAuth(null, undefined, codexHome, waiting);
  const logout2 = auth2.logout();
  const login2 = auth2.triggerLogin();
  await Promise.all([logout2, login2]);
  assert.deepEqual(order, ['logout retired', 'login']);

  // 3. Codex rewrote auth.json in place during the logout and its rejection came in: the
  //    invalidation rewrote the marker, the logout's last commit restores the disconnect.
  write('fixture-token-3');
  bindNativeProviderAuth('openai', { instanceIsolated: true });
  const native = { afterLogout: async () => {
    const generation = JSON.stringify(currentCodexCredentialGeneration(authPath));
    write('fixture-token-4');
    await invalidateHostCodexLogin({ codexHome, reason: 'token_revoked', isCodexAccountProvider: () => false,
      credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(authPath)) });
    assert.notEqual(generation, null);
    assert.equal(readInvalidatedSystemCodexAuthMarker(codexHome)?.reason, 'token_revoked', 'the invalidation rewrote the marker');
  } };
  const auth3 = createCodexLocalCliAuth(null, undefined, codexHome, accounts, undefined, native);
  await auth3.logout();
  assert.equal(readInvalidatedSystemCodexAuthMarker(codexHome)?.reason, 'user_disconnected');
  assert.equal(readHostCodexInvalidation(codexHome), null, 'no sign-in prompt is left after the explicit disconnect');
});
