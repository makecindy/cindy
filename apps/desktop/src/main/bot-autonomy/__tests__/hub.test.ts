/* Unit regression for cindy-bots-runtime §6.3: persisted queued completions must
 * survive watch eviction/restart, but current opt-out still revokes owner events.
 * Existing runtime tests inject dispatch and cannot exercise the hub's durable
 * authorization. Minimal input: empty watch + completed event + durable active
 * task/assignment. This owner-scoped IO fixture is separate from runtime's injected
 * watch fixture. Actual production hub is loaded once; only host IO is replaced.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotAutonomyRuntime } from '../runtime.js';
import type { RoutineEngine } from '@cindy/maker-scheduler';
import { TaskWatch, type LocalSessionMeta, type OwnershipSnapshot } from '../taskWatch.js';
import type { BotGlance } from '../../../shared/botAutonomy.js';

const h = vi.hoisted(() => ({
  scope: 'a', scheduler: 'sched' as string | null, ready: true,
  glance: vi.fn(), refreshRemote: vi.fn(),
  readMetas: vi.fn(), readOwnership: vi.fn(), handled: vi.fn(), reportDelivery: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.scope, isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '/unused-owner-root',
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {} }) }));
vi.mock('../../maker-host/bot-autonomy-settings-store.js', () => ({
  readBotAutonomySettingsOverride: () => ({ customized: true, schedulerBotId: h.scheduler }),
  resetBotAutonomySettings: vi.fn(), writeBotAutonomySchedulerBotId: vi.fn(),
}));
vi.mock('../hostData.js', () => ({
  readLocalSessionMetas: h.readMetas, readTaskOwnership: h.readOwnership, readBotDirectory: vi.fn(),
}));
import { configureBotAutonomyHost, reportTaskDelivery, readTaskDeliveryNote, currentFollowUpEvents, getBotAutonomyGlance, setActiveBotAutonomy } from '../hub.js';

const meta = (id: string, source = 'desktop'): LocalSessionMeta => ({
  id, source, title: 'Completed task', workingDir: null, status: 'active', hiddenAt: null,
  orcaRole: null, laneRole: null, laneBotId: null, interrupted: false,
  activeTurnStartedAt: 1, lastTurnEndedAt: 2,
});
const events = ['mine', 'delegated', 'shared', 'deleted'].map(subject => ({
  sourceId: 'host:sessions', event: { id: subject, type: 'finished', subject, occurredAt: 2, data: { executionInstanceId: 'event-instance', executionGeneration: 1 } },
}));
beforeEach(() => {
  h.scope = 'a'; h.scheduler = 'sched'; h.ready = true;
  h.handled.mockReset().mockResolvedValue(false);
  h.reportDelivery.mockReset().mockReturnValue(true);
  configureBotAutonomyHost({ isCompletionHandledByTeammate: h.handled, readSessionExecution: () => ({ instanceId: 'live', generation: 2 }) });
  h.refreshRemote.mockReset().mockResolvedValue(undefined);
  h.glance.mockReset().mockReturnValue({
    botId: 'sched', scope: 'all', waiting: [], working: [], lastSweepAt: 0, doneToday: 0, offlineDevices: [],
  } satisfies BotGlance);
  const bots = new Map([['sched', { status: 'active', allowSchedulerFollow: false }]]);
  h.readMetas.mockReset().mockResolvedValue([meta('mine'), meta('delegated'), meta('shared', 'shared')]);
  h.readOwnership.mockReset().mockResolvedValue({ bots, creatorBySession: new Map([['delegated', 'sched']]), responsibleByBot: new Map() });
  setActiveBotAutonomy({ scope: 'a', engine: {} as RoutineEngine,
    runtime: { glance: h.glance, watch: { reportDelivery: h.reportDelivery, isReady: () => h.ready, getSchedulerBotId: () => h.scheduler, refreshRemote: h.refreshRemote, list: () => [], getBots: () => bots } } as unknown as BotAutonomyRuntime });
});
afterEach(() => setActiveBotAutonomy(null));

it('dispatches persisted completions after restart without watch rows, but enforces current consent', async () => {
  const batch = await currentFollowUpEvents('sched', events);
  expect(batch?.events).toEqual([events[0], events[1]]);
  expect(batch?.canDispatch()).toBe(true);
  h.scheduler = null;
  expect(batch?.canDispatch()).toBe(false);
  const revoked = await currentFollowUpEvents('sched', events);
  expect(revoked?.events.map(item => item.event.subject)).toEqual(['delegated']);
  expect(revoked?.canDispatch()).toBe(true);
});

it('defers rather than authorizing a durable read that crossed the account boundary', async () => {
  h.readMetas.mockImplementationOnce(async () => { h.scope = 'b'; return [meta('mine')]; });
  expect(await currentFollowUpEvents('sched', events)).toBeNull();
});

// #6508: the public glance reader must not report a successful empty workbench
// before its host/ownership is ready. Existing coverage only exercised follow-up
// authorization. Minimal unit inputs: missing, stale, or unready runtime.
it.each(['missing', 'stale', 'unready'] as const)('rejects a %s runtime instead of reporting no work', (state) => {
  if (state === 'missing') setActiveBotAutonomy(null);
  if (state === 'stale') h.scope = 'other';
  if (state === 'unready') h.ready = false;
  expect(() => getBotAutonomyGlance('sched')).toThrow(/\[PRECONDITION_FAILED\]/u);
  expect(h.glance).not.toHaveBeenCalled();
  expect(h.refreshRemote).not.toHaveBeenCalled();
});

it('returns the actual empty projection once ready, preserving scope and visibility options', () => {
  const options = { excludeBotIds: new Set(['hidden']) };
  expect(getBotAutonomyGlance('sched', options)).toMatchObject({ botId: 'sched', scope: 'all', waiting: [], working: [] });
  expect(h.glance).toHaveBeenCalledWith('sched', options);
});

// Unit §6.3: UI probe versus explicit view read, including an owner change while IO waits.
it('only refreshes remote state for an explicit scheduler workbench read and discards cross-account results', async () => {
  const remote = vi.fn(async () => {});
  const projection = { botId: 'sched', waiting: [] };
  setActiveBotAutonomy({ scope: 'a', engine: {} as RoutineEngine, runtime: {
    watch: { isReady: () => true, getSchedulerBotId: () => 'sched', refreshRemote: remote },
    glance: () => projection,
  } as unknown as BotAutonomyRuntime });
  expect(await getBotAutonomyGlance('sched', undefined, false)).toBe(projection);
  await getBotAutonomyGlance('own');
  expect(remote).not.toHaveBeenCalled();
  expect(await getBotAutonomyGlance('sched')).toBe(projection);
  expect(remote).toHaveBeenCalledOnce();
  remote.mockImplementationOnce(async () => { h.scope = 'b'; });
  expect(() => getBotAutonomyGlance('sched')).toThrow('PRECONDITION_FAILED');
});

// Unit regression for #6675: a nonresponding peer must not block the first cached
// glance. Existing immediate remote mocks cannot expose the unresolved IPC.
it('returns the cached glance while a remote peer is still pending or fails', async () => {
  let rejectRemote!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { rejectRemote = reject; });
  const projection = { botId: 'sched', working: [{ sessionId: 'local' }] };
  setActiveBotAutonomy({ scope: 'a', engine: {} as RoutineEngine, runtime: {
    watch: { isReady: () => true, getSchedulerBotId: () => 'sched', refreshRemote: () => pending },
    glance: () => projection,
  } as unknown as BotAutonomyRuntime });
  try {
    // The detached permission handler also consumes this synchronous projection.
    expect(getBotAutonomyGlance('sched')).toBe(projection);
  } finally {
    rejectRemote(new Error('remote unavailable'));
    await Promise.resolve();
  }
  expect(await getBotAutonomyGlance('sched', undefined, false)).toBe(projection);
});

// #6440 / unit: a queued finished event and a dedicated receipt previously both
// woke the parent. Exercise the production built-in dispatch gate, preserving
// the published event for custom routines and unrelated events in the same batch.
it('filters only receipt-owned completion from built-in follow-up without mutating published events', async () => {
  h.handled.mockImplementation(async id => id === 'delegated');
  const failed = { ...events[1], event: { ...events[1].event, type: 'errored' } };
  const batch = [...events, failed];
  const result = await currentFollowUpEvents('sched', batch);
  expect(result?.events).toEqual([events[0], failed]);
  expect(result?.canDispatch()).toBe(true);
  expect(batch).toEqual([...events, failed]);
  expect(h.handled).toHaveBeenCalledWith('delegated', 'sched', { instanceId: 'event-instance', generation: 1 });
});

it.each(['unready', 'failed', 'account-changed'] as const)('defers a %s receipt read and retries the original completion batch', async state => {
  if (state === 'unready') h.handled.mockResolvedValueOnce(null);
  else if (state === 'failed') h.handled.mockRejectedValueOnce(new Error('database unavailable'));
  else h.handled.mockImplementationOnce(async () => { h.scope = 'b'; return false; });
  expect(await currentFollowUpEvents('sched', events)).toBeNull();
  h.scope = 'a';
  expect((await currentFollowUpEvents('sched', events))?.events).toEqual([events[0], events[1]]);
});

// A pre-upgrade event has no execution identity; never infer it from a live turn.
it('keeps unattributed legacy completion events', async () => {
  h.handled.mockResolvedValue(true);
  const legacy = [{ ...events[1], event: { ...events[1].event, data: {} } }];
  expect((await currentFollowUpEvents('sched', legacy))?.events).toEqual(legacy);
  expect(h.handled).not.toHaveBeenCalled();
});

// Unit / #7253: no delivery context for unrelated work or the companion's own
// main chat; explicit assignments still receive it while all-task follow is off.
it('limits delivery reporting context to followed work and drops stale owner reads', async () => {
  h.scheduler = null;
  expect(await readTaskDeliveryNote('mine')).toBeNull();
  expect(await readTaskDeliveryNote('delegated')).toContain('report_task_delivery');
  h.readOwnership.mockImplementationOnce(async () => { h.scope = 'b'; return { bots: new Map(), creatorBySession: new Map() }; });
  expect(await readTaskDeliveryNote('delegated')).toBeNull();
});

// Unit / #7253: a retired runtime cannot borrow a replacement's current turn.
// Existing watch identity tests do not enter the Host callback with caller context.
it('rejects a delivery call from a retired runtime before recording it', () => {
  expect(reportTaskDelivery('delegated', true, 'retired')).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
  expect(h.reportDelivery).not.toHaveBeenCalled();
  expect(reportTaskDelivery('delegated', true, 'live')).toEqual({ ok: true });
  expect(h.reportDelivery).toHaveBeenCalledWith('delegated', { instanceId: 'live', generation: 2 }, true);
});

// Unit / #7253 live acceptance: starting the following companion refreshes
// ownership while its notification is queued. Identical reads used to revoke
// dispatch on every retry. Exercise the actual Host consent gate with TaskWatch;
// then revoke responsibility without changing the bot directory to retain safety.
it('keeps a final delivery dispatch valid across identical refreshes but revokes real ownership changes', async () => {
  const readOwnership = async () => structuredClone(await h.readOwnership()) as OwnershipSnapshot;
  const watch = new TaskWatch({ now: () => 10, onChange: () => {}, log: { info() {}, warn() {}, debug() {} },
    getActivitySnapshots: () => [], isToolCallInFlight: () => false, getPendingInteractions: () => [],
    readLocalSessions: h.readMetas, readInterruptedSessions: async () => [], readOwnership,
    readSchedulerOverride: () => ({ customized: true, schedulerBotId: h.scheduler }),
    listRemoteDevices: async () => null, invokeRemote: async () => null,
  });
  await watch.start();
  setActiveBotAutonomy({ scope: 'a', engine: {} as RoutineEngine, runtime: { watch } as BotAutonomyRuntime });
  try {
    const batch = await currentFollowUpEvents('sched', events);
    expect(batch?.canDispatch()).toBe(true);
    await watch.refreshFollowers();
    expect(batch?.canDispatch()).toBe(true);
    const changed = await readOwnership();
    changed.creatorBySession.set('delegated', 'another');
    h.readOwnership.mockResolvedValue(changed);
    await watch.refreshFollowers();
    expect(batch?.canDispatch()).toBe(false);
  } finally { watch.stop(); }
});
