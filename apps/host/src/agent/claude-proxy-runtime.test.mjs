/*
 * 测试价值（放行表第 24 行，24a）
 * - 可观察结果：Host 的 Claude 与 Pi 回环代理（claude-proxy-runtime.ts，用桌面的共用核心）：
 *   只监听 127.0.0.1；入站只放行 Pi 会话 token、当前网关 key 与本运行时发给自家 CLI 的密钥，
 *   其余（含公开的占位常量）一律 401，且模拟上游一次请求都收不到；运行时密钥在路由前换成
 *   占位常量，上游永远看不到它；订阅路线交给 Codex 运行时的订阅桥，没有 Codex 运行时时在本地明确拒绝，都不落到网关；运行时关闭后它服务过的
 *   任务的路由登记、Pi token 都读不到，新运行时换新密钥、旧密钥被拒；Auto 分类器请求失败时
 *   错误原样回给调用方，不变成成功。
 * - 规则依据：放行表第 24 行与第二节（Host 的回环代理要求入站凭据；关闭时按任务 id 清登记）。
 * - 最小失败输入：门不检查或放在路由之后；占位常量被放行；订阅路线回落网关；关闭不清登记；
 *   密钥不随运行时更换。
 * - tier：integration（真实代理与本机 HTTP 服务；假 key，不调模型，HOME 不读）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostClaudeProxyRuntime } from './claude-proxy-runtime.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY } from '../../../desktop/src/main/maker-host/claude-gateway-config.ts';
import { readClaudeSessionRoute } from '../../../desktop/src/main/maker-host/claude-session-route-registry.ts';
import { authenticatePiProxySession } from '../../../desktop/src/main/maker-host/pi-proxy-session-auth.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const GATEWAY_KEY = 'fake-gateway-key';
const CLASSIFIER_PREFIX = 'You are a security monitor for autonomous AI coding agents.';

async function fixture(t, owner) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-claude-proxy-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId: owner });
  configureAppDataDir(path.join(profile, 'app-data'));
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key];
  const requests = [];
  let upgrades = 0;
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body });
      const classifier = body.includes(CLASSIFIER_PREFIX);
      res.writeHead(classifier ? 400 : 200, { 'content-type': 'application/json' });
      res.end(classifier ? '{"type":"error","error":{"type":"invalid_request_error","message":"classifier fixture failure"}}'
        : '{"id":"msg_fixture","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}]}');
    });
  });
  upstream.on('upgrade', (_req, socket) => { upgrades += 1; socket.destroy(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const gatewayEndpoint = `http://127.0.0.1:${upstream.address().port}`;
  const tasks = new Map();
  let gatewayKey = GATEWAY_KEY;
  const start = async (extra = {}) => {
    const runtime = createHostClaudeProxyRuntime({ ...extra, profileDir: profile,
      gateway: () => ({ credential: gatewayKey, endpoint: gatewayEndpoint }),
      fastRequestPolicy: { subscriptionRequestAllowsFast: () => false, withSubscriptionFastRequestPolicy: decision => decision },
      isOpenAiSubscriptionProviderId: id => id === 'openai',
      resolveTaskId: sdk => tasks.get(sdk) ?? null,
    });
    t.after(() => runtime.close());
    await runtime.ready();
    return runtime;
  };
  return { requests, upgrades: () => upgrades, gatewayEndpoint, tasks, start, profile,
    setGatewayKey: key => { gatewayKey = key; } };
}

const post = (runtime, headers, body = { model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) =>
  fetch(new URL('/v1/messages', runtime.endpoint()), { method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body) });

function upgradeStatus(endpoint, headers = []) {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let data = '';
    // real-wait: bound the handshake if the proxy never answers.
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade timed out')); }, 2_000);
    socket.once('error', reject);
    socket.once('connect', () => socket.write([
      'GET /v1/responses HTTP/1.1', `Host: ${url.host}`, 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', ...headers, '', ''].join('\r\n')));
    socket.on('data', chunk => { data += chunk.toString('latin1'); });
    socket.once('close', () => { clearTimeout(timer); resolve(data.split('\r\n')[0] ?? ''); });
  });
}

test('the Host loopback proxy listens on 127.0.0.1 and admits only the credentials Cindy gave its agents', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const env = await fixture(t, 'claude-proxy-gate');
  const runtime = await env.start();
  assert.equal(runtime.isReady(), true);
  assert.equal(new URL(runtime.endpoint()).hostname, '127.0.0.1');
  assert.notEqual(new URL(runtime.endpoint()).origin, env.gatewayEndpoint);

  for (const headers of [{}, { 'x-api-key': 'not-a-cindy-credential' }, { authorization: `Bearer ${GATEWAY_KEY}` },
    { 'x-cindy-pi-session-id': 'task-x', 'x-cindy-pi-session-token': 'forged' }]) {
    const res = await post(runtime, headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal((await res.json()).error.code, 'inbound_credentials_required');
  }
  assert.equal(await upgradeStatus(runtime.endpoint()), 'HTTP/1.1 401 Unauthorized');
  assert.equal(env.requests.length, 0);
  assert.equal(env.upgrades(), 0);

  // The gateway key Cindy gave the gateway lane: forwarded unchanged.
  assert.equal((await post(runtime, { 'x-api-key': GATEWAY_KEY })).status, 200);
  assert.equal(env.requests.at(-1).headers['x-api-key'], GATEWAY_KEY);
  // The runtime secret: routed as the provider placeholder; the gateway route then carries the gateway key.
  const secret = runtime.inboundSecret();
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.equal((await post(runtime, { 'x-api-key': secret })).status, 200);
  assert.equal(env.requests.at(-1).headers['x-api-key'], GATEWAY_KEY);
  assert.ok(env.requests.every(request => !JSON.stringify(request.headers).includes(secret)), 'the secret never leaves the Host');
  // A Pi process with its registered session token.
  const release = runtime.registerPiProxySession('task-pi', 'pi-token-fixture');
  t.after(release);
  assert.equal((await post(runtime, { 'x-cindy-pi-session-id': 'task-pi', 'x-cindy-pi-session-token': 'pi-token-fixture' })).status, 200);
  assert.equal(env.requests.length, 3);
  // An admitted upgrade reaches the WebSocket resolver, which declines it (HTTP fallback).
  assert.equal(await upgradeStatus(runtime.endpoint(), [`x-api-key: ${GATEWAY_KEY}`]), 'HTTP/1.1 426 Upgrade Required');
  assert.equal(env.upgrades(), 0);
});

test('the public provider placeholder is not an inbound credential on the Host', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const env = await fixture(t, 'claude-proxy-placeholder');
  const runtime = await env.start();
  const res = await post(runtime, { 'x-api-key': CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY });
  assert.equal(res.status, 401);
  assert.equal(env.requests.length, 0);
});

test('without a Codex runtime, subscription routes are refused locally and never reach the gateway', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const env = await fixture(t, 'claude-proxy-subscription');
  const runtime = await env.start();
  const claude = await post(runtime, { 'x-api-key': GATEWAY_KEY }, { model: 'chatgpt/gpt-5.4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(claude.status, 403);
  assert.equal((await claude.json()).error.code, 'subscription_route_unavailable');
  const release = runtime.registerPiProxySession('task-sub', 'pi-sub-token', () => 'openai');
  t.after(release);
  const pi = await post(runtime, { 'x-cindy-pi-session-id': 'task-sub', 'x-cindy-pi-session-token': 'pi-sub-token',
    'x-cindy-pi-provider-id': 'openai' }, { model: 'gpt-5.4', input: [] });
  assert.equal(pi.status, 403);
  assert.equal((await pi.json()).error.code, 'subscription_route_unavailable');
  assert.equal(env.requests.length, 0);
});

test('with the subscription bridge, the proxy hands ChatGPT routes to it and never to the gateway', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const env = await fixture(t, 'claude-proxy-bridge');
  const calls = [];
  const answer = (res, lane) => {
    calls.push(lane);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ bridged: lane }));
  };
  // The Codex runtime's bridge (codex-runtime.ts), reduced to the handlers the proxy asks for.
  const subscriptions = {
    bridge: {
      getResponsesBridgeHandler: () => ({ handle: async ({ res }) => answer(res, 'claude') }),
      getPiNativeSubscriptionHandler: () => async ({ res }) => answer(res, 'pi'),
    },
    piWebSocket: {
      resolvePiWebSocketUpstream: () => null,
      createPiWebSocketRequestPreparer: () => async () => {},
      piWebSocketTransforms: () => [],
    },
  };
  const runtime = await env.start({ subscriptions });
  const claude = await post(runtime, { 'x-api-key': GATEWAY_KEY }, { model: 'chatgpt/gpt-5.4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(claude.status, 200);
  assert.deepEqual(await claude.json(), { bridged: 'claude' });
  const release = runtime.registerPiProxySession('task-bridge', 'pi-bridge-token', () => 'openai');
  t.after(release);
  const pi = await post(runtime, { 'x-cindy-pi-session-id': 'task-bridge', 'x-cindy-pi-session-token': 'pi-bridge-token',
    'x-cindy-pi-provider-id': 'openai' }, { model: 'gpt-5.4', input: [] });
  assert.equal(pi.status, 200);
  assert.deepEqual(await pi.json(), { bridged: 'pi' });
  assert.deepEqual(calls, ['claude', 'pi']);
  // A Claude model still goes to the gateway, and the inbound gate still runs first.
  assert.equal((await post(runtime, { 'x-api-key': GATEWAY_KEY })).status, 200);
  assert.equal(env.requests.length, 1);
  assert.equal((await post(runtime, {}, { model: 'chatgpt/gpt-5.4', max_tokens: 8, messages: [] })).status, 401);
  assert.deepEqual(calls, ['claude', 'pi']);
});

test('closing the runtime forgets the route records and Pi tokens of its tasks; the next runtime has a new secret', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const env = await fixture(t, 'claude-proxy-close');
  const first = await env.start();
  env.tasks.set('sdk-1', 'task-1');
  assert.equal((await post(first, { 'x-api-key': GATEWAY_KEY, 'x-claude-code-session-id': 'sdk-1' })).status, 200);
  assert.equal(readClaudeSessionRoute('task-1'), 'gateway');
  first.registerPiProxySession('task-2', 'pi-token-2');
  assert.equal(authenticatePiProxySession('task-2', 'pi-token-2'), true);
  const oldSecret = first.inboundSecret();
  const oldGatewaySecret = first.gatewayInboundSecret();
  const oldEndpoint = first.endpoint();
  await first.close();
  assert.equal(readClaudeSessionRoute('task-1'), null);
  assert.equal(authenticatePiProxySession('task-2', 'pi-token-2'), false);
  await assert.rejects(post({ endpoint: () => oldEndpoint }, { 'x-api-key': oldSecret }));
  await assert.rejects(post({ endpoint: () => oldEndpoint }, { 'x-api-key': oldGatewaySecret }));
  const second = await env.start();
  assert.notEqual(second.inboundSecret(), oldSecret);
  assert.notEqual(second.gatewayInboundSecret(), oldGatewaySecret);
  assert.equal((await post(second, { 'x-api-key': oldSecret })).status, 401);
  assert.equal((await post(second, { 'x-api-key': oldGatewaySecret })).status, 401);
});

// The Claude CLI of a gateway session holds the gateway secret, not the key. Each request goes out
// with the key current when it arrives, routed as the desktop routes a CLI holding the key, so a key
// change does not stop a running task. The secret stops working with its owner and its runtime.
test('a gateway request carries the key current when it arrives, through a key change; an owner change refuses it', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const env = await fixture(t, 'claude-proxy-gateway-secret');
  const runtime = await env.start();
  const secret = runtime.gatewayInboundSecret();
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.notEqual(secret, runtime.inboundSecret());
  env.tasks.set('sdk-key', 'task-key');
  env.tasks.set('sdk-secret', 'task-secret');
  // Routed as the desktop routes a CLI holding the key: the same route record as the key itself.
  assert.equal((await post(runtime, { 'x-api-key': GATEWAY_KEY, 'x-claude-code-session-id': 'sdk-key' })).status, 200);
  assert.equal((await post(runtime, { 'x-api-key': secret, 'x-claude-code-session-id': 'sdk-secret' })).status, 200);
  assert.equal(env.requests.at(-1).headers['x-api-key'], GATEWAY_KEY);
  assert.equal(readClaudeSessionRoute('task-secret'), readClaudeSessionRoute('task-key'));
  assert.equal(readClaudeSessionRoute('task-secret'), 'gateway');
  // The key changes while the CLI keeps the same secret: its next request goes out with the new key.
  env.setGatewayKey('fixture-gateway-key-2');
  assert.equal((await post(runtime, { 'x-api-key': secret })).status, 200);
  assert.equal(env.requests.at(-1).headers['x-api-key'], 'fixture-gateway-key-2');
  assert.equal((await post(runtime, { 'x-api-key': GATEWAY_KEY })).status, 401, 'the replaced key is no longer admitted');
  // Without a gateway key there is nothing to send: refused, as a request without credentials.
  env.setGatewayKey(null);
  assert.equal((await post(runtime, { 'x-api-key': secret })).status, 401);
  env.setGatewayKey(GATEWAY_KEY);
  assert.equal((await post(runtime, { 'x-api-key': secret })).status, 200);
  // Pi is admitted by its session token, not by a key, so a key change does not make the Host refuse
  // a running Pi task. Its gateway request keeps the key Pi holds, routed as on the desktop.
  const releasePi = runtime.registerPiProxySession('task-pi-key', 'pi-key-token');
  t.after(releasePi);
  const pi = { 'x-cindy-pi-session-id': 'task-pi-key', 'x-cindy-pi-session-token': 'pi-key-token', 'x-api-key': GATEWAY_KEY };
  assert.equal((await post(runtime, pi)).status, 200);
  env.setGatewayKey('fixture-gateway-key-3');
  assert.equal((await post(runtime, pi)).status, 200);
  assert.equal(env.requests.at(-1).headers['x-api-key'], GATEWAY_KEY);
  env.setGatewayKey(GATEWAY_KEY);
  // Another owner: the secret of the previous owner's runtime is refused.
  configureHostOwner({ userDataDir: env.profile, ownerId: 'claude-proxy-gateway-secret-next' });
  const before = env.requests.length;
  assert.equal((await post(runtime, { 'x-api-key': secret })).status, 401);
  assert.equal(env.requests.length, before);
  assert.ok(env.requests.every(request => !JSON.stringify(request.headers).includes(secret)), 'the secret never leaves the Host');
});

test('an Auto classifier request that fails reaches the agent as the error it is', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const env = await fixture(t, 'claude-proxy-classifier');
  const runtime = await env.start();
  env.tasks.set('sdk-auto', 'task-auto');
  const res = await post(runtime, { 'x-api-key': GATEWAY_KEY, 'x-claude-code-session-id': 'sdk-auto' },
    { model: 'claude-sonnet-4-5', max_tokens: 8, system: [{ type: 'text', text: CLASSIFIER_PREFIX }],
      messages: [{ role: 'user', content: 'is this tool call safe?' }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.message, 'classifier fixture failure');
  assert.equal(env.requests.length, 1);
});

test('a non-Claude model loses the Anthropic-only field its upstream rejects; a Claude model keeps it', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const env = await fixture(t, 'claude-proxy-strip');
  const runtime = await env.start();
  const body = model => ({ model, max_tokens: 8, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await post(runtime, { 'x-api-key': GATEWAY_KEY }, body('gpt-5.4'))).status, 200);
  assert.equal('output_config' in JSON.parse(env.requests.at(-1).body), false);
  assert.equal((await post(runtime, { 'x-api-key': GATEWAY_KEY }, body('claude-sonnet-4-5'))).status, 200);
  assert.deepEqual(JSON.parse(env.requests.at(-1).body).output_config, { effort: 'high' });
});
