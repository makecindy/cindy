// Real Claude Code process + production Host assembly + the Host's loopback proxy.
// The upstream is a local fixture, not a model, a gateway or a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const binary = process.env.CINDY_TEST_CLAUDE_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set CINDY_TEST_CLAUDE_BINARY to the native Claude Code binary');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-claude-proxy-e2e-')));
process.env.HOME = path.join(root, 'home'); // Isolated process, never the user's CLI home.
process.env.USERPROFILE = process.env.HOME;
await fs.mkdir(process.env.HOME);
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'XDT_OFFICIAL_SHARED_PROFILE']) delete process.env[key];
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
process.env.DISABLE_AUTOUPDATER = '1';

const requests = [];
const sse = (model) => [
  ['message_start', { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic complete' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* opaque */ }
  requests.push({ url: req.url, apiKey: req.headers['x-api-key'], authorization: req.headers.authorization, model: body?.model });
  if (req.url?.includes('/count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}');
    return;
  }
  if (!req.url?.includes('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"No optional endpoint in fixture"}}');
    return;
  }
  if (body?.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(sse(body.model));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant',
    model: body?.model, content: [{ type: 'text', text: 'synthetic complete' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
});
// Tunnels (any optional HTTPS probe) fail fast instead of hanging.
upstream.on('connect', (_req, socket) => socket.destroy());
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;
process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.ALL_PROXY = endpoint;
process.env.NO_PROXY = '127.0.0.1,localhost';

const { configureHostOwner } = await import('../src/agent/claude-auth.mjs');
const { configureAppDataDir } = await import('../../desktop/src/main/userDataPath.ts');
const { createHostProviderConfig } = await import('../src/agent/provider-config.ts');
const { createHostModelAccess } = await import('../src/agent/model-access.ts');
const { createHostSubscriptionFastPolicies } = await import('../src/agent/codex-runtime.ts');
const { createHostClaudeProxyRuntime } = await import('../src/agent/claude-proxy-runtime.ts');
const { createHostMcpRuntime } = await import('../src/agent/mcp-runtime.ts');
const { createHostAgentGraph } = await import('../src/agent/runtime.ts');
const { createCredentialStore } = await import('../src/credentials/store.mjs');
const { hostRuntimeLayout } = await import('../src/runtime-layout.mjs');
const { openOwnerDatabase } = await import('../../desktop/src/main/localDb/startupCore.ts');
const { createDbClientForHandle } = await import('../../desktop/src/main/localDb/client/createDbClientForHandle.ts');
const { setCurrentDbClient, clearCurrentDbClient } = await import('../../desktop/src/main/localDb/client/current.ts');
const { OwnerSessionStorage } = await import('../../desktop/src/main/localDb/sessionStorageAdapter.ts');
const { createAvailabilityPolicy } = await import('../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts');
const { createCustomProvider } = await import('../../desktop/src/main/maker-host/custom-provider-store.ts');
const { setSessionProvider, clearSessionProvider } = await import('../../desktop/src/main/maker-host/session-provider-store.ts');
const { customProviderSecretStorageKey } = await import('../../desktop/src/shared/providerSecrets.ts');
const { dataOwnerStorageKey } = await import('../../desktop/src/main/dataOwnerPath.ts');
const { initLogger } = await import('../../desktop/src/main/logger.ts');
initLogger({ logDir: path.join(root, 'logs'), isDev: true, level: 'debug' });

const profile = path.join(root, 'profile');
const ownerId = 'claude-proxy-fixture';
const gatewayKey = 'synthetic-gateway-key';
let database, config, modelAccess, mcp, proxy, graph;
const handles = [];
try {
  await fs.mkdir(profile, { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId });
  configureAppDataDir(path.join(root, 'app-data'));
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  const credentials = await createCredentialStore({ userDataDir: profile, platform: 'linux', keyPromise: Promise.resolve(Buffer.alloc(16, 9)) });
  config = createHostProviderConfig({ profileDir: profile, ownerId, credentials, getCodexBinary: () => null,
    gatewayConnected: () => Boolean(modelAccess?.gateway.credential), openExternal: async () => { throw new Error('Unexpected browser request'); } });
  modelAccess = createHostModelAccess({ ownerId, region: 'global', readKey: () => config.builtinStore.get('xd'),
    writeKey: value => config.builtinStore.set('xd', value), request: async () => ({ endpoint, apiKey: gatewayKey }),
    onKeyChanged: () => {}, publish: () => {} });
  await modelAccess.start();
  await createCustomProvider({ id: 'cprov-claude', name: 'Synthetic Anthropic API', auth: { method: 'apiKey' },
    runtimes: { 'claude-code': { baseUrl: `${endpoint}/custom`, wireProtocol: 'anthropic-messages',
      models: [{ id: 'fixture-claude-model', name: 'Fixture', contextWindow: 200_000, maxOutput: 1024 }] } } });
  credentials.write(`owner_${dataOwnerStorageKey(ownerId)}_${customProviderSecretStorageKey('cprov-claude', 'claude-code')}`, 'synthetic-custom-key');
  await config.list();
  mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: config.remoteBridgeToken });
  proxy = createHostClaudeProxyRuntime({ profileDir: profile, gateway: () => modelAccess.gateway,
    fastRequestPolicy: createHostSubscriptionFastPolicies(createAvailabilityPolicy(async () => { throw new Error('Unexpected share mutation'); })).requestPolicy,
    isOpenAiSubscriptionProviderId: id => config.codexAccounts.isOpenAiSubscriptionProviderId(id),
    resolveTaskId: sdk => graph?.maker.listActiveSessions().find(session => session.requestSessionId === sdk)?.id ?? null });
  await proxy.ready();
  assert.equal(new URL(proxy.endpoint()).hostname, '127.0.0.1');
  graph = createHostAgentGraph({ userDataDir: profile, providerConfig: config, gateway: modelAccess.gateway,
    binaryPath: binary, claudeProxy: proxy, mcpRuntime: mcp, mcpProviders: [],
    storage: new OwnerSessionStorage({ db: () => database }) });

  const runTurn = async ({ sessionId, providerId, model }) => {
    setSessionProvider(sessionId, providerId);
    const handle = await graph.agent.startSession({ sessionId, providerId, model, workingDir: root });
    handles.push(handle);
    const events = [];
    const settled = (async () => {
      for await (const event of handle.events()) {
        events.push(event);
        if (event.type === 'done' || event.type === 'error') return event;
      }
      throw new Error('Claude event stream ended without completion');
    })();
    void settled.catch(() => {});
    let timer;
    try {
      return await Promise.race([(async () => {
        await handle.send({ type: 'user', content: 'return synthetic complete' }).catch(error => ({ type: 'error', data: String(error) }));
        return { last: await settled, events };
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Claude turn timed out (${sessionId})`)), 60_000); })]);
    } finally {
      clearTimeout(timer);
      await handle.close().catch(() => {});
      clearSessionProvider(sessionId);
    }
  };

  // 1. Gateway lane: the CLI carries the gateway key; the proxy forwards it to the gateway.
  let before = requests.length;
  const gateway = await runTurn({ sessionId: 'claude-gateway', providerId: 'xd', model: 'claude-sonnet-4-5' });
  assert.equal(gateway.last.type, 'done', JSON.stringify(gateway.last));
  const gatewayRequests = requests.slice(before).filter(r => r.url.includes('/v1/messages') && !r.url.includes('count_tokens'));
  assert.ok(gatewayRequests.length > 0);
  for (const request of gatewayRequests) {
    assert.equal(request.apiKey, gatewayKey);
    assert.ok(request.url.startsWith('/v1/messages'), request.url);
  }
  console.log(`PASS gateway lane: ${gatewayRequests.length} message request(s) with the gateway key`);

  // 2. Custom provider: the CLI holds only the proxy runtime secret; the proxy routes with the provider's key.
  before = requests.length;
  const custom = await runTurn({ sessionId: 'claude-custom', providerId: 'cprov-claude', model: 'fixture-claude-model' });
  assert.equal(custom.last.type, 'done', JSON.stringify(custom.last));
  const customRequests = requests.slice(before).filter(r => r.url.includes('/v1/messages') && !r.url.includes('count_tokens'));
  assert.ok(customRequests.length > 0);
  for (const request of customRequests) {
    assert.ok(request.url.startsWith('/custom/v1/messages'), request.url);
    assert.ok(request.apiKey === 'synthetic-custom-key' || request.authorization === 'Bearer synthetic-custom-key', JSON.stringify(request));
  }
  assert.ok(requests.every(r => r.apiKey !== proxy.inboundSecret() && !String(r.authorization ?? '').includes(proxy.inboundSecret())));
  console.log(`PASS custom provider: ${customRequests.length} request(s) to the provider path with its key; the runtime secret never left the Host`);

  // 3. Subscription route (row 24b): refused locally, nothing reaches the upstream.
  before = requests.length;
  const subscription = await runTurn({ sessionId: 'claude-subscription', providerId: null, model: 'chatgpt/gpt-5.4' });
  assert.notEqual(subscription.last.type, 'done', 'a subscription route must not complete before row 24b');
  assert.equal(requests.slice(before).filter(r => r.model === 'chatgpt/gpt-5.4').length, 0);
  console.log(`PASS subscription route refused: ${JSON.stringify(subscription.last?.data ?? subscription.last).slice(0, 160)}`);
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  for (const handle of handles) await handle.close().catch(() => {});
  await graph?.maker.shutdown();
  await proxy?.close();
  await mcp?.close();
  modelAccess?.close();
  await config?.close();
  if (database) { clearCurrentDbClient(database); await database.dispose(); }
  configureHostOwner({ userDataDir: profile, ownerId: null });
  // Evidence for reports: every model request went to this local fixture.
  console.log(`fixture upstream requests: ${requests.length} (all to ${endpoint})`);
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
