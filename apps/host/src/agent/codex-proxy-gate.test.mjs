/*
 * 测试价值（放行表第 24 行，Host 的 Codex 回环代理要求入站凭据）
 * - 可观察结果：经生产的 Host Codex 运行时（真实代理、真实启动配置）：主代理、控制面代理、自定义
 *   上下文代理三种，启动参数里指向它们的每个 provider 都带上令牌头（只写环境变量名），令牌在环境
 *   变量里；带令牌的请求照常路由到网关、自定义供应商（直连转发），以及经 Responses 转 Anthropic 的
 *   本地处理（buildProviderHeaders）到 Anthropic 协议的供应商，上游收到的请求头里都没有令牌头；不带
 *   令牌、只带网关 key、只带公开占位常量的请求一律 403，上游一次都收不到；WebSocket 握手不带令牌也是 403。
 * - 规则依据：评审批准的 Codex 入站门清单。
 * - 最小失败输入：某一种代理没过门；令牌头被转发到上游；本地处理那条路径漏删；回 401。
 * - tier：integration（真实代理与本机模拟上游；假 key，不调模型，不起 Codex 进程，HOME 隔离）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostProviderConfig } from './provider-config.ts';
import { createHostModelAccess } from './model-access.ts';
import { createHostCodexRuntime } from './codex-runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { CODEX_PROXY_TOKEN_ENV, CODEX_PROXY_TOKEN_HEADER } from './codex-proxy-inbound.ts';
import { createCredentialStore } from '../credentials/store.mjs';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { createAvailabilityPolicy } from '../../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts';
import { createCustomProvider } from '../../../desktop/src/main/maker-host/custom-provider-store.ts';
import { customProviderSecretStorageKey } from '../../../desktop/src/shared/providerSecrets.ts';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';
import { CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY } from '../../../desktop/src/main/maker-host/codex-gateway-config.ts';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { setSessionProvider, clearSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

const GATEWAY_KEY = 'synthetic-gateway-key';

const responsesSse = id => [
  { type: 'response.created', response: { id } },
  { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: 'ok' }] } },
  { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const anthropicSse = [
  ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

function upgradeStatus(endpoint, headers = []) {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let data = '';
    // real-wait: bound the handshake if the proxy never answers.
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade timed out')); }, 3_000);
    socket.once('error', reject);
    socket.once('connect', () => socket.write([
      `GET ${url.pathname.replace(/\/$/, '')}/responses HTTP/1.1`, `Host: ${url.host}`, 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', ...headers, '', ''].join('\r\n')));
    socket.on('data', chunk => { data += chunk.toString('latin1'); });
    socket.once('close', () => { clearTimeout(timer); resolve(data.split('\r\n')[0] ?? ''); });
  });
}

test('every Codex proxy of the Host runtime admits only its token and never forwards it', { timeout: 120_000 }, async t => {
  t = lifoCleanup(t);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-codex-gate-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const savedEnv = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });
  process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
  // In-process reads go through os.homedir(), which reads USERPROFILE on Windows.
  const fixtureHome = process.env.HOME;
  t.mock.method(os, 'homedir', () => fixtureHome);
  await fs.mkdir(process.env.HOME);
  for (const key of ['XDT_OFFICIAL_SHARED_PROFILE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'XDT_CODEX_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[key];

  const requests = [];
  let upgrades = 0;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, headers: req.headers });
    if (req.url?.startsWith('/anthropic/')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' }).end(anthropicSse);
      return;
    }
    if (req.url?.endsWith('/responses')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' }).end(responsesSse(`r${requests.length}`));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"No optional endpoint in fixture"}}');
  });
  upstream.on('upgrade', (_req, socket) => { upgrades += 1; socket.destroy(); });
  upstream.on('connect', (_req, socket) => socket.destroy());
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const endpoint = `http://127.0.0.1:${upstream.address().port}`;
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.ALL_PROXY = endpoint;
  process.env.NO_PROXY = '127.0.0.1,localhost';

  const profile = path.join(root, 'profile');
  await fs.mkdir(profile, { recursive: true });
  const ownerId = 'codex-gate-fixture';
  configureHostOwner({ userDataDir: profile, ownerId });
  t.after(() => configureHostOwner({ userDataDir: profile, ownerId: null }));
  configureAppDataDir(path.join(root, 'app-data'));
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  const database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  t.after(async () => { clearCurrentDbClient(database); await database.dispose(); });
  const credentials = await createCredentialStore({ userDataDir: profile, platform: 'linux', keyPromise: Promise.resolve(Buffer.alloc(16, 7)) });
  let modelAccess;
  const config = createHostProviderConfig({ profileDir: profile, ownerId, credentials, getCodexBinary: () => null,
    gatewayConnected: () => Boolean(modelAccess?.gateway.credential), openExternal: async () => { throw new Error('Unexpected browser request'); } });
  t.after(() => config.close());
  modelAccess = createHostModelAccess({ ownerId, region: 'global', readKey: () => config.builtinStore.get('xd'),
    writeKey: value => config.builtinStore.set('xd', value), request: async () => ({ endpoint, apiKey: GATEWAY_KEY }),
    onKeyChanged: () => {}, publish: () => {} });
  await modelAccess.start();
  t.after(() => modelAccess.close());
  const secret = (id, value) => credentials.write(`owner_${dataOwnerStorageKey(ownerId)}_${customProviderSecretStorageKey(id, 'codex')}`, value);
  await createCustomProvider({ id: 'cprov-responses', name: 'Synthetic Responses API', auth: { method: 'apiKey' },
    runtimes: { codex: { baseUrl: `${endpoint}/custom-openai`, wireProtocol: 'openai-responses',
      models: [{ id: 'fixture-model', name: 'Fixture', contextWindow: 8192, maxOutput: 1024 }] } } });
  secret('cprov-responses', 'synthetic-responses-key');
  await createCustomProvider({ id: 'cprov-anthropic', name: 'Synthetic Anthropic API', auth: { method: 'apiKey' },
    runtimes: { codex: { baseUrl: `${endpoint}/anthropic`, wireProtocol: 'anthropic-messages',
      models: [{ id: 'fixture-claude', name: 'Fixture Claude', contextWindow: 8192, maxOutput: 1024 }] } } });
  secret('cprov-anthropic', 'synthetic-anthropic-key');
  await config.list();
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: config.remoteBridgeToken });
  t.after(() => mcp.close());
  const runtime = createHostCodexRuntime({ profileDir: profile, binaryPath: path.join(root, 'no-codex-binary'), config, modelAccess, mcp,
    availabilityPolicy: createAvailabilityPolicy(async () => { throw new Error('Unexpected share mutation'); }), publish: () => {} });
  t.after(() => runtime.close());
  const token = runtime.inboundToken();
  const codexHome = path.join(profile, 'codex-home');

  // The real spawn config of each kind of Codex host.
  const spawns = {
    main: await runtime.deps.prepareCodexExtraSpawnConfig([], { credentialMode: 'gateway-key', codexHome }),
    controlPlane: await runtime.deps.prepareCodexExtraSpawnConfig([], { hostPurpose: 'control-plane', credentialMode: 'gateway-key', codexHome }),
    scoped: await runtime.deps.prepareCodexExtraSpawnConfig([], { localAuthPolicy: 'isolated', hostScopeKey: 'scope-a', credentialMode: 'gateway-key', codexHome }),
  };
  const baseUrls = {};
  for (const [kind, spawn] of Object.entries(spawns)) {
    const args = spawn.extraArgs;
    assert.equal(spawn.extraEnv[CODEX_PROXY_TOKEN_ENV], token, `${kind}: token in the environment`);
    assert.ok(args.every(arg => !arg.includes(token)), `${kind}: token never on the command line`);
    const providers = [];
    for (let i = 0; i + 1 < args.length; i++) {
      const match = args[i] === '-c' && /^model_providers\.([^.]+)\.base_url="([^"]*)"$/.exec(args[i + 1]);
      if (match) providers.push([match[1], match[2]]);
    }
    assert.ok(providers.length > 0, kind);
    for (const [id, url] of providers) {
      assert.equal(new URL(url).hostname, '127.0.0.1', `${kind}/${id} points at a loopback proxy`);
      assert.ok(args.includes(`model_providers.${id}.env_http_headers.${CODEX_PROXY_TOKEN_HEADER}="${CODEX_PROXY_TOKEN_ENV}"`), `${kind}/${id} carries the header`);
      baseUrls[`${kind}/${id}`] = url;
    }
  }
  const proxies = {
    main: baseUrls['main/cindy_gateway'],
    controlPlane: baseUrls['controlPlane/cindy_gateway'],
    scoped: baseUrls['scoped/cindy_gateway'],
  };
  assert.equal(new Set(Object.values(proxies)).size, 3, 'three distinct proxies');
  const post = (base, headers, body) => fetch(`${base.replace(/\/$/, '')}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const tokenFree = list => list.every(request => !(CODEX_PROXY_TOKEN_HEADER in request.headers) && !JSON.stringify(request.headers).includes(token));

  // Refused without the token, before anything reaches the upstream.
  for (const [kind, base] of Object.entries(proxies)) {
    for (const headers of [{}, { authorization: `Bearer ${GATEWAY_KEY}` }, { authorization: `Bearer ${CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY}` },
      { [CODEX_PROXY_TOKEN_HEADER]: `${token}x` }]) {
      const res = await post(base, headers, { model: 'gpt-5.4', input: 'hi', stream: true });
      assert.equal(res.status, 403, `${kind} ${JSON.stringify(Object.keys(headers))}`);
      assert.equal((await res.json()).error?.code ?? 'inbound_credentials_required', 'inbound_credentials_required');
    }
    assert.equal(await upgradeStatus(base), 'HTTP/1.1 403 Forbidden', `${kind} WebSocket`);
  }
  assert.equal(requests.length, 0);
  assert.equal(upgrades, 0);

  // Admitted with the token: gateway passthrough on every proxy, token never forwarded.
  for (const [kind, base] of Object.entries(proxies)) {
    const before = requests.length;
    const res = await post(base, { authorization: `Bearer ${GATEWAY_KEY}`, [CODEX_PROXY_TOKEN_HEADER]: token },
      { model: 'gpt-5.4', input: 'hi', stream: true });
    assert.equal(res.status, 200, kind);
    await res.text();
    const sent = requests.slice(before);
    assert.ok(sent.length > 0, kind);
    assert.ok(tokenFree(sent), `${kind}: the token header never reaches the upstream`);
  }

  // A task's own provider through the main proxy (Codex names its thread in thread-id): a
  // Responses provider is forwarded, an Anthropic one goes through the Responses-to-Anthropic
  // local handler, whose upstream headers buildProviderHeaders builds.
  for (const [providerId, model, upstreamPath, key] of [
    ['cprov-responses', 'fixture-model', '/custom-openai/', 'synthetic-responses-key'],
    ['cprov-anthropic', 'fixture-claude', '/anthropic/', 'synthetic-anthropic-key'],
  ]) {
    const sessionId = `task-${providerId}`, threadId = `thread-${providerId}`;
    runtime.proxy.registerComposed(sessionId, threadId, 'fixture instructions');
    setSessionProvider(sessionId, providerId);
    try {
      const before = requests.length;
      const res = await post(proxies.main, { authorization: `Bearer ${GATEWAY_KEY}`, 'thread-id': threadId, [CODEX_PROXY_TOKEN_HEADER]: token },
        { model, input: 'hi', stream: true });
      const text = await res.text();
      assert.equal(res.status, 200, `${providerId}: ${text.slice(0, 300)}`);
      const sent = requests.slice(before);
      assert.ok(sent.some(r => r.url.startsWith(upstreamPath)), `${providerId} reached ${upstreamPath}: ${JSON.stringify(sent.map(r => r.url))}`);
      assert.ok(sent.filter(r => r.url.startsWith(upstreamPath)).every(r => r.headers['x-api-key'] === key || r.headers.authorization === `Bearer ${key}`),
        `${providerId} carries its own key`);
      assert.ok(tokenFree(sent), `${providerId}: the token header never reaches the upstream`);
      // Without the token the same task is refused before routing.
      const refused = await post(proxies.main, { authorization: `Bearer ${GATEWAY_KEY}`, 'thread-id': threadId }, { model, input: 'hi', stream: true });
      assert.equal(refused.status, 403);
      await refused.text();
    } finally {
      clearSessionProvider(sessionId);
      runtime.proxy.unregister(sessionId);
    }
  }
});
