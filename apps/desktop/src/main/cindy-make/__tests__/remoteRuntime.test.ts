import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor';
import type { RemoteResourceProvider } from '../../device-link/remoteResourceRegistry';

const h = vi.hoisted(() => ({
  owner: 1,
  running: false,
  session: {} as Record<string, unknown>,
  rows: [] as Array<{ clientId: string; role: string; agentMeta: string | null }>,
  prep: undefined as MakeDoctorReport | undefined,
  restore: vi.fn(),
  test: vi.fn(),
  history: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  send: vi.fn(),
  changed: vi.fn(),
  readBuild: vi.fn(),
  cancel: vi.fn(),
  beforeRead: vi.fn(),
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => clientDb }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: String(h.owner) }),
  isDataOwnerBroadcastScopeCurrent: (scope: { ownerScopeKey: string }) =>
    scope.ownerScopeKey === String(h.owner),
}));
vi.mock('../../i18n.js', () => ({ t: (key: string, locale: string) => locale + ':' + key }));
vi.mock('../manager.js', () => ({
  cindyMakeManager: {
    getState: () => ({ tasks: h.prep ? { run: h.prep } : {} }),
    cancelTasksForSession: h.cancel,
  },
}));
vi.mock('../taskRuntime.js', () => ({
  restoreCindyMakeTaskState: h.restore,
  dispatchCindyMakeTask: h.send,
  startCindyMakeTask: h.start,
}));
vi.mock('../testRuntime.js', () => ({ actCindyMakeTest: h.test }));
vi.mock('../historyRuntime.js', () => ({
  getCindyMakeHistory: h.history,
  cancelHistoryPersonalVersion: h.stop,
  readCindyMakeBuildState: h.readBuild,
}));
vi.mock('../remoteBroadcast.js', () => ({ broadcastMakeRemoteChanged: h.changed }));
import { sessions } from '../../localDb/schema';
import { remoteResourceRegistry } from '../../device-link/remoteResourceRegistry';
import { registerMakeRemoteResources } from '../remoteRuntime';

const clientDb = {
  drizzle: {
    select: () => {
      let sessionTable = false;
      const query = {
        from: (table: unknown) => {
          sessionTable = table === sessions;
          return query;
        },
        where: () => query,
        orderBy: () => query,
        limit: async () => {
          await h.beforeRead(sessionTable);
          return structuredClone(sessionTable ? [h.session] : h.rows);
        },
      };
      return query;
    },
  },
};
const context = { controllerDeviceId: 'phone' };
const client = { protocolVersion: 1, primitives: ['session-controls'], locale: 'ja' };
const ref = { collectionId: 'cindy-make', kind: 'session', id: 'task' };
let provider: RemoteResourceProvider;
const get = () => provider.get!(context, { client, ref });
const invoke = (actionId: string) =>
  provider.invoke!(context, { client, collectionId: ref.collectionId, resourceRef: ref, actionId });
const completion = (continuedAt?: number) => ({
  clientId: 'done',
  role: 'assistant',
  agentMeta: JSON.stringify({
    cindyMakeCompletion: { reportedAt: 1, commit: 'a'.repeat(40), continuedAt },
  }),
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  h.owner = 1;
  h.running = false;
  h.prep = undefined;
  h.session = {
    id: 'task',
    status: 'active',
    source: 'cindy-make',
    workingDir: '/managed/task',
    agentKind: 'codex',
    model: 'chosen',
    lastTurnEndedAt: 10,
  };
  h.rows = [completion()];
  h.restore.mockResolvedValue(undefined);
  h.test.mockImplementation(
    async (_id, completionId) =>
      JSON.parse(h.rows.find((row) => row.clientId === completionId)!.agentMeta!)
        .cindyMakeCompletion,
  );
  vi.spyOn(remoteResourceRegistry, 'register').mockImplementation((next) => {
    provider = next;
    return () => {};
  });
  registerMakeRemoteResources(() => h.running);
});

