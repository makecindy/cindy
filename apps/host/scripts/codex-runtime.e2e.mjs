// Real native Codex process + production Host assembly + real HTTP proxy.
// The upstream is a local fixture, not a model or an OAuth provider.
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const binary = process.env.CINDY_TEST_CODEX_BINARY;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set CINDY_TEST_CODEX_BINARY to the native Codex binary');
const root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-codex-e2e-')));
process.env.HOME = path.join(root, 'home'); // Isolated process, never the user's CLI home.
process.env.USERPROFILE = process.env.HOME;
await fs.mkdir(process.env.HOME);
for (const key of ['XDT_OFFICIAL_SHARED_PROFILE', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME', 'XDT_CODEX_API_KEY']) delete process.env[key];
const requests = [];
let onNextResponse;
// The OAuth token and revoke endpoints Codex is pointed at (CODEX_*_URL_OVERRIDE below): a
// refresh or revoke attempt lands here and is counted, and never reaches the real service.
const oauthCalls = [];
// CONNECT tunnels (HTTPS through the proxy variables) are counted by host and refused.
const connects = [];
// When set, the fixture first answers with an `exec` tool call that runs `env`, then captures its output.
let toolScenario = null;
// When set, the fixture first answers with an `exec` tool call that writes a memory through the
// Host's cindy_memory MCP server, then captures the tool result.
let memoryScenario = null;
const responsesStream = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const upstream = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url?.startsWith('/oauth/')) {
    oauthCalls.push(req.url);
    res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
    return;
  }
  if (memoryScenario && req.url?.endsWith('/chat/completions')) {
    memoryScenario.reviews.push(JSON.parse(raw).model);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"verdict":"allow","reason":"fixture reviewer"}' } }] }));
    return;
  }
  if (memoryScenario && req.url?.endsWith('/responses')) {
    const body = JSON.parse(raw);
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    memoryScenario.requests.push(body);
    const output = (body.input ?? []).find(item => item?.call_id === 'call-memory' && /_output$/.test(item.type ?? ''));
    const id = `fixture-memory-${requests.length}`;
    const item = output
      ? { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: 'synthetic complete' }] }
      : { type: 'function_call', id: `fc-${id}`, call_id: 'call-memory', name: 'exec',
          arguments: JSON.stringify({ input: `const r = await tools.mcp__cindy_memory__call_tool({ name: 'memory_write', args: { type: 'project', name: '${memoryScenario.name}', title: 'Host e2e memory', description: 'written by a Codex task through the Host MCP bridge', body: 'synthetic memory body' } });\ntext(typeof r === 'string' ? r : JSON.stringify(r));` }) };
    if (output) memoryScenario.output = typeof output.output === 'string' ? output.output : JSON.stringify(output.output);
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(responsesStream([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]));
    return;
  }
  if (toolScenario && req.url?.endsWith('/responses')) {
    const body = JSON.parse(raw);
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    const output = (body.input ?? []).find(item => item?.call_id === 'call-env' && /_output$/.test(item.type ?? ''));
    const id = `fixture-tool-${requests.length}`;
    const item = output
      ? { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: 'synthetic complete' }] }
      : { type: 'function_call', id: `fc-${id}`, call_id: 'call-env', name: 'exec',
          arguments: JSON.stringify({ input: "const r = await tools.exec_command({ cmd: 'env' });\ntext(typeof r === 'string' ? r : JSON.stringify(r));" }) };
    if (output) toolScenario.output = typeof output.output === 'string' ? output.output : JSON.stringify(output.output);
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(responsesStream([{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]));
    return;
  }
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
upstream.on('connect', (req, socket) => { connects.push(req.url ?? ''); socket.destroy(); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${upstream.address().port}`;
process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = `${endpoint}/oauth/token`;
process.env.CODEX_REVOKE_TOKEN_URL_OVERRIDE = `${endpoint}/oauth/revoke`;
// Any optional native network probe is kept within the fixture too.
process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.ALL_PROXY = endpoint;
process.env.NO_PROXY = '127.0.0.1,localhost';
const { configureHostOwner } = await import('../src/agent/claude-auth.mjs');
const { configureAppDataDir } = await import('../../desktop/src/main/userDataPath.ts');
const { createHostProviderConfig } = await import('../src/agent/provider-config.ts');
const { createHostModelAccess } = await import('../src/agent/model-access.ts');
const { createHostCodexRuntime } = await import('../src/agent/codex-runtime.ts');
const { createHostMcpRuntime } = await import('../src/agent/mcp-runtime.ts');
const { ownerScopedUserDataPath } = await import('../../desktop/src/main/appSessionState.ts');
const { createHostAgentGraph } = await import('../src/agent/runtime.ts');
const { createCredentialStore } = await import('../src/credentials/store.mjs');
const { hostRuntimeLayout } = await import('../src/runtime-layout.mjs');
const { openOwnerDatabase } = await import('../../desktop/src/main/localDb/startupCore.ts');
const { createDbClientForHandle } = await import('../../desktop/src/main/localDb/client/createDbClientForHandle.ts');
const { setCurrentDbClient, clearCurrentDbClient, getCurrentDbClientSnapshot } = await import('../../desktop/src/main/localDb/client/current.ts');
const { OwnerSessionStorage } = await import('../../desktop/src/main/localDb/sessionStorageAdapter.ts');
const { createAvailabilityPolicy } = await import('../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.ts');
const { createCustomProvider } = await import('../../desktop/src/main/maker-host/custom-provider-store.ts');
const { setSessionProvider, clearSessionProvider } = await import('../../desktop/src/main/maker-host/session-provider-store.ts');
const { customProviderSecretStorageKey } = await import('../../desktop/src/shared/providerSecrets.ts');
const { dataOwnerStorageKey } = await import('../../desktop/src/main/dataOwnerPath.ts');
const { initLogger } = await import('../../desktop/src/main/logger.ts');
const { CODEX_PROXY_TOKEN_ENV, CODEX_PROXY_TOKEN_HEADER } = await import('../src/agent/codex-proxy-inbound.ts');
const { bindNativeProviderAuth } = await import('../../desktop/src/main/maker-host/nativeProviderAuthBinding.ts');
const { readInvalidatedSystemCodexAuthMarker } = await import('../../desktop/src/main/maker-host/codex-auth-invalidation.ts');
const { eq } = await import('drizzle-orm');
const { sessions, messages } = await import('../../desktop/src/main/localDb/schema.ts');
const { markSessionTurnStarted, markSessionTurnEnded, drainSessionActiveTurnWrites } = await import('../../desktop/src/main/localDb/sessionActiveTurn.ts');
const { createInputQueue } = await import('../src/agent/input-queue.mjs');
const { createHostAttachments } = await import('../src/attachments.ts');
const { createEventHub } = await import('../src/events.mjs');
const { createHostMessageStore } = await import('../src/message-store.ts');
const { createChatHandler } = await import('../src/chat.mjs');
const { attachAgentsToMakerMemory, createHostMemoryManager, createHostMemoryMcpProviders } = await import('../src/agent/memory.mjs');
const { createHostReviewContextResolver } = await import('../src/agent/review-context.ts');
initLogger({ logDir: path.join(root, 'logs'), isDev: true, level: 'debug' });
const profile = path.join(root, 'profile');
const ownerId = 'native-runtime-fixture';
let database, config, modelAccess, mcp, runtime, graph, queue, chatServer, memory;
let releaseBlockedResponse;
let stripProxyToken = false;
const handles = [];
const threadRegistrations = [];
const historyOperations = [];
const { NATIVE_SUBSCRIPTION_ACCOUNT } = await import('@cindy/maker-core');
try {
  await fs.mkdir(profile, { recursive: true });
  configureHostOwner({ userDataDir: profile, ownerId });
  // Host main injects the machine app-data root at startup (main.ts configureAppDataDir).
  configureAppDataDir(path.join(root, 'app-data'));
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
  // Maker Memory as main.ts builds it: the flag before the agents, native memory off after.
  memory = createHostMemoryManager({ userDataDir: profile, ownerId });
  if (memory.isEnabled()) await memory.enable({ skipAgentSync: true });
  mcp = createHostMcpRuntime({ appServerIds: () => [], getRemoteMcpBridgeToken: config.remoteBridgeToken });
  runtime = createHostCodexRuntime({ profileDir: profile, binaryPath: binary, config, modelAccess, mcp,
    availabilityPolicy: createAvailabilityPolicy(async () => { throw new Error('Unexpected share mutation'); }), publish: () => {},
  });
  // For one step below: a Codex process started without the proxy token, as any other
  // local process would look to the loopback proxy.
  const realPrepare = runtime.deps.prepareCodexExtraSpawnConfig;
  runtime.deps.prepareCodexExtraSpawnConfig = async (...args) => {
    const value = await realPrepare(...args);
    if (!stripProxyToken) return value;
    const extraArgs = [];
    for (let i = 0; i < value.extraArgs.length; i++) {
      if (value.extraArgs[i] === '-c' && value.extraArgs[i + 1]?.includes(`.env_http_headers.${CODEX_PROXY_TOKEN_HEADER}=`)) { i++; continue; }
      extraArgs.push(value.extraArgs[i]);
    }
    const { [CODEX_PROXY_TOKEN_ENV]: _withheld, ...extraEnv } = value.extraEnv ?? {};
    return { ...value, extraArgs, extraEnv };
  };
  for (const name of ['resolveCodexThreadStorage', 'prepareCodexResumeSession']) {
    const original = runtime.deps[name];
    runtime.deps[name] = (...args) => { historyOperations.push([name, ...args]); return original(...args); };
  }
  const recordLocation = runtime.deps.recordCodexThreadLocation;
  runtime.deps.recordCodexThreadLocation = async (...args) => {
    await recordLocation(...args);
    threadRegistrations.push(args);
  };
  graph = createHostAgentGraph({ userDataDir: profile, providerConfig: config, gateway: modelAccess.gateway,
    codexBinaryPath: binary, codexRuntime: runtime, mcpRuntime: mcp, makerMemory: memory,
    mcpProviders: createHostMemoryMcpProviders(memory),
    storage: new OwnerSessionStorage({ db: () => database }),
  });
  attachAgentsToMakerMemory(memory, graph.instances);
  if (memory.isEnabled()) await memory.enable();
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
  // Native storage capability fixture, as minted by the executing host after
  // owner checks. It selects two synthetic account homes, never a real login.
  // Model traffic still goes to this script's local upstream through the real graph.
  const accountHomeA = path.join(root, 'native-account-a');
  const accountHomeB = path.join(root, 'native-account-b');
  const account = (id, configDir) => ({
    id, configDir, assertCurrent() { assert.ok(runtime.isCurrent()); },
    async readState() { return { authenticated: true, authSource: 'api-key', identity: id }; },
    async readCodexTokens() { return { accessToken: 'synthetic-native-token', chatgptAccountId: id }; },
  });
  const runStorageTurn = async handle => {
    const completed = (async () => {
      for await (const event of handle.events()) {
        if (event.type === 'error') throw Error(`Storage turn failed: ${JSON.stringify(event.data)}`);
        if (event.type === 'done') return;
      }
      throw Error('Storage turn ended without done');
    })();
    void completed.catch(() => {});
    let timer;
    try {
      await Promise.race([(async () => { await handle.send({ type: 'user', content: 'return synthetic complete' }, { throwOnStartFailure: true }); await completed; })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Storage turn timed out')), 45_000); })]);
    } finally { clearTimeout(timer); }
  };
  // The local mock provider requires this synthetic API env key; this step
  // verifies directory capabilities, not subscription login/allocation (M2).
  process.env.XDT_CODEX_API_KEY = 'synthetic-custom-key';
  const firstStorageHandle = await graph.codex.startSession({ sessionId: 'storage-account-a', providerId: 'cprov-fixture',
    model: 'fixture-model', workingDir: root, [NATIVE_SUBSCRIPTION_ACCOUNT]: account('storage-a', accountHomeA) });
  handles.push(firstStorageHandle);
  await runStorageTurn(firstStorageHandle);
  const originalThread = firstStorageHandle.id;
  const originalStorage = await runtime.deps.resolveCodexThreadStorage(originalThread, { readOnly: true });
  assert.equal(originalStorage.historyHome, accountHomeA);
  assert.equal(originalStorage.sqliteHome, accountHomeA);
  await firstStorageHandle.close();
  const resumedStorageHandle = await graph.codex.startSession({ sessionId: 'storage-account-b', providerId: 'cprov-fixture',
    model: 'fixture-model', workingDir: root, resumeSessionId: originalThread,
    [NATIVE_SUBSCRIPTION_ACCOUNT]: account('storage-b', accountHomeB) });
  handles.push(resumedStorageHandle);
  await runStorageTurn(resumedStorageHandle);
  assert.equal(resumedStorageHandle.id, originalThread);
  assert.deepEqual(await runtime.deps.resolveCodexThreadStorage(originalThread, { readOnly: true }), originalStorage);
  assert.ok(threadRegistrations.some(([id, sqlite, file]) => id === originalThread && sqlite === accountHomeA && file === originalStorage.rolloutPath));
  await resumedStorageHandle.close();
  const assertCurrent = () => assert.ok(runtime.isCurrent());
  await graph.codex.syncThreadArchiveState({ threadId: originalThread, archived: true, assertCurrent });
  const archived = await runtime.deps.resolveCodexThreadStorage(originalThread, { readOnly: true });
  assert.equal(archived.historyHome, accountHomeA);assert.equal(archived.sqliteHome, accountHomeA);
  assert.ok(archived.rolloutPath.includes(path.sep + 'archived_sessions' + path.sep));
  await graph.codex.syncThreadArchiveState({ threadId: originalThread, archived: false, assertCurrent });
  const restored = await runtime.deps.resolveCodexThreadStorage(originalThread, { readOnly: true });
  assert.equal(restored.historyHome, accountHomeA);assert.equal(restored.sqliteHome, accountHomeA);
  assert.ok(restored.rolloutPath.includes(path.sep + 'sessions' + path.sep));
  // A real route handoff also retains the canonical storage, not just the
  // transfer predicate: the resumed process now uses the gateway route.
  await graph.codex.requiresCodexThreadHostTransfer({ threadId: originalThread, sessionId: 'storage-route',
    providerId: 'xd', model: 'fixture-model' });
  const routedStorageHandle = await graph.codex.startSession({ sessionId: 'storage-route', providerId: 'xd',
    model: 'fixture-model', workingDir: root, resumeSessionId: originalThread });
  handles.push(routedStorageHandle);
  await runStorageTurn(routedStorageHandle);
  assert.equal(routedStorageHandle.id, originalThread);
  assert.deepEqual(await runtime.deps.resolveCodexThreadStorage(originalThread, { readOnly: true }), restored);
  assert.ok(threadRegistrations.some(([id, sqlite, file]) => id === originalThread && sqlite === accountHomeA && file === restored.rolloutPath));
  await routedStorageHandle.close();
  const nativeTurns = [...new Set((await fs.readFile(restored.rolloutPath, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.type === 'turn_context').map(row => row.payload.turn_id).filter(Boolean))];
  assert.ok(nativeTurns.length >= 2, 'both native turns have persisted fork anchors');
  for (const tailTurnsToDrop of [0, 1]) {
    const fork = await graph.codex.forkSdkSession({ sourceSdkSessionId: originalThread, providerId: 'cprov-fixture',
      model: 'fixture-model', workingDir: root, upToMessageId: undefined, tailTurnsToDrop, lastTurnId: nativeTurns.at(-1 - tailTurnsToDrop),
      [NATIVE_SUBSCRIPTION_ACCOUNT]: account('storage-b', accountHomeB) });
    const forkStorage = await runtime.deps.resolveCodexThreadStorage(fork.newSdkSessionId, { readOnly: true });
    assert.equal(forkStorage.historyHome, accountHomeA);assert.equal(forkStorage.sqliteHome, accountHomeA);
    assert.ok(threadRegistrations.some(([id, sqlite, file]) => id === fork.newSdkSessionId && sqlite === accountHomeA && file === forkStorage.rolloutPath));
  }
  // Route handoff still resolves the old storage before selecting a new host.
  await graph.codex.requiresCodexThreadHostTransfer({ threadId: originalThread, sessionId: 'storage-route',
    providerId: 'xd', model: 'fixture-model' });
  assert.deepEqual(await runtime.deps.resolveCodexThreadStorage(originalThread, { readOnly: true }), restored);
  const localHistoryCalls = historyOperations.length;
  assert.equal(await graph.codex.requiresCodexThreadHostTransfer({ threadId: originalThread, sessionId: 'remote-storage',
    remoteHostId: 'unconfigured-fixture', providerId: 'xd', model: 'fixture-model' }), false);
  await assert.rejects(graph.codex.syncThreadArchiveState({ threadId: originalThread, archived: true,
    remoteHostId: 'unconfigured-fixture', assertCurrent }), /host did not provide getRemoteCodexTransport/);
  await fs.mkdir(path.join(root, 'isolated-guest', 'codex'), { recursive: true });
  await assert.rejects(graph.codex.forkSdkSession({ sourceSdkSessionId: originalThread, providerId: 'cprov-fixture',
    model: 'fixture-model', workingDir: root, upToMessageId: undefined, lastTurnId: nativeTurns.at(-1),
    hostedGuestHome: path.join(root, 'isolated-guest') }), /not found|no rollout|does not exist/i);
  assert.equal(historyOperations.length, localHistoryCalls, 'remote/guest paths never consult the local history resolver or preparer');
  delete process.env.XDT_CODEX_API_KEY;
  console.log('PASS native cross-account resume, archive/unarchive, fork/tail rollback and route storage');

  // Shared-send integration: earlier checks bypass the queue. Use the real
  // HTTP/queue/Maker pipeline, isolated SQLite and a synthetic local upstream.
  const sessionId = 'queued-native-fixture';
  await new OwnerSessionStorage({ db: () => database }).create({ id: sessionId,
    title: 'Shared send fixture', agentKind: 'codex', model: 'fixture-model', workDir: root });
  await database.drizzle.update(sessions).set({ providerId: 'cprov-fixture' }).where(eq(sessions.id, sessionId));
  const hub = createEventHub();
  const readSession = async id => {
    const [row] = await database.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row;
  };
  const makeQueue = () => createInputQueue({ getMaker: () => graph.maker, hub, readSession,
    getOwner: getCurrentDbClientSnapshot,
    createAttachments: ({ assertCurrent }) => createHostAttachments({ getOwner: getCurrentDbClientSnapshot, assertCurrent }),
    persistMessage: createHostMessageStore({ getOwner: getCurrentDbClientSnapshot, publish: event => hub.publish(event) }),
    markStarted: async id => { markSessionTurnStarted(id); await drainSessionActiveTurnWrites(id); },
    markEnded: async (id, at) => { markSessionTurnEnded(id, at); await drainSessionActiveTurnWrites(id); },
  });
  queue = makeQueue();
  const handler = createChatHandler({ readSession, events: hub,
    enqueue: (id, input) => queue.enqueue(id, input), inputStatus: (id, clientId) => queue.inputStatus(id, clientId) });
  chatServer = createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => chatServer.listen(0, '127.0.0.1', resolve));
  const postChat = clientId => fetch(`http://127.0.0.1:${chatServer.address().port}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, clientId, prompt: 'return synthetic complete' }), signal: AbortSignal.timeout(45_000),
  }).then(async response => { assert.equal(response.status, 200); return response.text(); });
  const blockNextResponse = () => {
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { releaseBlockedResponse = resolve; });
    onNextResponse = async () => { entered(); await gate; };
    return reached;
  };
  const reached = blockNextResponse();
  const firstReply = postChat('queued-first');
  await Promise.race([reached, firstReply.then(body => { throw new Error(`Turn ended before upstream: ${body}`); })]);
  await queue.steer(sessionId, { clientId: 'queued-steer', text: 'also keep it concise' });
  releaseBlockedResponse();
  const completedBody = await firstReply;
  assert.match(completedBody, /synthetic complete/);
  assert.match(completedBody, /"type":"done"/);
  await queue.dispose();
  const rows = await database.drizzle.select().from(messages).where(eq(messages.sessionId, sessionId));
  assert.equal(rows.filter(row => row.clientId === 'queued-first').length, 1);
  assert.ok(JSON.parse(rows.find(row => row.clientId === 'queued-first').agentMeta).uuid);
  assert.ok(rows.some(row => row.clientId === 'queued-steer'));
  assert.ok(rows.some(row => row.role === 'assistant'));
  // Reopen the runtime over the same DB. This is not a whole-process restart.
  queue = makeQueue();
  const reachedAgain = blockNextResponse();
  const stoppedReply = postChat('queued-stop');
  await Promise.race([reachedAgain, stoppedReply.then(body => { throw new Error(`Resume ended before upstream: ${body}`); })]);
  await queue.stop(sessionId);
  releaseBlockedResponse();
  await stoppedReply;
  assert.equal(queue.projection(sessionId).turnInProgress, false);
  // Real native input conversion, beyond the fake Session unit tests: the
  // provider must receive image bytes and a local file through the shared path.
  const attachmentTask = 'attachment-native-fixture';
  await new OwnerSessionStorage({ db: () => database }).create({ id: attachmentTask,
    title: 'Attachment fixture', agentKind: 'codex', model: 'fixture-model', workDir: root });
  await database.drizzle.update(sessions).set({ providerId: 'cprov-fixture' }).where(eq(sessions.id, attachmentTask));
  const imagePath = path.join(root, 'image.png');
  await fs.copyFile(new URL('../../desktop/src/renderer/assets/login/wordmark.png', import.meta.url), imagePath);
  const filePath = path.join(root, 'note.txt');
  await fs.writeFile(filePath, 'native attachment fixture');
  let timer, unsubscribe;
  const completedAttachment = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Native attachment turn timed out')), 45_000);
    unsubscribe = hub.subscribe(event => {
      if (event.sessionId !== attachmentTask) return;
      if (event.event?.type === 'done') resolve();
      if (event.event?.type === 'error') reject(new Error(`Native attachment failed: ${JSON.stringify(event.event.data)}`));
    });
  });
  void completedAttachment.catch(() => {});
  const beforeAttachments = requests.length;
  try {
    await queue.enqueue(attachmentTask, { clientId: 'native-attachment', text: 'return synthetic complete',
      files: [{ path: imagePath, category: 'image', ext: '.png', name: 'image.png' },
        { path: filePath, category: 'file', ext: '.txt', name: 'note.txt' }],
      persistedContent: JSON.stringify({ text: 'return synthetic complete', images: [{ url: imagePath }], files: [{ path: filePath }] }) });
    await completedAttachment;
    const wireInput = JSON.stringify(requests.slice(beforeAttachments).map(request => request.body.input));
    assert.match(wireInput, /data:image\/png;base64,/);
    assert.ok(wireInput.includes(filePath));
    const attachmentRows = await database.drizzle.select().from(messages).where(eq(messages.sessionId, attachmentTask));
    assert.match(attachmentRows.find(row => row.clientId === 'native-attachment').content, /cindy-media:\/\/blobs\//);
  } finally { clearTimeout(timer); unsubscribe?.(); }
  console.log('PASS production Host attachments + native Codex: local image bytes reach upstream, file path is preserved and managed image URL is persisted (synthetic local upstream)');
  // The Codex product-prompt marker round-trips through the Host task row (Maker lifecycle hooks).
  await graph.maker.lifecycleHooks.onCodexProductPromptDelivery({ sessionId, threadId: 'fixture-thread', historyHasProductPrompt: true });
  assert.equal(await graph.maker.lifecycleHooks.getCodexHistoryHasProductPrompt(sessionId), true);
  console.log('PASS Codex product prompt delivery persists on the Host task row');
  console.log('PASS shared Host HTTP + queue + native Codex: send, persisted UUID/reply, steer, runtime reopen and stop (synthetic local upstream)');
  assert.ok(requests.length >= 3);
  // The desktop product system prompt reaches the real Codex request (runtimeConfigsCore.ts).
  assert.ok(requests.some(request => JSON.stringify(request.body).includes('You are Cindy, an open-source AI assistant.')),
    'Codex upstream request carries the Cindy product prompt');
  console.log('PASS the Codex upstream request carries the Cindy product system prompt');
  console.log('PASS native Codex + production Host: gateway and custom provider turns; key rotation during a live turn preserves completion and the next gateway task uses the new key');

  // ---- The Host's Codex loopback proxies require inbound credentials ----
  const logText = async () => {
    let all = '';
    for (const file of await fs.readdir(path.join(root, 'logs')).catch(() => [])) all += await fs.readFile(path.join(root, 'logs', file), 'utf8').catch(() => '');
    return all;
  };
  const count = (text, needle) => text.split(needle).length - 1;
  const rejectedCount = text => count(text, 'inbound request rejected') + count(text, 'inbound upgrade rejected');
  const waitFor = async (predicate, ms) => {
    const deadline = Date.now() + ms;
    // real-wait: the native process reaches the proxy on its own schedule.
    while (Date.now() < deadline) { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 250)); }
    return false;
  };
  const startNative = async (sessionId, providerId, model, extra = {}) => {
    setSessionProvider(sessionId, providerId);
    const handle = await graph.codex.startSession({ sessionId, providerId, model, workingDir: root, ...extra });
    handles.push(handle);
    const events = [];
    const ended = (async () => {
      for await (const event of handle.events()) { events.push(event); if (event.type === 'done' || event.type === 'error') return event; }
      return null;
    })();
    void ended.catch(() => {});
    void handle.send({ type: 'user', content: 'return synthetic complete' }).catch(error => events.push({ type: 'error', data: String(error) }));
    return { handle, events, ended, close: async () => { await handle.close().catch(() => {}); runtime.closeSession(sessionId); clearSessionProvider(sessionId); } };
  };
  const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('timeout'), ms))]);
  assert.equal(rejectedCount(await logText()), 0, 'no request from a Cindy-started Codex was refused');

  // 1. What the task's own tool commands see: they run inside the task, so they can read the token
  //    variable; the token is valid only on this runtime's loopback proxies. Recorded as a fact.
  toolScenario = { output: null };
  const envTurn = await startNative('native-env-tool', 'xd', 'fixture-model');
  const envEnd = await bounded(envTurn.ended, 60_000);
  await envTurn.close();
  assert.equal(envEnd?.type, 'done', JSON.stringify(envEnd ?? envTurn.events.at(-1)));
  assert.ok(toolScenario.output, 'the exec tool ran env and returned its output');
  assert.match(toolScenario.output, /HOME=/, 'the output is the environment listing');
  const visible = toolScenario.output.includes(CODEX_PROXY_TOKEN_ENV);
  toolScenario = null;
  console.log(`PASS a Codex tool command ran inside the task; it ${visible ? 'can' : 'cannot'} read ${CODEX_PROXY_TOKEN_ENV}, which only this runtime's loopback proxies accept`);

  // Maker Memory reaches a Codex task through the Host's MCP bridge (release table row 11).
  //    Full access, so the call needs no approval; this checks the bridge, not the approval path.
  memoryScenario = { output: null, requests: [], reviews: [], name: 'host-e2e-memory' };
  const memoryTurn = await startNative('native-memory-tool', 'xd', 'fixture-model',
    { makerMemoryEnabled: true, permissionMode: 'bypassPermissions' });
  const memoryEnd = await bounded(memoryTurn.ended, 60_000);
  await memoryTurn.close();
  assert.equal(memoryEnd?.type, 'done', JSON.stringify(memoryEnd ?? memoryTurn.events.at(-1)));
  const memoryTools = JSON.stringify(memoryScenario.requests[0]?.tools ?? []);
  assert.ok(memoryTools.includes('mcp__cindy_memory__call_tool') && memoryTools.includes('mcp__cindy_memory__list_tools'),
    'the Codex request lists the cindy_memory tools');
  const memoryRoot = path.join(profile, 'owners', dataOwnerStorageKey(ownerId), 'maker-memory');
  const assertShard = async (name) => {
    assert.match(memoryScenario.output ?? '', new RegExp(`project_${name}\\.md`), 'the memory tool answered with the written shard');
    const shards = [];
    for (const scope of await fs.readdir(memoryRoot)) {
      const file = path.join(memoryRoot, scope, `project_${name}.md`);
      if (await fs.stat(file).then(() => true, () => false)) shards.push(await fs.readFile(file, 'utf8'));
    }
    assert.equal(shards.length, 1, 'the shard is in the Host profile\'s owner memory store');
    assert.match(shards[0], /synthetic memory body/);
  };
  await assertShard('host-e2e-memory');
  memoryScenario = null;
  console.log('PASS a Codex task reaches the Host memory manager through the MCP bridge: its request lists cindy_memory, and a memory_write stored the shard in the Host profile');

  //    The same call in auto mode on the gateway route. Codex's own reviewer is only enabled for
  //    oauth-bearer routes; here the approval goes to the Host's review path, with the context
  //    resolver main.ts installs right after building the graph (set here so the earlier steps keep
  //    their setup). cindy_memory is a trusted first-party server: approved without a review model
  //    call. The fixture would answer a review request with allow, and counts any.
  graph.autoReview.setContextResolver(createHostReviewContextResolver({ acceptedInput: () => null }));
  memoryScenario = { output: null, requests: [], reviews: [], name: 'host-e2e-memory-auto' };
  const autoMemoryTurn = await startNative('native-memory-auto', 'xd', 'fixture-model',
    { makerMemoryEnabled: true, permissionMode: 'auto' });
  const autoMemoryEnd = await bounded(autoMemoryTurn.ended, 60_000);
  await autoMemoryTurn.close();
  assert.equal(autoMemoryEnd?.type, 'done', JSON.stringify(autoMemoryEnd ?? autoMemoryTurn.events.at(-1)));
  await assertShard('host-e2e-memory-auto');
  const autoReviews = memoryScenario.reviews.length;
  memoryScenario = null;
  console.log(`PASS in auto mode on the gateway route the same memory call is approved through the Host review path and stores its shard (${autoReviews} review model request(s))`);

  // 2. A review through a Codex profile in the customized auxiliary chain (release table row 4):
  //    maker.oneShot('codex') reuses the local Codex host, so the request crosses this runtime's
  //    loopback proxy and must carry its token. The fixture's answer is not a review verdict,
  //    so the tool-loop review continues; what matters is the route.
  const chainFile = ownerScopedUserDataPath('auxiliary-model-settings.json');
  await fs.mkdir(path.dirname(chainFile), { recursive: true });
  await fs.writeFile(chainFile, JSON.stringify({ models: ['codex-gpt-5.4-mini'] }));
  const rejectedBeforeReview = rejectedCount(await logText());
  const requestsBeforeReview = requests.length;
  const loopDecision = await graph.autoReview.toolLoopReviewer({
    sessionId: 'loop-review', agentKind: 'pi', model: 'fixture-model', userIntent: 'Fix the build',
    verdict: { reason: 'consecutive', count: 8, toolName: 'bash' },
    evidence: [0, 1, 2].map(i => ({ toolName: 'bash', input: { command: 'make' }, output: 'error: missing header', isError: true, startedAt: i, finishedAt: i + 1 })),
  }, { signal: AbortSignal.timeout(90_000) });
  await fs.rm(chainFile, { force: true });
  const reviewRequests = requests.slice(requestsBeforeReview);
  assert.ok(reviewRequests.length >= 1, 'the review reached the upstream through Codex');
  assert.ok(reviewRequests.every(request => request.url.endsWith('/responses')), 'as Codex Responses requests');
  assert.equal(rejectedCount(await logText()), rejectedBeforeReview, 'no review request was refused at the gate');
  assert.equal(loopDecision, 'continue');
  console.log(`PASS a tool-loop review through a Codex profile crosses the loopback proxy with its token (${reviewRequests.length} upstream request(s), 0 refusals)`);

  // A synthetic ChatGPT login in the profile, so the next host uses cindy_openai with WebSockets.
  // Token and revoke URLs point at the fixture; HTTPS goes through the fixture, which refuses tunnels.
  const codexHome = path.join(profile, 'codex-home');
  const jwt = payload => `${[{ alg: 'none', typ: 'JWT' }, payload].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.`;
  const claims = { exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-workspace', chatgpt_plan_type: 'plus', chatgpt_user_id: 'synthetic-user' } };
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null,
    tokens: { id_token: jwt({ ...claims, email: 'fixture@example.test' }), access_token: jwt(claims), refresh_token: 'synthetic-refresh-token', account_id: 'synthetic-workspace' },
    last_refresh: new Date().toISOString() }), { mode: 0o600 });
  bindNativeProviderAuth('openai', { instanceIsolated: true });

  // 2. The WebSocket handshake of a Cindy-started Codex carries the token: it passes the gate and is
  //    forwarded towards the subscription backend (whose tunnel the fixture refuses).
  let text = await logText();
  const forwardedBefore = count(text, '▶ upgrade to upstream');
  const wsTurn = await startNative('native-oauth-ws', 'openai', 'gpt-5.4');
  const forwarded = await waitFor(async () => count(await logText(), '▶ upgrade to upstream') > forwardedBefore, 30_000);
  await wsTurn.close();
  text = await logText();
  assert.ok(forwarded, `the WebSocket upgrade was forwarded (events: ${JSON.stringify(wsTurn.events.slice(-2)).slice(0, 400)})`);
  assert.equal(count(text, 'inbound upgrade rejected'), 0, 'the handshake was not refused');
  console.log(`PASS the WebSocket handshake of a Cindy-started Codex carries the proxy token (${count(text, '▶ upgrade to upstream') - forwardedBefore} upgrade(s) forwarded)`);

  // 3. A Codex process without the token is refused with 403 before routing; Codex neither refreshes
  //    nor invalidates the login, and the profile keeps it.
  await graph.codex.forceDisposeLocalHostForAuthChange('e2e: a Codex process without the proxy token', { preserveExternalAuth: true });
  stripProxyToken = true;
  const rejectedBefore = rejectedCount(text);
  const before = { requests: requests.length, oauth: oauthCalls.length, authTunnels: connects.filter(c => c.startsWith('auth.openai.com')).length };
  const refusedTurn = await startNative('native-oauth-no-token', 'openai', 'gpt-5.4');
  const refusedSeen = await waitFor(async () => rejectedCount(await logText()) > rejectedBefore, 30_000);
  const refusedEnd = await bounded(refusedTurn.ended, 30_000);
  await refusedTurn.close();
  stripProxyToken = false;
  await graph.codex.forceDisposeLocalHostForAuthChange('e2e: back to Codex processes with the proxy token', { preserveExternalAuth: true });
  text = await logText();
  assert.ok(refusedSeen, 'the tokenless Codex was refused at the gate');
  assert.equal(requests.length, before.requests, 'nothing reached the model upstream');
  assert.equal(oauthCalls.length, before.oauth, `no token refresh or revoke: ${JSON.stringify(oauthCalls)}`);
  assert.equal(connects.filter(c => c.startsWith('auth.openai.com')).length, before.authTunnels, 'no tunnel to the OAuth service');
  assert.equal(readInvalidatedSystemCodexAuthMarker(codexHome), null, 'the login was not invalidated');
  assert.equal(runtime.native.hasLogin(), true, 'the profile keeps its login');
  console.log(`PASS a Codex process without the proxy token is refused with 403 (${rejectedCount(text) - rejectedBefore} refusal(s)); no refresh, no revoke, no invalidation; turn ${refusedEnd === 'timeout' ? 'still retrying after 30s' : `ended with ${refusedEnd?.type}`}`);
  console.log(`oauth endpoint calls: ${oauthCalls.length}; tunnels: ${JSON.stringify(connects)}`);
} catch (error) {
  // The application logger owns uncaughtException handling. Preserve a failed
  // acceptance command's exit status even when that handler consumes the throw.
  process.exitCode = 1;
  throw error;
} finally {
  releaseBlockedResponse?.();
  chatServer?.closeAllConnections();
  if (chatServer) await new Promise(resolve => chatServer.close(resolve));
  await queue?.dispose();
  for (const handle of handles) await handle.close().catch(() => {});
  graph?.gatewayRestart.clear();
  await graph?.maker.shutdown();
  await runtime?.close();
  await mcp?.close();
  memory?.dispose();
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
