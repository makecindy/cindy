// Unit: the production adapters must not claim OAuth without a current binding
// or accidentally launch Codex against ~/.codex. All files and synthetic tokens
// belong to a new temporary profile; no real CLI or account is accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexLocalCliAuth, createClaudeGatewayAuth } from './runtime.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { bindNativeProviderAuth, unbindNativeProviderAuth } from '../../../desktop/src/main/maker-host/nativeProviderAuthBinding.ts';
import { createHostCodexCredentials } from './codex-credentials.ts';

test('Codex uses only its isolated home and requires the current account binding', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-native-auth-'));
  const home = path.join(profile, 'codex-home');
  try {
    configureHostOwner({ userDataDir: profile, ownerId: 'native-auth-owner-a' });
    const auth = createCodexLocalCliAuth({ credential: 'fixture-gateway' }, async () => { throw Error('Unexpected route'); }, home);
    assert.equal((await auth.getAuthEnv()).CODEX_HOME, home);
    assert.equal((await auth.getState({ providerId: 'openai' })).authenticated, false);
    assert.equal(fs.statSync(home).isDirectory(), true, 'first spawn creates its isolated Codex home');
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-token' } }), { mode: 0o600 });
    assert.equal((await auth.getState({ providerId: 'openai' })).authenticated, false, 'file presence is not account authorization');
    bindNativeProviderAuth('openai', { instanceIsolated: true });
    assert.equal((await auth.getState({ providerId: 'openai' })).authSource, 'oauth');
    unbindNativeProviderAuth('openai', { revoked: true });
    assert.equal((await auth.getState({ providerId: 'openai' })).authenticated, false);
    assert.equal((await auth.getState({ credentialMode: 'gateway-key' })).authSource, 'api-key');
    configureHostOwner({ userDataDir: profile, ownerId: 'native-auth-owner-b' });
    assert.equal((await auth.getState({ providerId: 'openai' })).authenticated, false);
  } finally {
    configureHostOwner({ userDataDir: profile, ownerId: null });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('host-owned Codex requests cannot reuse credentials after refresh, disconnect or account change', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'host-codex-dispatch-'));
  const home = path.join(profile, 'codex-home');
  try {
    configureHostOwner({ userDataDir: profile, ownerId: 'request-owner' });
    fs.mkdirSync(home);
    const write = token => fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
      tokens: { access_token: token, account_id: 'fixture-workspace' },
    }), { mode: 0o600 });
    write('fixture-token-1');
    const auth = createHostCodexCredentials(profile, {
      codexAccountState: () => ({ authenticated: false }),
      codexAccountHome: () => { throw new Error('Unexpected independent account lookup'); },
    });
    await assert.rejects(auth.readForDispatch(), /requires login/);
    bindNativeProviderAuth('openai', { instanceIsolated: true });
    const first = await auth.readForDispatch();
    assert.equal(first.canDispatch(), true);
    write('fixture-token-2');
    assert.equal(first.canDispatch(), false);
    const refreshed = await auth.readForDispatch();
    assert.equal(refreshed.accessToken, 'fixture-token-2');
    unbindNativeProviderAuth('openai', { revoked: true });
    assert.equal(refreshed.canDispatch(), false);
    await assert.rejects(auth.readForDispatch(), /requires login/);
    bindNativeProviderAuth('openai', { instanceIsolated: true });
    const reconnected = await auth.readForDispatch();
    configureHostOwner({ userDataDir: profile, ownerId: 'other-request-owner' });
    assert.equal(reconnected.canDispatch(), false);
    await assert.rejects(auth.readForDispatch(), /requires login/);
  } finally {
    configureHostOwner({ userDataDir: profile, ownerId: null });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('explicit Claude subscription never receives the Cindy gateway key', async () => {
  const auth = createClaudeGatewayAuth({ credential: 'fixture-gateway' });
  assert.deepEqual(await auth.getAuthEnv({ providerId: 'anthropic' }), {});
  assert.deepEqual(await auth.getAuthEnv({ credentialMode: 'oauth-bearer' }), {});
  assert.equal((await auth.getAuthEnv({ providerId: 'xd' })).ANTHROPIC_API_KEY, 'fixture-gateway');
  assert.equal((await createClaudeGatewayAuth(null).getState({ providerId: 'xd' })).authenticated, false);
});

/*
 * 测试价值（放行表第 24 行，24a）
 * - 可观察结果：经回环代理时 Host 的 Claude 认证与桌面 Claude 适配器（auth-adapters.ts
 *   getState/getAuthEnv）同样分支：网关来源带网关 key；显式的非网关来源只带占位凭据（Host 用
 *   代理运行时的密钥），不再直连供应商、不带供应商的 key；代理没就绪时报 proxy_not_ready；
 *   Claude 订阅不经代理、不拿任何 Cindy 凭据。
 * - 最小失败输入：自定义来源仍给 ANTHROPIC_BASE_URL 与供应商 key；代理未就绪仍授权。
 * - tier：unit。
 */
test('through the loopback proxy, Claude carries the gateway key or only the proxy runtime secret', async () => {
  let ready = false;
  const proxy = { isReady: () => ready, inboundSecret: () => 'runtime-secret-fixture' };
  const auth = createClaudeGatewayAuth({ credential: 'fixture-gateway' }, async () => {
    throw new Error('the proxy routes explicit sources; the adapter must not resolve them');
  }, undefined, proxy);
  assert.deepEqual(await auth.getAuthEnv({ credentialMode: 'provider-oauth', providerId: 'cprov-fixture' }),
    { ANTHROPIC_API_KEY: 'runtime-secret-fixture' });
  assert.deepEqual(await auth.getState({ credentialMode: 'provider-oauth', providerId: 'cprov-fixture' }),
    { authenticated: false, errorReason: 'proxy_not_ready' });
  ready = true;
  assert.equal((await auth.getState({ credentialMode: 'provider-oauth', providerId: 'cprov-fixture' })).authenticated, true);
  assert.deepEqual(await auth.getAuthEnv({ credentialMode: 'gateway-key' }), { ANTHROPIC_API_KEY: 'fixture-gateway' });
  assert.deepEqual(await auth.getAuthEnv({}), { ANTHROPIC_API_KEY: 'fixture-gateway' });
  assert.deepEqual(await auth.getAuthEnv({ providerId: 'anthropic', credentialMode: 'oauth-bearer' }), {});
  const noKey = createClaudeGatewayAuth(null, undefined, undefined, proxy);
  assert.deepEqual(await noKey.getState({ credentialMode: 'gateway-key' }), { authenticated: false, errorReason: 'no_key' });
});
