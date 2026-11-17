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
  return { host, read: createTaskDigestReader(deps) };
}
beforeEach(() => { state.rows = [{ ...row }]; state.stored.mockReset().mockResolvedValue(null); });

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
