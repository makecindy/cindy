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
import { createBridgeTokenReader } from './codex-runtime.ts';
import { bindNativeProviderAuth } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.ts';
import { currentCodexCredentialGeneration } from '../../../desktop/src/main/maker-host/codexCredentialRead.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

const authJson = (token) => JSON.stringify({ account: { email: 'fixture@example.test' }, tokens: { access_token: token, account_id: 'workspace-a' } });

function sharedProfile(t, ownerId) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-system-login-')));
  t.after(() => { configureHostOwner({ userDataDir: root, ownerId: null }); fs.rmSync(root, { recursive: true, force: true }); });
  const systemAuth = path.join(root, 'fake-home', '.codex', 'auth.json');
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  fs.writeFileSync(systemAuth, authJson('system-token-1'), { mode: 0o600 });
  const profileDir = path.join(root, 'profile');
  configureHostOwner({ userDataDir: profileDir, ownerId });
  const codexHome = path.join(profileDir, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.symlinkSync(systemAuth, path.join(codexHome, 'auth.json'));
  bindNativeProviderAuth('openai', { sharedSystem: true });
  const accounts = { isCodexAccountLoginActive: () => false, isCodexAccountProvider: () => false };
  const systemLogin = createHostCodexSystemLogin({ codexHome, systemAuthPath: systemAuth, loginActive: () => false });
  const auth = createCodexLocalCliAuth(null, undefined, codexHome, accounts, undefined, { systemLogin });
  const relogin = (token) => { fs.writeFileSync(`${systemAuth}.next`, authJson(token), { mode: 0o600 }); fs.renameSync(`${systemAuth}.next`, systemAuth); };
  return { profileDir, codexHome, systemAuth, auth, accounts, relogin };
}

// Release table row 26: the desktop clears "recovery required" after an account request (2e);
// before that the Host keeps the mark. The renewed login must still be usable for tasks.
test('after a system re-login the recovered login is usable on the Host, only marked', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const p = sharedProfile(t, 'recovery-owner');
  await invalidateHostCodexLogin({ codexHome: p.codexHome, systemAuthPath: p.systemAuth, reason: 'token_revoked', hostBound: true,
    credentialGeneration: JSON.stringify(currentCodexCredentialGeneration(path.join(p.codexHome, 'auth.json'))) });
  assert.deepEqual(await p.auth.getState({ credentialMode: 'oauth-bearer' }),
    { authenticated: false, errorReason: 'token_revoked', credentialScope: 'system-shared' });
  p.relogin('system-token-2');
  const state = await p.auth.getState({ credentialMode: 'oauth-bearer' });
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
    const p = sharedProfile(t, `login-owner-${ok}`);
    const calls = [];
    const systemLogin = { systemAuthPath: p.systemAuth, reconcile: async () => { calls.push('reconcile'); }, reconcileAfterLogin: async () => { calls.push('after-login'); } };
    const accounts = { ...p.accounts, loginCodexAccount: async () => (ok ? { ok: true } : { ok: false, reason: 'login_failed' }),
      codexAccountState: () => ({ authenticated: ok }), cancelCodexAccountLogin() {} };
    const auth = createCodexLocalCliAuth(null, undefined, p.codexHome, accounts, undefined,
      { systemLogin, afterLogin: async () => { calls.push('boundary'); } });
    await auth.triggerLogin();
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
