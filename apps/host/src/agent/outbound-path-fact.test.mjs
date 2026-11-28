/*
 * 测试价值（放行表第 28 行 28a，第二节“Codex 后端不可达时的出站路径”）
 * - 生产入口与可观察结果：经生产的 Host Codex 运行时（真实回环代理）与 createHostAgentGraph 组装出的 Codex
 *   依赖 getOutboundPathFact：一条带 thread-id 的请求经主代理发往网关、网关连不上之后，按这个线程取到的是
 *   这次请求实际出口的判定（代理环境变量给的代理，地址已脱敏，属于网关的 origin）；没走过的线程、没有
 *   线程号时是 null，错误保留通用文案。代理环境变量带用户名和密码时，判定和解析器的快照里都没有它们。maker-core 在“后端不可达”终局升级时把它渲染进用户看到的错误。
 * - 规则依据：桌面 maker-host/index.ts 的 getOutboundPathFact（Codex 代理记的线程出口 origin，加出站代理
 *   解析器按 origin 的判定）；Host 原来写 undefined，上游不可达时只有通用猜测。
 * - 现有覆盖缺口：engine-deps.test.mjs 不起代理；codex-proxy-gate.test.mjs 的上游都是本机地址，解析器
 *   被跳过，也不读这个依赖。
 * - 最小失败输入：依赖写回 undefined；取线程出口时读错代理实例；按别的线程或别的 origin 取判定；快照记下带凭据的代理地址。
 * - tier：integration（真实代理；网关是保留域名，经代理环境变量指向本测试自己的本机监听，监听拒绝
 *   CONNECT，模拟后端不可达；本机不解析也不直连，没有请求离开本机；假 key，不起 Codex，HOME 隔离）。
 * - 实测耗时：见 PR（单独运行本文件）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostProviderConfig } from './provider-config.ts';
import { createHostModelAccess } from './model-access.ts';
import { createHostCodexRuntime } from './codex-runtime.ts';
import { createHostMcpRuntime } from './mcp-runtime.ts';
import { createHostAgentGraph } from './runtime.ts';
import { CODEX_PROXY_TOKEN_HEADER } from './codex-proxy-inbound.ts';
import { getHostOutboundPathSnapshotFor } from '../outbound-proxy.ts';
import { createCredentialStore } from '../credentials/store.mjs';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { createAvailabilityPolicy } from '../../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts';
import { hostRuntimeLayout } from '../runtime-layout.mjs';
import { openOwnerDatabase } from '../../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

const GATEWAY_KEY = 'synthetic-gateway-key';
// A reserved name: through the proxy it is never resolved or dialled from this machine.
const GATEWAY = 'https://gateway.example.test';
// Credentials in the proxy variable: forwarding needs them, the diagnostics must never carry them.
const PROXY_USER = 'proxy-user-fixture';
const PROXY_PASS = 'proxy-pass-fixture';

test('a Codex thread whose backend is unreachable reports the outbound path its request took', { timeout: 120_000 }, async t => {
  t = lifoCleanup(t);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-outbound-fact-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const savedEnv = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]; Object.assign(process.env, savedEnv); });
  process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
  const fixtureHome = process.env.HOME;
  t.mock.method(os, 'homedir', () => fixtureHome);
  await fs.mkdir(process.env.HOME);
  for (const key of ['XDT_OFFICIAL_SHARED_PROFILE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'XDT_CODEX_API_KEY', 'ANTHROPIC_API_KEY',
    'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'no_proxy']) delete process.env[key];

  // The proxy the environment names: it refuses every tunnel, so the gateway is unreachable.
  const connects = [];
  const proxy = createServer((_req, res) => res.writeHead(502).end());
  proxy.on('connect', (req, socket) => { connects.push(req.url); socket.destroy(); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); return new Promise(resolve => proxy.close(resolve)); });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  // The fact goes into a user-visible error; the snapshot is kept for the life of the process.
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY = `http://${PROXY_USER}:${PROXY_PASS}@127.0.0.1:${proxy.address().port}`;
  process.env.NO_PROXY = '127.0.0.1,localhost';

  const profile = path.join(root, 'profile');
  await fs.mkdir(profile, { recursive: true });
  const ownerId = 'outbound-fact-fixture';
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
    writeKey: value => config.builtinStore.set('xd', value), request: async () => ({ endpoint: GATEWAY, apiKey: GATEWAY_KEY }),
    onKeyChanged: () => {}, publish: () => {} });
  await modelAccess.start();
  t.after(() => modelAccess.close());
  const mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: config.remoteBridgeToken });
  t.after(() => mcp.close());
  const runtime = createHostCodexRuntime({ profileDir: profile, binaryPath: path.join(root, 'no-codex-binary'), config, modelAccess, mcp,
    availabilityPolicy: createAvailabilityPolicy(async () => { throw new Error('Unexpected share mutation'); }), publish: () => {} });
  t.after(() => runtime.close());
  const harnessRoot = path.join(root, 'harnesses');
  const ripgrepDir = path.join(harnessRoot, 'ripgrep-bin', `${process.platform}-${process.arch}`);
  await fs.mkdir(ripgrepDir, { recursive: true });
  // Pi resolves the search binary during assembly. No engine or search binary runs in this test.
  await fs.writeFile(path.join(ripgrepDir, process.platform === 'win32' ? 'rg.exe' : 'rg'), '');
  const graph = createHostAgentGraph({ userDataDir: profile, providerConfig: config, mcpRuntime: mcp, codexRuntime: runtime, storage: {},
    gateway: null, mcpProviders: [], harnessRoot,
    // Never spawned: only the constructed Codex agent's dependency is called.
    binaryPath: path.join(root, 'claude'), codexBinaryPath: path.join(root, 'codex'), piBinaryPath: path.join(root, 'pi') });
  const getOutboundPathFact = graph.codex.deps.getOutboundPathFact;

  // Codex's own request, as it sends it: through the main proxy, naming its thread.
  const spawn = await runtime.deps.prepareCodexExtraSpawnConfig([], { credentialMode: 'gateway-key', codexHome: path.join(profile, 'codex-home') });
  const args = spawn.extraArgs;
  const mainProxy = args.map(arg => /^model_providers\.cindy_gateway\.base_url="([^"]*)"$/.exec(arg)?.[1]).find(Boolean);
  assert.ok(mainProxy, 'the main proxy is in the spawn config');
  const threadId = 'thread-unreachable-gateway';
  const res = await fetch(`${mainProxy.replace(/\/$/, '')}/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}`, 'thread-id': threadId,
      [CODEX_PROXY_TOKEN_HEADER]: runtime.inboundToken() },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hi', stream: true }) });
  await res.text();
  assert.ok(res.status >= 500, `the gateway is unreachable (${res.status})`);
  assert.deepEqual([...new Set(connects)], ['gateway.example.test:443'], 'the request went to the proxy the environment names');

  const fact = getOutboundPathFact({ threadId });
  assert.ok(fact, 'a fact for the thread whose request failed');
  const { at, ...rest } = fact;
  assert.equal(typeof at, 'number');
  assert.deepEqual(rest, { source: 'env', kind: 'proxy', proxy: proxyUrl, upstream: GATEWAY });
  // Neither the user name nor the password, in any field, of the fact or of the resolver's snapshot.
  for (const [what, value] of [['fact', fact], ['snapshot', getHostOutboundPathSnapshotFor([GATEWAY])]]) {
    const text = JSON.stringify(value);
    assert.ok(value && !text.includes(PROXY_USER) && !text.includes(PROXY_PASS) && !text.includes('@'), `${what} without credentials: ${text}`);
  }
  // No request of its own, or no thread: the generic error text stays.
  assert.equal(getOutboundPathFact({ threadId: 'thread-never-sent' }), null);
  assert.equal(getOutboundPathFact({}), null);
});
