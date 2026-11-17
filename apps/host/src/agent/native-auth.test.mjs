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
import { buildClaudeEnv } from '../../../../packages/maker-core/src/agents/claude-code/env-builder.ts';
import { CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY } from '../../../desktop/src/main/maker-host/claude-gateway-config.ts';

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
test('through the loopback proxy, Claude carries only the proxy secrets, each paired with the loopback address', async () => {
  const PROXY = 'http://127.0.0.1:4545';
  const UPSTREAM = 'https://gateway.invalid';
  let ready = false;
  const proxy = { isReady: () => ready, endpoint: () => (ready ? PROXY : UPSTREAM),
    inboundSecret: () => 'runtime-secret-fixture', gatewayInboundSecret: () => 'gateway-secret-fixture' };
  const auth = createClaudeGatewayAuth({ credential: 'fixture-gateway' }, async () => {
    throw new Error('the proxy routes explicit sources; the adapter must not resolve them');
  }, undefined, proxy);
  // Not ready: what the desktop CLI carries (the public placeholder, the key itself).
  assert.deepEqual(await auth.getAuthEnv({ credentialMode: 'provider-oauth', providerId: 'cprov-fixture' }),
    { ANTHROPIC_API_KEY: CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY });
  assert.deepEqual(await auth.getState({ credentialMode: 'provider-oauth', providerId: 'cprov-fixture' }),
    { authenticated: false, errorReason: 'proxy_not_ready' });
  assert.deepEqual(await auth.getAuthEnv({ credentialMode: 'gateway-key' }), { ANTHROPIC_API_KEY: 'fixture-gateway' });
  assert.deepEqual(await auth.getAuthEnv({}), { ANTHROPIC_API_KEY: 'fixture-gateway' });
  assert.equal(await auth.getOneShotAuth(), null, 'the desktop fallback: the key on the engine endpoint');
  ready = true;
  assert.equal((await auth.getState({ credentialMode: 'provider-oauth', providerId: 'cprov-fixture' })).authenticated, true);
  // Ready: each secret comes with the loopback address it belongs to.
  assert.deepEqual(await auth.getAuthEnv({ credentialMode: 'provider-oauth', providerId: 'cprov-fixture' }),
    { ANTHROPIC_API_KEY: 'runtime-secret-fixture', ANTHROPIC_BASE_URL: PROXY });
  assert.deepEqual(await auth.getAuthEnv({ credentialMode: 'gateway-key' }), { ANTHROPIC_API_KEY: 'gateway-secret-fixture', ANTHROPIC_BASE_URL: PROXY });
  assert.deepEqual(await auth.getAuthEnv({}), { ANTHROPIC_API_KEY: 'gateway-secret-fixture', ANTHROPIC_BASE_URL: PROXY });
  assert.deepEqual(await auth.getAuthEnv({ providerId: 'anthropic', credentialMode: 'oauth-bearer' }), {});
  // The one-shot request without a Claude Code login: the secret with its address, never the upstream.
  assert.deepEqual(await auth.getOneShotAuth(), { apiKey: 'gateway-secret-fixture', baseURL: PROXY });
  const noKey = createClaudeGatewayAuth(null, undefined, undefined, proxy);
  assert.deepEqual(await noKey.getState({ credentialMode: 'gateway-key' }), { authenticated: false, errorReason: 'no_key' });
  // No gateway key: no gateway secret either, as the desktop sets no key.
  assert.deepEqual(await noKey.getAuthEnv({ credentialMode: 'gateway-key' }), {});
  assert.equal(await noKey.getOneShotAuth(), null);

  // The spawn environment (maker-core buildClaudeEnv reads the endpoint, then the adapter):
  // the proxy becomes ready between the two reads, or stops between them.
  const spawn = async (flip) => {
    let read = false;
    const runtimeConfig = { get endpoint() { const value = proxy.endpoint(); if (!read) { read = true; ready = flip(ready); } return value; } };
    const env = await buildClaudeEnv(auth, runtimeConfig, { credentialMode: 'gateway-key' });
    return [env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_KEY];
  };
  ready = false;
  assert.deepEqual(await spawn(() => true), [PROXY, 'gateway-secret-fixture'], 'became ready: the secret with the loopback address');
  ready = true;
  assert.deepEqual(await spawn(() => false), [PROXY, 'fixture-gateway'], 'stopped: the key itself, never the secret');
  ready = false;
  assert.deepEqual(await spawn(() => false), [UPSTREAM, 'fixture-gateway'], 'never ready: the key on the upstream, as on the desktop');
});
