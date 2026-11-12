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

test('logout follows the desktop onLogoutSuccess step for step', async () => {
  const { steps, boundary } = recorder();
  await boundary.afterLogout();
  // desktop: forceDisposeLocalHostForAuthChange → clearCodexProxyAuthInjection → broadcastCodexRuntimeRoute → invalidatePiEnvironment
  assert.deepEqual(steps, ['retire local hosts: Codex auth logout', 'clear proxy auth injection', 'publish runtime route', 'invalidate Pi environment']);
});

test('a successful login follows the desktop onLoginSuccess step for step', async () => {
  const { steps, boundary } = recorder();
  await boundary.afterLogin();
  // desktop: clearChatgptBridgeCredentialCache → forceDisposeLocalHostForAuthChange → broadcastCodexRuntimeRoute → invalidatePiEnvironment
  assert.deepEqual(steps, ['clear bridge credential cache', 'retire local hosts: Codex auth login', 'publish runtime route', 'invalidate Pi environment']);
});

test('an invalidation follows the desktop onInvalidatedBroadcast, and still announces when retirement fails', async () => {
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

test('the Host Codex adapter runs the hooks after its own login and logout, and not across an owner change', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-auth-boundary-'));
  t.after(() => { configureHostOwner({ userDataDir: profile, ownerId: null }); fs.rmSync(profile, { recursive: true, force: true }); });
  configureHostOwner({ userDataDir: profile, ownerId: 'boundary-owner-a' });
  const steps = [];
  let loginOk = true;
  const accounts = {
    loginCodexAccount: async () => { steps.push('account login'); return loginOk ? { ok: true } : { ok: false, reason: 'login_failed' }; },
    logoutCodexAccount: async () => { steps.push('account logout'); },
    codexAccountState: () => ({ authenticated: true, authSource: 'oauth' }),
    cancelCodexAccountLogin: () => {},
  };
  const native = {
    afterLogin: async () => { steps.push('after login'); },
    afterLogout: async () => { steps.push('after logout'); },
    onAuthBoundary: () => steps.push('clear bridge cache'),
  };
  const auth = createCodexLocalCliAuth(null, undefined, path.join(profile, 'codex-home'), accounts, undefined, native);
  await auth.logout();
  assert.deepEqual(steps.splice(0), ['account logout', 'after logout', 'clear bridge cache']);
  await auth.triggerLogin();
  assert.deepEqual(steps.splice(0), ['account login', 'after login', 'clear bridge cache']);
  loginOk = false;
  await auth.triggerLogin();
  assert.deepEqual(steps.splice(0), ['account login', 'clear bridge cache'], 'a failed login is not a login success');
  // The owner changed: this adapter's hooks no longer run.
  configureHostOwner({ userDataDir: profile, ownerId: 'boundary-owner-b' });
  await auth.logout().catch(() => {});
  assert.deepEqual(steps.filter(step => step !== 'account logout'), []);
});
