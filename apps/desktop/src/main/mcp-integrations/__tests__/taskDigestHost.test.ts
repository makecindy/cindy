/**
 * #10466: exercise the real host -> digest path with synthetic DB/runtime boundaries.
 * Existing assembly tests inject finished errors and miss the retired watcher source.
 * Minimal input: an error activity plus HTTP 502/403; unit tier, no account or network.
 * A separate file isolates host module mocks from the dependency-only assembly suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[], stored: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => state.rows }) }) }),
} }) }));
vi.mock('../../localDb/schema.js', () => ({ sessions: {}, botProfileVersions: {}, botSessionLinks: {} }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => null }));
vi.mock('../../maker-host/bot-model-chain-settings-store.js', () => ({ readEffectiveBotModelChain: () => null }));
vi.mock('../../maker-host/model-context-settings.js', () => ({ resolveConfiguredContextWindow: () => null }));
vi.mock('../../maker-ipc/contextOverflowRollover.js', () => ({ lookupVerifiedContextWindow: () => null }));
vi.mock('../../maker-ipc/sessionRuntimeControl.js', () => ({ getSessionRuntimeControlSnapshot: () => ({ visitedRoutes: [] }) }));
vi.mock('../../maker-ipc/orcaTurnErrorQuery.js', () => ({ readLatestWorkerTurnError: state.stored }));
vi.mock('../../maker-ipc/sessionLastExchange.js', () => ({ lastExchange: () => ({}), readSessionLastExchange: async () => ({ lastUserAsk: 'go', lastAssistantLine: null }) }));
vi.mock('../remoteChatHistory.js', () => ({ readChatHistoryMessages: async () => ({ ok: false }) }));
import { createTaskDigestReader } from '../taskDigest.js';
import { createDesktopTaskDigestDeps, type DesktopTaskDigestHost } from '../taskDigestHost.js';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';
import { AgentInputCoordinator } from '../../maker-ipc/agent-input-coordinator.desktop.js';
import { createInputEnqueueHarness, createInputStopHarness } from '../../maker-ipc/__tests__/inputEnqueueHarness.js';
import { resolveSessionQueueCounts } from '../../maker-ipc/sessionQueueInspection.js';
import { XdtHelperToolRegistry } from '../../../../../../packages/lizi-mcps/src/lizi_xdtHelperToolRegistry.js';
import { registerGetTaskDigestTool } from '../../../../../../packages/lizi-mcps/src/xdt-helper/get_task_digest.js';
import type { XdtHelperHistoryDeps } from '../../../../../../packages/lizi-mcps/src/xdt-helper/_history_types.js';
import type { WatchedSession } from '../../../shared/botAutonomy.js';

const row = { title: 'synthetic task', status: 'active', source: 'desktop', agentKind: 'pi', model: 'model', providerId: 'gateway', clearedAt: null, activeTurnStartedAt: 100 };
function setup(phase = 'error', errorStatus: number | null = 502) {
  const host: DesktopTaskDigestHost = {
    invokeRemote: vi.fn(async () => ({ ok: true as const, result: null })),
    getSessionRuntime: vi.fn(async () => ({ ok: true as const, runtime: { phase, startedAtMs: 100 } })),
    listSessionQueuedCounts: async () => ({ ok: true, counts: {} }),
    readSessionPrStatuses: async () => [],
    readRuntimeFacts: vi.fn(async () => ({ live: null, closed: null, terminalError: errorStatus === null ? null : { errorStatus, sdkError: `HTTP ${errorStatus}: upstream unavailable` } })),
  };
  const deps = createDesktopTaskDigestDeps(host);
  return { host, deps, read: createTaskDigestReader(deps) };
}
beforeEach(() => { state.rows = [{ ...row }]; state.stored.mockReset().mockResolvedValue(null); });

// #13146, unit: the tool JSON must preserve a plugin engine from host data,
// including the task row when no built-in profile exists. Failed ACP tasks must
// skip built-in suggestions. The existing host tests only exercised Pi rows.
describe('desktop task digest route identity', () => {
  it.each([
    { variant: 'no profile', harness: 'acp', phase: 'running' },
    { variant: 'runtime throws', harness: 'acp', phase: 'idle' },
    { variant: 'ACP profile', harness: 'acp', phase: 'running' },
    { variant: 'errored', harness: 'acp', phase: 'errored' },
    { variant: 'usage-limit', harness: 'acp', phase: 'usage-limit' },
    { variant: 'remote ACP row', harness: 'acp', phase: 'running' },
    { variant: 'legacy ACP row without provider', harness: 'acp', phase: 'running' },
    { variant: 'legacy remote row', harness: null, phase: 'running' },
    { variant: 'Pi profile', harness: 'pi', phase: 'running' },
    { variant: 'Claude Code profile', harness: 'claude-code', phase: 'running' },
    { variant: 'Codex profile', harness: 'codex', phase: 'running' },
  ] as const)('projects $variant as JSON with the expected route', async ({ variant, harness, phase }) => {
    const { host, deps } = setup('running');
    const sessionId = 'synthetic-task';
    const pluginProviderId = 'acp-plugin:fixture:sample';
    const agentKind = harness ?? undefined;
    const legacy = variant === 'legacy remote row' || variant === 'legacy ACP row without provider';
    const providerId = legacy ? undefined : harness === 'acp' ? pluginProviderId : 'gateway';
    const profile = { agentKind, model: 'fixture-model', providerId };
    const hasProfile = variant === 'ACP profile' || (harness !== 'acp' && harness !== null);
    const taskRow = { ...row, ...profile, ...(hasProfile && { model: 'stored-model' }) };
    state.rows = [taskRow];
    const remote = variant === 'remote ACP row' || legacy;
    const key = remote ? `fixture-device::${sessionId}` : sessionId;
    if (remote) {
      vi.mocked(host.invokeRemote).mockImplementation(async (_device, channel) => ({
        ok: true,
        result: channel === 'local-db:sessions:get' ? taskRow :
          channel === 'maker:list-active' ? (legacy ? [{ sessionId, isTurnRunning: true }] :
            { format: 'active-sessions-v2', sessions: [{ sessionId, isTurnRunning: true }] }) : [],
      }));
    } else if (variant === 'runtime throws') {
      vi.mocked(host.getSessionRuntime).mockRejectedValue(new Error('no built-in runtime profile'));
    } else {
      vi.mocked(host.getSessionRuntime).mockResolvedValue({
        ok: true,
        runtime: {
          phase: phase === 'errored' ? 'error' : 'running',
          ...(hasProfile && { effectiveProfile: profile }),
        },
      });
    }
    if (phase === 'usage-limit') {
      const watched: WatchedSession = {
        sessionId, deviceId: null, deviceName: null, online: true, title: row.title, workingDir: null,
        phase, phaseSince: 100, lastActivityAt: 100, startedAt: null,
        pendingQuestion: null, error: 'fixture usage limit', errorReason: null,
        creatorBotId: null, followerBotId: null, source: 'user',
      };
      deps.watched = () => watched;
    }
    const suggestRoute = vi.spyOn(deps.local, 'suggestRoute');
    const registry = new XdtHelperToolRegistry();
    const unexpectedHistoryRead = async () => { throw new Error('Unexpected history read'); };
    registerGetTaskDigestTool(registry, {
      history: {
        listWorkdirs: unexpectedHistoryRead,
        listSessions: unexpectedHistoryRead,
        getMessages: unexpectedHistoryRead,
        searchChatHistory: unexpectedHistoryRead,
        taskDigest: createTaskDigestReader(deps),
        resolveSessionScope: async () => ({ ok: true, sessionIds: [key] }),
      },
      getSessionContext: () => ({ sessionId: 'fixture-caller', agentKind: 'codex', workingDir: '/synthetic' }),
    });
    const block = (await registry.call('get_task_digest', { session_id: key })).content[0];
    if (block.type !== 'text') throw new Error('Expected digest JSON');
    expect(Buffer.byteLength(block.text, 'utf8')).toBeLessThanOrEqual(2048);
    expect(JSON.parse(block.text)).toMatchObject({
      ok: true, session_id: key, phase, suggested_route: null,
      current_route: harness === null ? null : { harness, provider_id: providerId ?? null, model: profile.model },
    });
    expect(suggestRoute).not.toHaveBeenCalled();
  });
});

describe('desktop task digest error sources', () => {
  it.each([502, 403])('returns HTTP %s from runtime even without a caller or watcher', async (status) => {
    const { read } = setup('error', status);
    expect(await read({ sessionId: 'task' })).toMatchObject({ ok: true, digest: { phase: 'errored', error: expect.stringContaining(`HTTP ${status}`) } });
  });
  it('uses the current durable error for a cold task, excluding prior turns', async () => {
    const { read } = setup('error', null);
    state.stored.mockResolvedValue({ message: 'API Error', sdkError: 'HTTP 403 denied', createdAt: 101 });
    expect(await read({ sessionId: 'task' })).toMatchObject({ ok: true, digest: { error: 'API Error: HTTP 403 denied' } });
    state.stored.mockResolvedValue({ message: 'old failure', createdAt: 99 });
    expect(await read({ sessionId: 'task' })).toMatchObject({ ok: true, digest: { error: null } });
  });
  // #8100, unit: an immediate error tail can have an earlier timestamp than the turn
  // marker. The normal chronological fallback never exercised this cold digest path.
  it.each([
    { case: 'matching persisted terminal', source: 'persisted', terminalAt: 99, endedAt: 101, safety: true, error: 'provider-safety-refusal' },
    { case: 'live activity', source: 'live', terminalAt: 99, endedAt: 101, safety: true, error: null },
    { case: 'different tail', source: 'persisted', terminalAt: 98, endedAt: 101, safety: true, error: null },
    { case: 'unsettled turn', source: 'persisted', terminalAt: 99, endedAt: 98, safety: true, error: null },
    { case: 'ordinary failure', source: 'persisted', terminalAt: 99, endedAt: 101, safety: false, error: null },
  ])('projects only the safe reason for an older error row with $case', async ({ source, terminalAt, endedAt, safety, error }) => {
    const { host, read } = setup('error', null);
    state.rows = [{ ...row, lastTurnEndedAt: endedAt }];
    vi.mocked(host.getSessionRuntime).mockResolvedValue({
      ok: true,
      runtime: { phase: 'error', source, startedAtMs: 100, lastActivityAtMs: terminalAt },
    });
    state.stored.mockResolvedValue({
      message: safety ? '{"error":{"code":"safety_violation","message":"Synthetic provider detail"}}' : 'Ordinary failure',
      createdAt: 99,
    });

    expect(await read({ sessionId: 'task' })).toMatchObject({ ok: true, digest: { phase: 'errored', error } });
  });
  it.each(['running', 'completed', 'needs-interaction'])('never reads stale details for %s', async (phase) => {
    const { read, host } = setup(phase);
    expect(await read({ sessionId: 'task' })).toMatchObject({ ok: true, digest: { error: null } });
    expect(host.readRuntimeFacts).not.toHaveBeenCalled();
    expect(state.stored).not.toHaveBeenCalled();
  });
  it('redacts before clipping and excludes shared-task text', async () => {
    const { read, host } = setup();
    vi.mocked(host.readRuntimeFacts!).mockResolvedValue({ live: null, closed: null, terminalError: { errorStatus: 403, sdkError: `Authorization: Bearer fake-sensitive-${'x'.repeat(500)}\nHTTP 403 /Users/test/private.txt` } });
    const result = await read({ sessionId: 'task' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digest.error).toContain('HTTP 403');
    expect(result.digest.error).not.toContain('fake-sensitive');
    expect(result.digest.error).not.toContain('/Users/test');
    expect(Array.from(result.digest.error ?? '').length).toBeLessThanOrEqual(300);
    state.rows = [{ ...row, source: 'shared' }];
    expect(await read({ sessionId: 'shared' })).toMatchObject({ ok: true, digest: { error: null, shared_task: true } });
  });
  it('keeps a digest usable if both error sources fail', async () => {
    const { read, host } = setup();
    vi.mocked(host.readRuntimeFacts!).mockRejectedValue(new Error('unavailable'));
    state.stored.mockRejectedValue(new Error('db unavailable'));
    expect(await read({ sessionId: 'task' })).toMatchObject({ ok: true, digest: { phase: 'errored', error: null } });
  });
  // #10930 review: the path redactor's 120-character IPC limit hid later causes.
  it.each(['runtime', 'stored', 'remote'].flatMap(source => [false, true].map(splitFields => [source, splitFields] as const)))('preserves a later failure cause within the digest budget from %s (split-fields=%s)', async (source, splitFields) => {
    const { read, host } = setup('error', null);
    const detail = `${'request context '.repeat(10)}HTTP 403 quota denied /Users/test/private.txt ${'tail '.repeat(80)}`;
    const message = `Authorization: Bearer fake-sensitive-token${splitFields ? '' : `\n${detail}`}`;
    const sdkError = splitFields ? detail : undefined;
    if (source === 'runtime') {
      vi.mocked(host.readRuntimeFacts!).mockResolvedValue({ live: null, closed: null, terminalError: { message, sdkError } });
    } else if (source === 'stored') {
      state.stored.mockResolvedValue({ message, sdkError, createdAt: 101 });
    } else {
      vi.mocked(host.invokeRemote).mockImplementation(async (_device, channel) => ({ ok: true, result:
        channel === 'local-db:sessions:get' ? row :
        channel === 'maker:list-active' ? { format: 'active-sessions-v2', sessions: [] } :
        channel === DL_HISTORY_MESSAGES_CHANNEL ? { items: [{ sessionId: 'task', role: 'error', content: { message, sdkError }, createdAt: 101 }], terminal: { status: 'error', createdAt: 101 } } : [],
      }));
    }
    const result = await read({ sessionId: source === 'remote' ? 'laptop::task' : 'task' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digest.error).toContain('HTTP 403 quota denied');
    expect(result.digest.error).not.toContain('/Users/test');
    expect(result.digest.error).not.toContain('fake-sensitive-token');
    expect(Array.from(result.digest.error ?? '')).toHaveLength(300);
  });
  it('reads a cold remote terminal through the existing authorized history channel', async () => {
    const { host, read } = setup();
    vi.mocked(host.invokeRemote).mockImplementation(async (_device, channel) => ({ ok: true, result:
      channel === 'local-db:sessions:get' ? row :
      channel === 'maker:list-active' ? { format: 'active-sessions-v2', sessions: [] } :
      channel === DL_HISTORY_MESSAGES_CHANNEL ? { items: [{ sessionId: 'task', role: 'error', content: { message: 'HTTP 502 interrupted' }, createdAt: 101 }], terminal: { status: 'error', createdAt: 101 } } : [],
    }));
    expect(await read({ sessionId: 'laptop::task' })).toMatchObject({ ok: true, digest: { phase: 'errored', error: 'HTTP 502 interrupted', suggested_route: null } });
    expect(host.invokeRemote).toHaveBeenCalledWith('laptop', DL_HISTORY_MESSAGES_CHANNEL, [expect.objectContaining({ sessionId: 'task', roles: ['error'], limit: 1, includeRewound: false })]);
    expect(host.readRuntimeFacts).not.toHaveBeenCalled();
  });
  it.each(['cleared', 'new-turn', 'wrong-session', 'dismissed', 'missing-marker'])('omits remote %s errors', async (variant) => {
    const { host, read } = setup();
    vi.mocked(host.invokeRemote).mockImplementation(async (_device, channel) => ({ ok: true, result:
      channel === 'local-db:sessions:get' ? { ...row, clearedAt: variant === 'cleared' ? new Date(101).toISOString() : null, activeTurnStartedAt: variant === 'new-turn' ? 102 : 100 } :
      channel === 'maker:list-active' ? { format: 'active-sessions-v2', sessions: [] } :
      channel === DL_HISTORY_MESSAGES_CHANNEL ? { items: [{ sessionId: variant === 'wrong-session' ? 'other' : 'task', role: 'error', content: { message: 'HTTP 403', dismissed: variant === 'dismissed' }, createdAt: 101 }], terminal: variant === 'missing-marker' ? null : { status: 'error', createdAt: 101 } } : [],
    }));
    expect(await read({ sessionId: 'laptop::task' })).toMatchObject({ ok: true, digest: { error: null } });
  });
});


// #10900, unit: desktop enqueue and explicit Stop IPC handlers feed the real
// coordinator and registered digest tool. Queue-only tests cannot catch a
// lost pause bit in the read-only JSON for a stopped task with one queued input.
it('reports the pause of a stopped ordinary task in its registered digest', async () => {
  const sessionId = 'ordinary-task';
  const callerId = 'same-account-observer';
  let running = true;
  const send = vi.fn(async () => { throw new Error('Unexpected synthetic dispatch'); });
  const save = vi.fn();
  const load = vi.fn(async () => []);
  const coordinator = new AgentInputCoordinator({
    sendToAgent: send,
    steerToAgent: async () => {},
    abortSession: async () => { running = false; },
    isTurnRunning: () => running,
    hasPendingInteraction: () => false,
    getAgentKind: () => 'codex',
    getSdkSessionId: async () => undefined,
    emitProjection: vi.fn(),
    loadQueueSnapshot: load,
    persistQueueSnapshot: save,
  });
  const { host } = setup();
  host.readLocalQueuePaused = id => coordinator.getQueuePausedIfRestored(id);
  host.getSessionRuntime = async () => ({ ok: true, runtime: { phase: running ? 'running' : 'completed' } });
  host.listSessionQueuedCounts = async ids => ({ ok: true, counts: await resolveSessionQueueCounts(ids, {
    getLiveQueue: id => coordinator.getQueueInspectionIfRestored(id),
    loadPersistedCounts: async () => ({}),
  }) });
  const registry = new XdtHelperToolRegistry();
  registerGetTaskDigestTool(registry, {
    history: {
      taskDigest: createTaskDigestReader(createDesktopTaskDigestDeps(host)),
      resolveSessionScope: async ({ callerSessionId }) => ({
        ok: true, sessionIds: callerSessionId === callerId ? [sessionId] : [],
      }),
    } as XdtHelperHistoryDeps,
    getSessionContext: () => ({ sessionId: callerId, agentKind: 'codex', workingDir: '/synthetic' }),
  });
  const digest = async () => {
    const block = (await registry.call('get_task_digest', { session_id: sessionId })).content[0];
    if (block.type !== 'text') throw new Error('Expected digest JSON');
    return JSON.parse(block.text);
  };
  const readDigestWithProjection = async (phase: string, queuedCount: number, queuePaused: boolean) => {
    const projection = coordinator.getProjection(sessionId);
    const calls = [send, save, load].map(fn => fn.mock.calls.length);
    const result = await digest();
    console.info('digest evidence', { phase: result.phase, queuedCount: result.queued_count,
      canonicalQueuePaused: projection.queuePaused, digestQueuePaused: result.queue_paused });
    expect(result).toMatchObject({ ok: true, phase, queued_count: queuedCount });
    // Reading the second snapshot advances its wire sequence once. The digest
    // between the two reads must leave every queue field and the clock alone.
    expect(coordinator.getProjection(sessionId)).toEqual({
      ...projection,
      queueSnapshot: { ...projection.queueSnapshot, sequence: projection.queueSnapshot!.sequence + 1 },
    });
    expect([send, save, load].map(fn => fn.mock.calls.length)).toEqual(calls);
    expect(projection.queuePaused).toBe(queuePaused);
    return result.queue_paused;
  };

  expect(await digest()).not.toHaveProperty('queue_paused');
  const { enqueue } = createInputEnqueueHarness(coordinator, { remote: false });
  const text = 'Synthetic pending input';
  const createOpts = {
    agentKind: 'codex' as const, workingDir: '/synthetic', model: 'model', effort: 'medium',
    permissionMode: 'default' as const, userPrompt: '', makerMemoryEnabled: true,
  };
  await enqueue({}, sessionId, {
    ...createOpts, clientId: 'pending-input', text, persistedContent: text, createOpts,
    chatMessage: { clientId: 'pending-input', role: 'user', content: text, isStreaming: false, createdAt: new Date(0).toISOString() },
  });
  const duringTurn = await readDigestWithProjection('running', 1, false);

  await createInputStopHarness(coordinator, { remote: false })(sessionId, { keepQueue: true, pauseQueue: true });
  const stopped = await readDigestWithProjection('finished', 1, true);
  coordinator.resume(sessionId);
  const resumed = await readDigestWithProjection('finished', 1, false);
  await createInputStopHarness(coordinator, { remote: false })(sessionId);
  const empty = await readDigestWithProjection('finished', 0, false);
  expect({ duringTurn, stopped, resumed, empty }).toEqual({
    duringTurn: false, stopped: true, resumed: false, empty: false,
  });
});

// Value: local and remote host paths project provider_device_id, privacy-safe device name,
// and last_route_change without issuing any extra remote RPC beyond existing read channels.
// Gap: existing host digest tests mocked minimal profiles without agentDeviceId or route attribution.
// Minimal input: local runtime with routeSource/lastRouteChange + remote sessions:get with runtimeLastRouteChange; tier: unit.
it('projects provider device and last_route_change in host digest without extra remote RPCs', async () => {
  const { host, read } = setup('completed', null);
  const routeChange = {
    at: '2026-11-28T10:00:00.000Z',
    by: 'model-group' as const,
    reason: 'provider_safety_refusal',
    from: { agentKind: 'claude-code', model: 'claude-opus-4-6', providerId: 'anthropic', agentDeviceId: null },
    to: { agentKind: 'codex', model: 'gpt-5.6', providerId: 'openai', agentDeviceId: 'studio-2' },
  };
  state.rows = [{ ...row, agentKind: 'codex', agentDeviceId: 'studio-2', model: 'gpt-5.6', providerId: 'openai' }];
  vi.mocked(host.getSessionRuntime).mockResolvedValue({
    ok: true,
    runtime: {
      phase: 'completed',
      runtimeGeneration: 5,
      effectiveProfile: { agentKind: 'codex', agentDeviceId: 'studio-2', model: 'gpt-5.6', providerId: 'openai', effort: 'high', fastMode: false },
      routeSource: { kind: 'device', providerDeviceId: 'studio-2', providerDeviceName: 'Mac Studio' },
      lastRouteChange: routeChange,
    },
  });

  expect(await read({ sessionId: 'local-task' })).toMatchObject({
    ok: true,
    digest: {
      current_route: { provider_device_id: 'studio-2', source_kind: 'device', provider_device_name: 'Mac Studio' },
      last_route_change: {
        by: 'model-group',
        reason: 'provider_safety_refusal',
        from: { harness: 'claude-code', provider_device_id: 'local' },
        to: { harness: 'codex', provider_device_id: 'studio-2' },
      },
    },
  });

  // Remote path reads runtimeLastRouteChange from existing local-db:sessions:get with zero extra channels.
  host.listDevices = async () => [
    { deviceId: 'laptop', deviceName: 'MacBook', online: true, local: false, available: true },
    { deviceId: 'studio-2', deviceName: 'Mac Studio', online: true, local: false, available: true },
  ];
  vi.mocked(host.invokeRemote).mockImplementation(async (_device, channel) => ({
    ok: true,
    result: channel === 'local-db:sessions:get'
      ? { ...row, agentKind: 'codex', agentDeviceId: 'studio-2', model: 'gpt-5.6', providerId: 'openai', runtimeLastRouteChange: routeChange }
      : channel === 'maker:list-active'
        ? { format: 'active-sessions-v2', sessions: [{ sessionId: 'remote-task', isTurnRunning: true }] }
        : [],
  }));
  const remoteResult = await read({ sessionId: 'laptop::remote-task' });
  expect(remoteResult).toMatchObject({
    ok: true,
    digest: {
      device: 'MacBook',
      phase: 'running',
      current_route: { provider_device_id: 'studio-2', source_kind: 'device', provider_device_name: 'Mac Studio' },
      last_route_change: { by: 'model-group', reason: 'provider_safety_refusal' },
    },
  });
  const remoteChannels = vi.mocked(host.invokeRemote).mock.calls.map(([, channel]) => channel);
  expect(remoteChannels).not.toContain(DL_HISTORY_MESSAGES_CHANNEL);
});

// Unit, host -> digest: a persisted switch remains readable while current, then
// /clear's in-memory boundary must hide it even if the DB row is still stale.
// A runtime null must also suppress the facts fallback when no boundary exists.
it('hides persisted route attribution after a clear boundary before the database update lands', async () => {
  const { noteSessionClearBoundary } = await import('../../messagePersistBroadcaster.desktop.js');
  const { host, read } = setup('completed', null);
  const change = {
    at: '2026-11-28T10:00:00.000Z', by: 'agent', reason: 'explicit',
    from: { agentKind: 'pi', model: 'old', providerId: 'gateway', agentDeviceId: null },
    to: { agentKind: 'pi', model: 'model', providerId: 'gateway', agentDeviceId: null },
  };
  host.readPersistedRouteChange = vi.fn(async () => change);
  expect(await read({ sessionId: 'local-task' })).toMatchObject({
    ok: true, digest: { last_route_change: { by: 'agent', reason: 'explicit' } },
  });
  noteSessionClearBoundary('local-task', Date.parse(change.at) + 1);
  try {
    const result = await read({ sessionId: 'local-task' });
    expect(result).toMatchObject({ ok: true });
    expect((result as { digest?: Record<string, unknown> }).digest).not.toHaveProperty('last_route_change');
  } finally {
    noteSessionClearBoundary('local-task', null);
  }
  vi.mocked(host.getSessionRuntime).mockResolvedValue({ ok: true, runtime: { phase: 'completed', lastRouteChange: null } });
  const explicitlyCleared = await read({ sessionId: 'local-task' });
  expect(explicitlyCleared).toMatchObject({ ok: true });
  expect((explicitlyCleared as { digest?: Record<string, unknown> }).digest).not.toHaveProperty('last_route_change');
});
