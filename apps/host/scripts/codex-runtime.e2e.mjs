// Real native Codex process + production Host assembly + real HTTP proxy.
// The upstream is a local fixture, not a model or an OAuth provider.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const binary = process.env.CINDY_TEST_CODEX_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set CINDY_TEST_CODEX_BINARY to the native Codex binary');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-codex-e2e-')));
process.env.HOME = path.join(root, 'home'); // Isolated process, never the user's CLI home.
process.env.USERPROFILE = process.env.HOME;
await fs.mkdir(process.env.HOME);
for (const key of ['XDT_OFFICIAL_SHARED_PROFILE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'XDT_CODEX_API_KEY']) delete process.env[key];
const requests = [];
let onNextResponse;
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!req.url?.endsWith('/responses')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"No optional endpoint in fixture"}}');
    return;
  }
  requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
  const hook = onNextResponse;
  onNextResponse = null;
  await hook?.();
  const id = `fixture-${requests.length}`;
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${id}`,
      content: [{ type: 'output_text', text: 'synthetic complete' }] } },
    { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;
// Any optional native network probe is kept within the fixture too.
process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.ALL_PROXY = endpoint;
process.env.NO_PROXY = '127.0.0.1,localhost';
const { configureHostOwner } = await import('../src/agent/claude-auth.mjs');
const { createHostProviderConfig } = await import('../src/agent/provider-config.ts');
const { createHostModelAccess } = await import('../src/agent/model-access.ts');
const { createHostCodexRuntime } = await import('../src/agent/codex-runtime.ts');
const { createHostMcpRuntime } = await import('../src/agent/mcp-runtime.ts');
const { createHostAgentGraph } = await import('../src/agent/runtime.mjs');
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
const ownerId = 'native-runtime-fixture';
let database, config, modelAccess, mcp, runtime, graph;
const handles = [];
try {
  await fs.mkdir(profile, { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId });
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  const credentials = await createCredentialStore({ userDataDir: profile, platform: 'linux', keyPromise: Promise.resolve(Buffer.alloc(16, 9)) });
  config = createHostProviderConfig({ profileDir: profile, ownerId, credentials, getCodexBinary: () => binary,
    gatewayConnected: () => Boolean(modelAccess?.gateway.credential), openExternal: async () => { throw new Error('Unexpected browser request'); } });
  let gatewayKey = 'synthetic-gateway-key';
  modelAccess = createHostModelAccess({ ownerId, region: 'global', readKey: () => config.builtinStore.get('xd'),
    writeKey: value => config.builtinStore.set('xd', value), request: async () => ({ endpoint, apiKey: gatewayKey }),
    onKeyChanged: () => graph?.gatewayRestart.schedule(), publish: () => {},
  });
  await modelAccess.start();
  await createCustomProvider({ id: 'cprov-fixture', name: 'Synthetic API', auth: { method: 'apiKey' },
    runtimes: { codex: { baseUrl: endpoint, wireProtocol: 'openai-responses',
      models: [{ id: 'fixture-model', name: 'Fixture', contextWindow: 8192, maxOutput: 1024 }] } } });
  credentials.write(`owner_${dataOwnerStorageKey(ownerId)}_${customProviderSecretStorageKey('cprov-fixture', 'codex')}`, 'synthetic-custom-key');
  await config.list();
  mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: config.remoteBridgeToken });
  runtime = createHostCodexRuntime({ profileDir: profile, binaryPath: binary, config, modelAccess, mcp,
    availabilityPolicy: createAvailabilityPolicy(async () => { throw new Error('Unexpected share mutation'); }), publish: () => {},
  });
  graph = createHostAgentGraph({ userDataDir: profile, providerConfig: config, gateway: modelAccess.gateway,
    codexBinaryPath: binary, codexRuntime: runtime, mcpRuntime: mcp, mcpProviders: [],
    storage: new OwnerSessionStorage({ db: () => database }),
  });
  for (const [index, providerId] of ['xd', 'cprov-fixture', 'xd'].entries()) {
    const sessionId = `native-${providerId}-${index}`;
    const expectedKey = providerId === 'xd' ? gatewayKey : 'synthetic-custom-key';
    if (index === 0) onNextResponse = async () => {
      gatewayKey = 'synthetic-refreshed-gateway-key';
      await modelAccess.sync.sync();
    };
    setSessionProvider(sessionId, providerId);
    const handle = await graph.codex.startSession({ sessionId, providerId, model: 'fixture-model', workingDir: root });
    handles.push(handle);
    const events = [];
    const completed = (async () => {
      for await (const event of handle.events()) {
        events.push(event);
        if (event.type === 'error') throw new Error(`Native fixture failed: ${JSON.stringify(event.data)}`);
        if (event.type === 'done') return;
      }
      throw new Error('Native event stream ended without completion');
    })();
    void completed.catch(() => {}); // Observe early failures while send() is still settling.
    let timer;
    try {
      await Promise.race([(async () => {
        await handle.send({ type: 'user', content: 'return synthetic complete' }, { throwOnStartFailure: true });
        await completed;
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native turn timed out')), 45_000); })]);
    } finally { clearTimeout(timer); }
    assert.ok(events.some(event => event.type === 'done'));
    const last = requests.at(-1);
    assert.equal(last.authorization, `Bearer ${expectedKey}`);
    assert.equal(last.body.model, 'fixture-model');
    await handle.close();
    runtime.closeSession(sessionId);
    clearSessionProvider(sessionId);
    graph.gatewayRestart.onSessionSettled();
  }
  assert.ok(requests.length >= 3);
  console.log('PASS native Codex + production Host: gateway and custom provider turns; key rotation during a live turn preserves completion and the next gateway task uses the new key');
} finally {
  for (const handle of handles) await handle.close().catch(() => {});
  graph?.gatewayRestart.clear();
  await graph?.maker.shutdown();
  await runtime?.close();
  await mcp?.close();
  modelAccess?.close();
  await config?.close();
  if (database) { clearCurrentDbClient(database); await database.dispose(); }
  configureHostOwner({ userDataDir: profile, ownerId: null });
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
