/*
 * 测试价值（放行表第 24 行，Host 的 Codex 回环代理要求入站凭据）
 * - 可观察结果：门只认本运行时发给自家 Codex 的令牌头（常量时间比较），认过就把这个头从同一个
 *   请求头对象里删掉；没带、带错、只带网关 key、只带 OAuth token、只带公开占位常量，一律 403
 *   （不是 401），且门从不抛异常；owner 变了就全部拒绝。启动参数里只有 base_url 指向本运行时
 *   正在运行的代理的 provider 才带上这个头，命令行上只有环境变量名，令牌只在环境变量里；
 *   代理没就绪时回落的网关地址、别的本机地址都不带。每个运行时的令牌不同，至少 32 字节。
 * - 规则依据：评审批准的 Codex 入站门清单（只认令牌头，拒绝回 403）。
 * - 最小失败输入：放行网关 key 或占位常量；认过不删头；回 401；给网关回落地址也加头；令牌出现在命令行上。
 * - tier：unit（不起进程、不起端口）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY } from '../../../desktop/src/main/maker-host/codex-gateway-config.ts';
import { CODEX_PROXY_TOKEN_ENV, CODEX_PROXY_TOKEN_HEADER, createCodexProxyInbound } from './codex-proxy-inbound.ts';

const ctx = headers => ({ method: 'POST', url: '/responses', headers });

test('only the runtime token is admitted, and it is removed before forwarding', () => {
  let current = true;
  const inbound = createCodexProxyInbound(() => current);
  const token = inbound.token();
  assert.ok(Buffer.from(token, 'base64url').length >= 32);
  assert.notEqual(createCodexProxyInbound(() => true).token(), token, 'each runtime has its own token');

  const admitted = { [CODEX_PROXY_TOKEN_HEADER]: token, authorization: 'Bearer synthetic-oauth-token' };
  assert.equal(inbound.authorizeInbound(ctx(admitted)), null);
  assert.deepEqual(admitted, { authorization: 'Bearer synthetic-oauth-token' }, 'the token header is gone, nothing else changed');

  for (const headers of [
    {},
    { [CODEX_PROXY_TOKEN_HEADER]: `${token}x` },
    { [CODEX_PROXY_TOKEN_HEADER]: token.slice(1) },
    { [CODEX_PROXY_TOKEN_HEADER]: '' },
    { authorization: 'Bearer synthetic-gateway-key' },
    { authorization: 'Bearer synthetic-oauth-token', 'chatgpt-account-id': 'synthetic-workspace' },
    { authorization: `Bearer ${CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY}` },
    { authorization: `Bearer ${token}` },
    { 'x-api-key': token },
  ]) {
    const rejection = inbound.authorizeInbound(ctx({ ...headers }));
    assert.equal(rejection?.status, 403, JSON.stringify(headers));
    assert.equal(rejection?.code, 'inbound_credentials_required');
  }
  // A check that would otherwise throw still answers 403, not the package's 401.
  const hostile = new Proxy({}, { get() { throw new Error('hostile headers'); } });
  assert.equal(inbound.authorizeInbound(ctx(hostile))?.status, 403);
  // After an owner change nothing is admitted, not even the token.
  current = false;
  assert.equal(inbound.authorizeInbound(ctx({ [CODEX_PROXY_TOKEN_HEADER]: token }))?.status, 403);
});

test('only providers pointing at a running proxy of this runtime carry the header, by environment variable name', () => {
  const inbound = createCodexProxyInbound(() => true);
  const proxy = 'http://127.0.0.1:41001';
  const controlPlane = 'http://127.0.0.1:41002';
  const fallbackGateway = 'https://gateway.example.test/v1';
  const notRunning = 'http://127.0.0.1:41003';
  assert.equal(inbound.track(proxy, true), proxy);
  inbound.track(controlPlane, true);
  inbound.track(fallbackGateway, false);
  inbound.track(notRunning, false);
  const spawn = {
    extraArgs: [
      '-c', 'features.code_mode_only=true',
      '-c', `model_providers.cindy_gateway.base_url="${proxy}"`,
      '-c', `model_providers.cindy_openai.base_url="${proxy}"`,
      '-c', `model_providers.cprov-a.base_url="${proxy}/custom/route-a"`,
      '-c', `model_providers.cindy_summary.base_url="${controlPlane}"`,
      '-c', `model_providers.direct.base_url="${fallbackGateway}"`,
      '-c', `model_providers.elsewhere.base_url="${notRunning}"`,
      '-c', `model_providers.lookalike.base_url="${proxy}0"`,
    ],
    extraEnv: { EXISTING: '1' },
    other: 'kept',
  };
  const out = inbound.withToken(spawn);
  const added = out.extraArgs.slice(spawn.extraArgs.length);
  assert.deepEqual(added, ['cindy_gateway', 'cindy_openai', 'cprov-a', 'cindy_summary'].flatMap(id =>
    ['-c', `model_providers.${id}.env_http_headers.${CODEX_PROXY_TOKEN_HEADER}="${CODEX_PROXY_TOKEN_ENV}"`]));
  assert.deepEqual(out.extraEnv, { EXISTING: '1', [CODEX_PROXY_TOKEN_ENV]: inbound.token() });
  assert.equal(out.other, 'kept');
  assert.ok(out.extraArgs.every(arg => !arg.includes(inbound.token())), 'the token is never on the command line');
  // A spawn that points nowhere near our proxies (proxy not ready) gets neither the header nor the variable.
  const direct = { extraArgs: ['-c', `model_providers.cindy_gateway.base_url="${fallbackGateway}"`], extraEnv: {} };
  assert.equal(inbound.withToken(direct), direct);
});
