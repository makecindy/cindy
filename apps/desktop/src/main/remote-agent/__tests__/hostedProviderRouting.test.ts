/** 同账号托管任务的来源必须在首个请求前进入 proxy 的查询路径，且随运行实例收尾。 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RemoteAgentPollResult } from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { buildUserProvider } from '@cindy/model-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../../maker-host/runtime-configs', () => ({ claudeUpstreamEndpoint: () => 'https://gateway.example.invalid' }));
vi.mock('../../maker-host/silent-encrypted-retry-store', () => ({ readSilentEncryptedRetrySettings: () => ({ enabled: false }) }));
vi.mock('../../maker-host/claude-fast-mode-log', () => ({
  createClaudeFastModeRequestTransform: () => () => null,
  createClaudeFastModeResponseObserver: () => () => undefined,
}));

import { setCustomProviders } from '../../maker-host/active-catalog';
import { createModelRoutingTransform, setClaudeProxyGatewayKeyReader, setClaudeProxySessionIdResolver } from '../../maker-host/anthropic-compat-proxy-host';
import { resolveSessionRouteDecision, setCustomProviderKeyReader } from '../../maker-host/provider-route';
import { bindHostedSessionProvider, clearAllSessionProviders, getSessionProvider, hasSessionProvider, hasHostedSessionModelAccess } from '../../maker-host/session-provider-store';
import { hostedProviderOffersModel } from '../../maker-host/guest-provider-route-store';
import { LineSplitter } from '../eventLog';
import { createRemoteAgentHost, hostSessionIdFor, type HostedStartInput } from '../host/runHost';

const MODEL = 'gpt-6-astra';
const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const OWNER = 'controller-1';
let root: string;
let host: ReturnType<typeof createRemoteAgentHost>;
let shadowRoots: Set<string>;
let releaseGates: Array<() => void>;
const eventStreams = new Map<string, {
  cursor: number;
  splitter: LineSplitter;
  received: Array<Record<string, unknown>>;
  done: boolean;
}>();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  releaseGates.push(resolve);
  return { promise, resolve };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-hosted-route-')));
  shadowRoots = new Set();
  releaseGates = [];
  eventStreams.clear();
  clearAllSessionProviders();
  setCustomProviders(['fp', 'other'].map((id) => buildUserProvider({
    id, name: id,
    runtimes: {
      codex: { baseUrl: 'https://' + id + '.example.invalid/v1', wireProtocol: 'openai-responses', models: [{ id: MODEL, name: MODEL }] },
      pi: { baseUrl: 'https://' + id + '.example.invalid/v1', wireProtocol: 'openai-responses', models: [MODEL, CLAUDE_MODEL].map(id => ({ id, name: id })) },
      'claude-code': { baseUrl: 'https://' + id + '.example.invalid/anthropic', wireProtocol: 'anthropic-messages', models: [MODEL, CLAUDE_MODEL].map((model) => ({ id: model, name: model })) },
    },
  })));
  setCustomProviderKeyReader((id) => 'test-key-' + id);
  setClaudeProxyGatewayKeyReader(() => 'test-gateway-key');
  setClaudeProxySessionIdResolver((sdkSessionId) => host.resolveClaudeSessionId(sdkSessionId));
});

afterEach(async () => {
  for (const release of releaseGates) release();
  await host?.abortAll();
  host?.dispose();
  // dispose 在后台删除工作目录；等它结束，避免与 fixture 清理交错。
  await vi.waitFor(() => {
    for (const dir of shadowRoots) expect(fs.existsSync(dir)).toBe(false);
  });
  clearAllSessionProviders();
  setClaudeProxySessionIdResolver(() => null);
  setClaudeProxyGatewayKeyReader(() => null);
  setCustomProviders([]);
  setCustomProviderKeyReader(() => null);
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(hooks: {
  start?: (input: HostedStartInput) => Promise<void>;
  requestSessionId?: (input: HostedStartInput) => string;
  isOwnerCurrent?: () => boolean;
  trust?: 'owner' | 'guest';
  allowsModel?: (providerId: string, model: string) => boolean;
} = {}) {
  const starts: HostedStartInput[] = [];
  const routes: unknown[] = [];
  const switches = vi.fn(async (_input: HostedStartInput) => {});
  const closed = vi.fn();
  host = createRemoteAgentHost({
    isAgentAvailable: () => true,
    isControllerAuthorized: () => true,
    controllerTrust: () => hooks.trust ?? 'owner',
    providerAccess: {
      resolve: async (_kind, _model, providerId) => providerId === 'forbidden' ? null : providerId ?? 'fp',
      isAllowed: (providerId, _controller, model) => providerId !== 'forbidden' && (hooks.allowsModel?.(providerId, model ?? '') ?? true),
    },
    bindOwnerProviderRoute: bindHostedSessionProvider,
    ownerModelAllowed: (sessionId, providerId, kind, model) => hasHostedSessionModelAccess(sessionId)
      && hostedProviderOffersModel(sessionId, providerId, kind, model),
    bindGuestProviderRoute: async () => ({ routeToken: 'test-guest-route', modelIds: [MODEL], release() {} }),
    startHosted: async (input) => {
      starts.push(input);
      shadowRoots.add(path.dirname(input.mirrorRoot));
      // 与 Codex proxy 相同的解析器：核对实际 upstream 与凭证，而不只看传入的 providerId。
      routes.push(await resolveSessionRouteDecision(input.hostSessionId, 'codex', 'unused-gateway-key', MODEL));
      await hooks.start?.(input);
      const end = deferred();
      return {
        id: 'sdk-' + input.hostSessionId, agentKind: input.kind, model: MODEL,
        get requestSessionId() { return hooks.requestSessionId?.(input) ?? 'sdk-' + input.hostSessionId; },
        async send() {}, async steer() {}, async abort() {},
        async close() { closed(); end.resolve(); },
        async setModel() { await switches(input); },
        events: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> { await end.promise; } }),
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
        setInteractionResolver() {},
      } satisfies AgentSessionHandle;
    },
    captureOwner: () => 'owner', isOwnerCurrent: hooks.isOwnerCurrent ?? (() => true), runsRoot: path.join(root, 'host'),
  });
  return { starts, routes, switches, closed };
}

async function open(providerId: string | null = 'fp', sessionId = 'task-1', controller = OWNER, kind: HostedStartInput['kind'] = 'codex', virtualWorkspace = false) {
  const runId = randomUUID();
  await host.handle(controller, {
    op: 'open', runId, agentKind: kind, payload: { json: {
      sessionId, options: { model: MODEL, providerId },
      ...(virtualWorkspace ? { virtualWorkspace: true } : {}),
      // 控制端的逻辑 POSIX 路径，与测试宿主平台无关。
      workspace: { workingDir: '/Users/owner/proj', platform: 'darwin', shell: 'zsh' },
      projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [],
    } },
  });
  return runId;
}

async function waitForEvent(runId: string, type: string, callId?: string, controller = OWNER) {
  let stream = eventStreams.get(runId);
  if (!stream) {
    stream = { cursor: 0, splitter: new LineSplitter(1024 * 1024), received: [], done: false };
    eventStreams.set(runId, stream);
  }
  // 用协议长轮询等事件到达,避免 vi.waitFor 默认 1 秒给磁盘/隧道启动加上额外期限。
  // 总等待仍受用例超时约束;保留已收事件,避免同批返回的后续 result 被游标确认丢弃。
  for (;;) {
    const found = stream.received.find((event) => event.t === type && (!callId || event.callId === callId));
    if (found) return found;
    expect(stream.done, `Run ended before ${type}: ${JSON.stringify(stream.received)}`).toBe(false);
    const poll = await host.handle(controller, {
      op: 'poll', runs: [{ runId, cursor: stream.cursor }], waitMs: 1_000,
    }) as RemoteAgentPollResult;
    const chunk = poll.runs[0];
    if (!chunk) continue;
    expect(chunk.missing, `Run missing while waiting for ${type}`).not.toBe(true);
    stream.cursor = chunk.cursor;
    stream.done = chunk.done === true;
    if (chunk.data) {
      stream.received.push(...stream.splitter.push(Buffer.from(chunk.data, 'base64')).map((line) => JSON.parse(line)));
    }
  }
}

async function switchProvider(runId: string, providerId?: string | null) {
  const callId = randomUUID();
  await host.handle(OWNER, { op: 'call', runId, callId, method: 'setModel', payload: { json: [MODEL, providerId === undefined ? {} : { providerId }] } });
  return callId;
}

describe('same-account hosted provider routing', () => {
  // Review 4333949156 / sharing §12, unit: the old host suite checked only the
  // HTTP proxy. Query the real run tunnel as owner Pi's API-key adapter does;
  // another approved source is allowed, but revocation/stale bindings are denied.
  it('checks owner native requests against the actual provider and current model grant', async () => {
    const allowedProviders = new Set(['fp', 'other']);
    const env = setup({ allowsModel: (providerId, model) => allowedProviders.has(providerId) && model === MODEL });
    const runId = await open('fp', 'owner-native', OWNER, 'pi');
    await waitForEvent(runId, 'started');
    const input = env.starts[0];
    const query = async (providerId?: string, model = MODEL) => {
      const response = await fetch(input.tunnel.url + '/cindy/model-access', { method: 'POST',
        headers: { Authorization: 'Bearer ' + input.tunnel.token }, body: JSON.stringify({ model, providerId }) });
      return (await response.json() as { allowed: boolean }).allowed;
    };
    expect(await query('fp')).toBe(true);
    expect(await query('fp', CLAUDE_MODEL)).toBe(false);
    expect(await query('other')).toBe(true);
    expect(await query('forbidden')).toBe(false);
    expect(await query()).toBe(false);
    allowedProviders.delete('other');
    expect(await query('other')).toBe(false);
    clearAllSessionProviders();
    expect(await query('fp')).toBe(false);
  });
  // Unit regression for review 4327641928: real host registration must reach the
  // proxy before the first request and read live grants. Previous tests only checked
  // provider selection; minimum is a hosted session allowed one of two catalog models.
  it('binds live owner model authorization before routing hosted Claude requests', async () => {
    let allowedModel = MODEL;
    const sdkSessionId = randomUUID();
    setup({ requestSessionId: () => sdkSessionId, allowsModel: (_providerId, model) => model === allowedModel });
    const runId = await open('fp', 'task-1', OWNER, 'claude-code');
    await waitForEvent(runId, 'started');
    const request = (model: string) => createModelRoutingTransform()({ model }, {
      reqId: 1, method: 'POST', url: '/v1/messages', headers: { 'x-claude-code-session-id': sdkSessionId },
    });
    const expectDenied = async (model: string) => {
      const decision = await request(model);
      let status: number | undefined;
      await decision?.localHandler?.({ res: { writeHead: (code: number) => { status = code; }, end() {} } } as never);
      expect(status).toBe(403);
    };
    expect(await request(MODEL)).toMatchObject({ upstreamOverride: 'https://fp.example.invalid/anthropic' });
    await expectDenied(CLAUDE_MODEL);
    allowedModel = CLAUDE_MODEL;
    await expectDenied(MODEL);
    expect(await request(CLAUDE_MODEL)).toMatchObject({ upstreamOverride: 'https://fp.example.invalid/anthropic' });
  });

  it.each([CLAUDE_MODEL, MODEL])('routes Claude SDK-ID requests to the selected provider for %s', async (model) => {
    const sdkSessionId = randomUUID();
    setup({ requestSessionId: () => sdkSessionId });
    const runId = await open('fp', 'task-1', OWNER, 'claude-code');
    await waitForEvent(runId, 'started');
    const decision = await createModelRoutingTransform()({ model }, {
      reqId: 1, method: 'POST', url: '/v1/messages',
      headers: { 'x-claude-code-session-id': sdkSessionId, 'x-api-key': 'test-gateway-key' },
    });
    expect(decision).toMatchObject({
      upstreamOverride: 'https://fp.example.invalid/anthropic',
      headerOverride: { 'x-api-key': 'test-key-fp' },
    });
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBe(hostSessionIdFor(OWNER, 'task-1'));
    await host.handle(OWNER, { op: 'close', runId, mode: 'close', reason: 'navigation' });
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBeNull();
  });

  it('follows the live Claude request ID instead of the durable transcript ID', async () => {
    let sdkSessionId: string = randomUUID();
    let ownerCurrent = true;
    setup({ requestSessionId: () => sdkSessionId, isOwnerCurrent: () => ownerCurrent });
    const runId = await open('fp', 'task-1', OWNER, 'claude-code');
    await waitForEvent(runId, 'started');
    const previousId = sdkSessionId;
    expect(host.resolveClaudeSessionId(randomUUID())).toBeNull();
    sdkSessionId = '<pending>';
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBeNull();
    sdkSessionId = randomUUID();
    expect(host.resolveClaudeSessionId(previousId)).toBeNull();
    expect(host.resolveClaudeSessionId('sdk-' + hostSessionIdFor(OWNER, 'task-1'))).toBeNull();
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBe(hostSessionIdFor(OWNER, 'task-1'));
    ownerCurrent = false;
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBeNull();
    ownerCurrent = true;
    host.dispose();
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBeNull();
  });

  it.each(['codex', 'pi'] as const)('does not resolve %s handles as Claude sessions', async (kind) => {
    const sdkSessionId = randomUUID();
    setup({ requestSessionId: () => sdkSessionId });
    const runId = await open('fp', 'task-1', OWNER, kind);
    await waitForEvent(runId, 'started');
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBeNull();
  });

  it('removes a controller identity when its running task is revoked', async () => {
    const sdkSessionId = randomUUID();
    setup({ requestSessionId: () => sdkSessionId });
    const runId = await open('fp', 'task-1', OWNER, 'claude-code');
    await waitForEvent(runId, 'started');
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBe(hostSessionIdFor(OWNER, 'task-1'));
    await host.abortControllers((controller) => controller === OWNER);
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBeNull();
  });

  it('does not expose guest request IDs through the owner resolver', async () => {
    const sdkSessionId = randomUUID();
    setup({ requestSessionId: () => sdkSessionId, trust: 'guest' });
    const runId = await open('fp', 'task-1', OWNER, 'claude-code', true);
    await waitForEvent(runId, 'started');
    expect(host.resolveClaudeSessionId(sdkSessionId)).toBeNull();
    expect(host.resolveClaudeSessionId('<pending>')).toBeNull();
  });

  it('drops a superseded Claude handle without losing another controller identity', async () => {
    const ids = new Map<HostedStartInput, string>();
    const { starts } = setup({
      start: async (input) => { ids.set(input, randomUUID()); },
      requestSessionId: (input) => ids.get(input)!,
    });
    const first = await open('fp', 'task-1', OWNER, 'claude-code');
    await waitForEvent(first, 'started');
    const firstId = ids.get(starts[0])!;
    const peer = await open('other', 'task-1', 'controller-2', 'claude-code');
    await waitForEvent(peer, 'started', undefined, 'controller-2');
    const peerId = ids.get(starts[1])!;
    const replacement = await open('other', 'task-1', OWNER, 'claude-code');
    await waitForEvent(replacement, 'started');
    expect(host.resolveClaudeSessionId(firstId)).toBeNull();
    expect(host.resolveClaudeSessionId(ids.get(starts[2])!)).toBe(hostSessionIdFor(OWNER, 'task-1'));
    expect(host.resolveClaudeSessionId(peerId)).toBe(hostSessionIdFor('controller-2', 'task-1'));
  });

  it.each(['fp', null])('routes the first request to the authorized custom provider (%s)', async (providerId) => {
    const { routes } = setup();
    const runId = await open(providerId);
    await waitForEvent(runId, 'started');
    expect(routes).toEqual([expect.objectContaining({
      upstreamOverride: 'https://fp.example.invalid/v1',
      headerOverride: expect.objectContaining({ authorization: 'Bearer test-key-fp' }),
    })]);
    await host.handle(OWNER, { op: 'close', runId, mode: 'close', reason: 'navigation' });
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
  });

  it('registers source changes before calling the agent, keeps model-only changes, and rolls back failures', async () => {
    const id = hostSessionIdFor(OWNER, 'task-1');
    const { switches } = setup();
    switches.mockImplementation(async () => { expect(getSessionProvider(id)).toBe('other'); });
    const runId = await open();
    await waitForEvent(runId, 'started');
    expect(await waitForEvent(runId, 'result', await switchProvider(runId, 'other'))).toMatchObject({ ok: true });
    expect(getSessionProvider(id)).toBe('other');
    expect(await waitForEvent(runId, 'result', await switchProvider(runId))).toMatchObject({ ok: true });
    expect(getSessionProvider(id)).toBe('other');
    switches.mockImplementationOnce(async () => {
      expect(getSessionProvider(id)).toBe('fp');
      throw new Error('switch failed');
    });
    expect(await waitForEvent(runId, 'result', await switchProvider(runId, null))).toMatchObject({ ok: false });
    expect(getSessionProvider(id)).toBe('other');
    expect(await waitForEvent(runId, 'result', await switchProvider(runId, 'forbidden'))).toMatchObject({ ok: false });
    expect(getSessionProvider(id)).toBe('other');
    expect(switches).toHaveBeenCalledTimes(3);
  });

  it('serializes source changes so a failed earlier change cannot overwrite the next choice', async () => {
    const pending = deferred();
    const { switches } = setup();
    const runId = await open();
    await waitForEvent(runId, 'started');
    switches.mockImplementationOnce(async () => { await pending.promise; throw new Error('switch failed'); });
    const first = await switchProvider(runId, 'other');
    await vi.waitFor(() => expect(switches).toHaveBeenCalledTimes(1));
    const second = await switchProvider(runId, 'fp');
    expect(getSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe('other');
    pending.resolve();
    expect(await waitForEvent(runId, 'result', first)).toMatchObject({ ok: false });
    expect(await waitForEvent(runId, 'result', second)).toMatchObject({ ok: true });
    expect(getSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe('fp');
  });

  it('releases registration on startup failure', async () => {
    setup({ start: async () => { throw new Error('start failed'); } });
    const runId = await open();
    await waitForEvent(runId, 'closed');
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
  });

  it('does not re-register a cancelled startup when its agent finally returns', async () => {
    const pending = deferred();
    const { routes, closed } = setup({ start: () => pending.promise });
    const runId = await open();
    await vi.waitFor(() => expect(routes).toHaveLength(1));
    await host.handle(OWNER, { op: 'close', runId, mode: 'close', reason: 'navigation' });
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
    pending.resolve();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
  });

  it('keeps a reconnected task and another controller registered when an old switch fails late', async () => {
    const pending = deferred();
    const { switches } = setup();
    const first = await open();
    await waitForEvent(first, 'started');
    const peer = await open('other', 'task-1', 'controller-2');
    await waitForEvent(peer, 'started', undefined, 'controller-2');
    switches.mockImplementationOnce(async () => { await pending.promise; throw new Error('old switch failed'); });
    await switchProvider(first, 'other');
    await vi.waitFor(() => expect(switches).toHaveBeenCalledTimes(1));
    const replacement = await open('other');
    await waitForEvent(replacement, 'started');
    pending.resolve();
    await vi.waitFor(() => expect(switches.mock.settledResults[0]?.type).toBe('rejected'));
    expect(getSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe('other');
    expect(getSessionProvider(hostSessionIdFor('controller-2', 'task-1'))).toBe('other');
    await host.handle(OWNER, { op: 'close', runId: replacement, mode: 'close', reason: 'navigation' });
    expect(hasSessionProvider(hostSessionIdFor(OWNER, 'task-1'))).toBe(false);
    expect(getSessionProvider(hostSessionIdFor('controller-2', 'task-1'))).toBe('other');
  });
});