describe('Cindy Make mobile host adapter', () => {
  it('restores preparation once per owner and normalizes a persisted interrupted test through the shared controller', async () => {
    h.test.mockResolvedValue({
      reportedAt: 1,
      commit: 'a'.repeat(40),
      test: { status: 'stopped', step: 'assets', error: 'interrupted' },
    });
    const card = await get();
    expect(h.test).toHaveBeenCalledWith('task', 'done', 'status');
    expect(card.blocks?.[0].fallbackMarkdown).toContain('cindyMake.test.failedStep');
    await get();
    expect(h.restore).toHaveBeenCalledOnce();
    h.owner += 1;
    await get();
    expect(h.restore).toHaveBeenCalledTimes(2);
  });
  it('keeps Continue Editing and a later successful reply recoverable, but not an interrupted reply', async () => {
    h.rows = [completion(2)];
    expect((await get()).actions?.[0].id).toMatch(/^resume:/);
    expect(h.test).not.toHaveBeenCalled();
    h.rows = [
      { clientId: 'reply', role: 'assistant', agentMeta: JSON.stringify({ turnCompleted: true }) },
      { clientId: 'user', role: 'user', agentMeta: null },
      completion(),
    ];
    const card = await get();
    expect(card.actions?.[0].id).toMatch(/^resume:/);
    await invoke(card.actions![0].id);
    expect(h.test).toHaveBeenCalledWith('task', 'reply', 'resume-start');
    await invoke(card.actions![1].id);
    expect(h.test).toHaveBeenCalledWith('task', 'reply', 'resume-build');
    expect(h.send).not.toHaveBeenCalled();
    h.rows[0].agentMeta = JSON.stringify({ turnCompleted: false });
    expect((await get()).actions).toEqual([]);
  });
  it('does not show a previous completion after a new user message or offer actions during execution', async () => {
    h.rows.unshift({ clientId: 'user', role: 'user', agentMeta: null });
    expect((await get()).actions).toEqual([]);
    h.rows.shift();
    h.running = true;
    expect((await get()).actions).toEqual([]);
  });
  it.each([{ source: 'chat' }, { remoteHostId: 'ssh' }, { status: 'archived' }])(
    'rejects a nonlocal or inactive Make task: %s',
    async (change) => {
      Object.assign(h.session, change);
      await expect(get()).rejects.toThrow('unavailable');
      expect(h.test).not.toHaveBeenCalled();
    },
  );
  it('rechecks identity after an asynchronous account switch before taking any action', async () => {
    h.beforeRead.mockImplementationOnce(async () => {
      h.owner += 1;
    });
    await expect(invoke('test:done:start')).rejects.toThrow('unavailable');
    expect(h.test).not.toHaveBeenCalled();
  });
  it('checks the action again if the desktop advances during the second load', async () => {
    let reads = 0;
    h.beforeRead.mockImplementation(async (sessionTable) => {
      if (sessionTable && ++reads === 2) h.rows = [completion(2)];
    });
    await expect(invoke('test:done:start')).rejects.toThrow('unavailable');
    expect(h.test.mock.calls.every((call) => call[2] === 'status')).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('offers retry for saved preparation failures through the normal preparation flow', async () => {
    h.session.lastTurnEndedAt = null;
    h.rows = [];
    h.prep = {
      runId: 'run',
      platform: 'win32',
      arch: 'x64',
      status: 'failed',
      checks: [],
      task: { sessionId: 'task', phase: 'dependencies' },
    };
    expect((await get()).actions?.[0].id).toBe('prepare:run:retry');
    h.history.mockResolvedValue({
      items: [
        {
          runId: 'run',
          sessionId: 'task',
          request: 'original request',
          title: 'Original task',
          actions: ['retry-prepare'],
        },
      ],
    });
    await invoke('prepare:run:retry');
    expect(h.start).toHaveBeenCalledWith(
      {
        runId: 'run',
        request: 'original request',
        title: 'Original task',
      },
      0,
    );
    h.history.mockImplementationOnce(async () => {
      h.owner += 1;
      return { items: [] };
    });
    await expect(invoke('prepare:run:retry')).rejects.toThrow('unavailable');
    expect(h.start).toHaveBeenCalledOnce();
  });
});
