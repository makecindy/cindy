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
const responsesSse = [
  { type: 'response.created', response: { id: 'resp_fixture', model: 'gpt-5.4' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
  { type: 'response.output_text.delta', output_index: 0, delta: 'synthetic complete' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
];
let chatgptRejects = false;
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* opaque */ }
  requests.push({ url: req.url, apiKey: req.headers['x-api-key'], authorization: req.headers.authorization, model: body?.model,
    accountId: req.headers['chatgpt-account-id'] });
  // The ChatGPT subscription backend (the bridge's https://chatgpt.com/ is redirected here).
  if (req.url?.startsWith('/chatgpt/')) {
    if (chatgptRejects) {
      res.writeHead(401, { 'content-type': 'application/json' })
        .end('{"error":{"code":"token_revoked","message":"Your authentication token has been revoked."}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(responsesSse.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    return;
  }
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
const connects = [];
upstream.on('connect', (req, socket) => { connects.push(req.url); socket.destroy(); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;
process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.ALL_PROXY = endpoint;
process.env.NO_PROXY = '127.0.0.1,localhost';

const { configureHostOwner } = await import('../src/agent/claude-auth.mjs');
const { configureAppDataDir } = await import('../../desktop/src/main/userDataPath.ts');
const { createHostProviderConfig } = await import('../src/agent/provider-config.ts');
const { createHostModelAccess } = await import('../src/agent/model-access.ts');
const { createHostClaudeProxyRuntime } = await import('../src/agent/claude-proxy-runtime.ts');
const { createHostCodexRuntime } = await import('../src/agent/codex-runtime.ts');
const { hostOutbound } = await import('../src/outbound.mjs');
const { bindNativeProviderAuth } = await import('../../desktop/src/main/maker-host/nativeProviderAuthBinding.ts');
const { readInvalidatedSystemCodexAuthMarker } = await import('../../desktop/src/main/maker-host/codex-auth-invalidation.ts');
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
let database, config, modelAccess, mcp, proxy, graph, codexRuntime;
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
  // A synthetic ChatGPT login in this profile's own codex-home, as an explicit Cindy login leaves it.
  const codexHome = path.join(profile, 'codex-home');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'synthetic-chatgpt-token', account_id: 'synthetic-workspace' } }), { mode: 0o600 });
  bindNativeProviderAuth('openai', { instanceIsolated: true });
  // The bridge's upstream is https://chatgpt.com/; send it to the fixture instead.
  const realFetch = hostOutbound.outboundFetch;
  hostOutbound.outboundFetch = (url, ...rest) => {
    const target = String(url instanceof Request ? url.url : url);
    return realFetch(target.startsWith('https://chatgpt.com/') ? `${endpoint}/chatgpt/${target.slice('https://chatgpt.com/'.length)}` : url, ...rest);
  };
  // The Codex runtime owns the subscription bridge; no Codex process is started here.
  codexRuntime = createHostCodexRuntime({ profileDir: profile, binaryPath: path.join(root, 'no-codex-binary'), config, modelAccess, mcp,
    availabilityPolicy: createAvailabilityPolicy(async () => { throw new Error('Unexpected share mutation'); }), publish: () => {} });
  proxy = createHostClaudeProxyRuntime({ profileDir: profile, gateway: () => modelAccess.gateway,
    fastRequestPolicy: codexRuntime.fastRequestPolicy, subscriptions: codexRuntime.subscriptions,
    isOpenAiSubscriptionProviderId: id => config.codexAccounts.isOpenAiSubscriptionProviderId(id),
    resolveTaskId: sdk => graph?.maker.listActiveSessions().find(session => session.requestSessionId === sdk)?.id ?? null });
  await proxy.ready();
  assert.equal(new URL(proxy.endpoint()).hostname, '127.0.0.1');
  graph = createHostAgentGraph({ userDataDir: profile, providerConfig: config, gateway: modelAccess.gateway,
    binaryPath: binary, claudeProxy: proxy, codexRuntime, mcpRuntime: mcp, mcpProviders: [],
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

  // 3. ChatGPT subscription: the bridge carries the profile's own login to the ChatGPT backend; nothing reaches the gateway.
  before = requests.length;
  const subscription = await runTurn({ sessionId: 'claude-subscription', providerId: null, model: 'chatgpt/gpt-5.4' });
  assert.equal(subscription.last.type, 'done', JSON.stringify(subscription.last));
  const chatgptRequests = requests.slice(before).filter(r => r.url.startsWith('/chatgpt/'));
  assert.ok(chatgptRequests.length > 0);
  for (const request of chatgptRequests) {
    assert.ok(request.url.startsWith('/chatgpt/backend-api/codex/responses'), request.url);
    assert.equal(request.authorization, 'Bearer synthetic-chatgpt-token');
    assert.equal(request.accountId, 'synthetic-workspace');
  }
  assert.equal(requests.slice(before).filter(r => r.url.includes('/v1/messages') && !r.url.includes('count_tokens')).length, 0);
  console.log(`PASS ChatGPT subscription: ${chatgptRequests.length} request(s) to the ChatGPT backend with the profile's login, none to the gateway`);

  // 4. The backend revokes that login: the bridge invalidates it in the profile, and the next turn does not reuse it.
  chatgptRejects = true;
  before = requests.length;
  const revoked = await runTurn({ sessionId: 'claude-subscription-revoked', providerId: null, model: 'chatgpt/gpt-5.4' });
  assert.notEqual(revoked.last.type, 'done');
  const marker = readInvalidatedSystemCodexAuthMarker(codexHome);
  assert.equal(marker?.reason, 'token_revoked');
  assert.equal(marker?.credentialScope, 'instance-isolated');
  await assert.rejects(fs.access(path.join(codexHome, 'auth.json')));
  // The next ChatGPT request (as the CLI would send it) finds no login and sends nothing upstream.
  // (A full CLI turn here only retries the local failure with backoff, as on the desktop.)
  const afterRevoked = requests.length;
  const next = await fetch(new URL('/v1/messages', proxy.endpoint()), { method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': gatewayKey },
    body: JSON.stringify({ model: 'chatgpt/gpt-5.4', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) });
  assert.ok(next.status >= 400, String(next.status));
  await next.text();
  assert.equal(requests.length, afterRevoked);
  assert.equal(requests.slice(before).filter(r => r.url.includes('/v1/messages') && !r.url.includes('count_tokens')).length, 0);
  console.log(`PASS revoked login: marker ${marker.reason}, auth.json removed, the next request got ${next.status} and sent nothing upstream`);

  // 5. A Claude Code login is connected (synthetic status and binding): the Host's own one-shot
  // request uses the gateway key on the gateway endpoint, as the desktop's getOneShotAuth, and
  // never the subscription.
  const { publishClaudeCliLoginStatus } = await import('../../desktop/src/main/maker-host/claude-native-cli-status.ts');
  publishClaudeCliLoginStatus({ loggedIn: true, email: 'fixture@example.test', subscriptionType: 'pro', authMethod: 'claude.ai' });
  bindNativeProviderAuth('anthropic', { instanceIsolated: true });
  assert.deepEqual(await graph.agent.deps.auth.getOneShotAuth(), { apiKey: gatewayKey, baseURL: endpoint });
  before = requests.length;
  const connectsBefore = connects.length;
  assert.equal(await graph.maker.oneShot('claude-code', 'return synthetic complete', { model: 'claude-sonnet-4-5', timeoutMs: 30_000 }), 'synthetic complete');
  const oneShotRequests = requests.slice(before);
  assert.deepEqual(oneShotRequests.map(r => [r.url, r.apiKey, r.authorization]), [['/v1/messages', gatewayKey, undefined]]);
  assert.equal(connects.length, connectsBefore);
  console.log('PASS one-shot with a Claude Code login: one request to the gateway with the gateway key, none elsewhere');
} catch (error) {
  process.exitCode = 1;
  throw error;
} finally {
  for (const handle of handles) await handle.close().catch(() => {});
  await graph?.maker.shutdown();
  await proxy?.close();
  await codexRuntime?.close();
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
