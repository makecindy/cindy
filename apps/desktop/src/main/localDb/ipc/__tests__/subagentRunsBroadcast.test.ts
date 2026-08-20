import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const trusted = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
  const navigated = {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
  const destroyed = {
    isDestroyed: vi.fn(() => true),
    webContents: { send: vi.fn() },
  };
  return {
    trusted,
    navigated,
    destroyed,
    ipcHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
    getSubagentRunDetail: vi.fn(),
    listSubagentRuns: vi.fn(),
    readPiSubagentTranscriptPage: vi.fn(),
    listPiSubagentRunDiagnostics: vi.fn(),
    listPiSubagentRuns: vi.fn(),
    persistSubagentTaskUpdate: vi.fn(),
    scopeCurrent: true,
    activeStamp: { dataOwnerId: 'active-owner', ownerGeneration: 2 },
    deviceLinkInvoke: false,
    ownerScopeKey: 'owner-a:1',
  };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/user-data') },
  BrowserWindow: {
    getAllWindows: () => [h.trusted, h.navigated, h.destroyed],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      h.ipcHandlers.set(channel, handler);
    }),
  },
}));
vi.mock('@cindy/maker-core/pi-subagent-runs', () => ({
  isPiSubagentTerminal: (state: string) => ['completed', 'failed', 'stopped'].includes(state),
  listPiSubagentRunDiagnostics: h.listPiSubagentRunDiagnostics,
  listPiSubagentRuns: h.listPiSubagentRuns,
  piSubagentRunRoot: (agentHome: string, sessionId: string) => `${agentHome}/runtime/pi-subagent-runs/${sessionId}`,
  readPiSubagentTranscriptPage: h.readPiSubagentTranscriptPage,
}));
vi.mock('../../../appSessionState.js', () => ({
  getActiveDataOwnerPushStamp: () => h.activeStamp,
  activeOwnerScopeKey: () => h.ownerScopeKey,
}));
vi.mock('../../../device-link/invoke-context.js', () => ({
  isDeviceLinkInvoke: () => h.deviceLinkInvoke,
}));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  isDataOwnerBroadcastScopeCurrent: () => h.scopeCurrent,
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: (window: unknown) => window === h.trusted,
}));
vi.mock('../../client/current.js', () => ({
  getDbClient: vi.fn(),
}));
vi.mock('../../subagentRuns.js', () => ({
  getSubagentRunDetail: h.getSubagentRunDetail,
  listSubagentRuns: h.listSubagentRuns,
  persistSubagentTaskUpdate: h.persistSubagentTaskUpdate,
}));

import { SUBAGENT_RUNS_CHANGED_CHANNEL } from '@cindy/maker-shared/subagent-workspace';
import {
  __resetSubagentReconcileFingerprintsForTests,
  broadcastSubagentRunsChanged,
  broadcastSubagentRunsInvalidated,
  registerSubagentRunsIpc,
} from '../subagentRuns.js';

describe('Subagent runs broadcast boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.ipcHandlers.clear();
    h.getSubagentRunDetail.mockResolvedValue(null);
    h.listSubagentRuns.mockResolvedValue({ runs: [] });
    h.readPiSubagentTranscriptPage.mockResolvedValue({ supported: true, entries: [] });
    h.listPiSubagentRunDiagnostics.mockResolvedValue([]);
    h.listPiSubagentRuns.mockResolvedValue([]);
    h.persistSubagentTaskUpdate.mockResolvedValue(null);
    h.scopeCurrent = true;
    h.deviceLinkInvoke = false;
    h.ownerScopeKey = 'owner-a:1';
    __resetSubagentReconcileFingerprintsForTests();
  });

  it('serialises reconciliation writes onto the injected durable FIFO', async () => {
    // The agent event path writes this projection through the main durable FIFO.
    // Reconciliation used to call persistSubagentTaskUpdate directly, so the
    // first sighting of a run could be projected twice — both writers saw no
    // matching row, both inserted, and nothing in the schema stops a duplicate
    // at that visible generation.
    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let chain: Promise<unknown> = Promise.resolve();
    // A plain generic function, not vi.fn: the mock wrapper erases the generic
    // and no longer matches the injected queue's type.
    const enqueueDurableWrite = <T,>(label: string, fn: () => Promise<T> | T): Promise<T> => {
      order.push(label);
      const run = chain.then(async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        try {
          return await fn();
        } finally {
          inFlight -= 1;
        }
      });
      chain = run.catch(() => undefined);
      return run as Promise<T>;
    };
    // Yield inside the write so an unserialised caller would interleave.
    h.persistSubagentTaskUpdate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return null;
    });
    registerSubagentRunsIpc({ enqueueDurableWrite });
    const list = h.ipcHandlers.get('local-db:subagent-runs:list')!;
    const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
    h.listPiSubagentRuns.mockResolvedValue([{
      version: 1, runId: '123e4567-e89b-42d3-a456-426614174000', taskId: 'parent-tool',
      parentSessionId: 'session-1', runnerInstanceId: 'runner-1', state: 'running',
      context: 'fresh', title: 'Live run', startedAt: 1_000, updatedAt: 2_000,
      tasks: [{
        childId: 'child-1', sessionId: 'session-child', agent: 'worker', status: 'running',
      }],
    }]);

    // A list and a detail reconciling the same first-seen run concurrently.
    await Promise.all([
      list({}, { sessionId: 'session-1' }),
      detail({}, { sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool' }),
    ]);

    // Every projection write went through the queue, and none overlapped.
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((label) => label.startsWith('subagent_reconcile:session-1:'))).toBe(true);
    expect(maxConcurrent).toBe(1);
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledTimes(order.length);
  });

  it('groups a resumed child with its earlier generations by PI session', async () => {
    // A resume mints `<newRunId>-<n>` for every task it carries over, so one
    // logical child is labelled with a different id per generation and the
    // panel filtered its own history back out of the aggregated transcript.
    // The PI session is the one thing resume deliberately keeps — `sessionDir`
    // and `sessionId` still point at the previous generation — so that is what
    // the chain is recovered from. Order position cannot be used: resuming a
    // single child of a parallel run re-indexes it to 1.
    registerSubagentRunsIpc();
    const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
    h.getSubagentRunDetail.mockResolvedValue({
      id: 'run-2',
      logicalAgentId: 'parent-tool',
      provider: 'pi',
      status: 'completed',
      providerRunIds: [
        '123e4567-e89b-42d3-a456-426614174080',
        '123e4567-e89b-42d3-a456-426614174081',
      ],
      capabilities: { viewFullTranscript: true },
    });
    const generation = (runId: string, childSuffix: string) => ({
      version: 1, runId, taskId: 'parent-tool', parentSessionId: 'session-1',
      runnerInstanceId: `runner-${childSuffix}`, state: 'completed',
      startedAt: 1_000, updatedAt: 2_000,
      tasks: [
        { childId: `${runId}-1`, sessionId: 'pi-session-scout', agent: 'scout', status: 'completed' },
        { childId: `${runId}-2`, sessionId: 'pi-session-reviewer', agent: 'reviewer', status: 'completed' },
      ],
    });
    // Newest first, the order the detail projection already picks from.
    h.listPiSubagentRuns.mockResolvedValue([
      generation('123e4567-e89b-42d3-a456-426614174081', 'b'),
      generation('123e4567-e89b-42d3-a456-426614174080', 'a'),
    ]);

    const response = await detail({}, {
      sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool',
    }) as { run: { children: Array<{ id: string; identityAliases?: string[] }> } };

    expect(response.run.children.map((child) => ({
      id: child.id, identityAliases: child.identityAliases,
    }))).toEqual([
      {
        id: '123e4567-e89b-42d3-a456-426614174081-1',
        identityAliases: ['123e4567-e89b-42d3-a456-426614174080-1'],
      },
      {
        id: '123e4567-e89b-42d3-a456-426614174081-2',
        identityAliases: ['123e4567-e89b-42d3-a456-426614174080-2'],
      },
    ]);
  });

  it('leaves a child that has only ever had one id without aliases', async () => {
    registerSubagentRunsIpc();
    const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
    h.getSubagentRunDetail.mockResolvedValue({
      id: 'run-1',
      logicalAgentId: 'parent-tool',
      provider: 'pi',
      status: 'completed',
      providerRunIds: ['123e4567-e89b-42d3-a456-426614174082'],
      capabilities: { viewFullTranscript: true },
    });
    h.listPiSubagentRuns.mockResolvedValue([{
      version: 1, runId: '123e4567-e89b-42d3-a456-426614174082', taskId: 'parent-tool',
      parentSessionId: 'session-1', runnerInstanceId: 'runner-1', state: 'completed',
      startedAt: 1_000, updatedAt: 2_000,
      tasks: [{ childId: 'only-child', sessionId: 'pi-session-1', agent: 'scout', status: 'completed' }],
    }]);

    const response = await detail({}, {
      sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool',
    }) as { run: { children: Array<{ id: string; identityAliases?: string[] }> } };

    expect(response.run.children).toHaveLength(1);
    expect(response.run.children[0]!.identityAliases).toBeUndefined();
  });

  /**
   * Reconciliation picks the newest generation across the healthy and the
   * unreadable sets, so a resume whose durable state went stale/corrupt makes
   * the row fail. The detail projection re-read `listPiSubagentRuns` — which
   * only ever returns readable generations — and its `find` landed on the
   * previous one, painting last run's completed children and output back over
   * the failed row.
   */
  describe('detail projection generation recency', () => {
    const olderHealthyGeneration = {
      version: 1,
      runId: '123e4567-e89b-42d3-a456-426614174090',
      taskId: 'parent-tool',
      parentSessionId: 'session-1',
      runnerInstanceId: 'runner-old',
      state: 'completed',
      context: 'fresh',
      title: 'Older healthy generation',
      startedAt: 1_000,
      updatedAt: 2_000,
      endedAt: 2_000,
      tasks: [{
        childId: 'child-1',
        sessionId: 'pi-session-1',
        agent: 'worker',
        status: 'completed',
        output: 'previous generation answer',
      }],
    };
    const crashedNewerGeneration = {
      kind: 'stale' as const,
      runId: '123e4567-e89b-42d3-a456-426614174091',
      taskId: 'parent-tool',
      parentSessionId: 'session-1',
      title: 'Crashed resume',
      startedAt: 3_000,
      updatedAt: 4_000,
      message: 'runner stopped unexpectedly',
    };
    /** The row exactly as reconciliation leaves it for each case. */
    const detailRow = (overrides: Record<string, unknown>) => ({
      id: 'run-1',
      logicalAgentId: 'parent-tool',
      provider: 'pi',
      providerRunIds: ['123e4567-e89b-42d3-a456-426614174090'],
      capabilities: { viewFullTranscript: true },
      ...overrides,
    });

    it('does not present a superseded generation as the crashed run result', async () => {
      registerSubagentRunsIpc();
      const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
      // Written by the diagnostic path: failed, carrying the diagnostic
      // message — and still holding the result an earlier generation returned,
      // which the row keeps on purpose.
      h.getSubagentRunDetail.mockResolvedValue(detailRow({
        status: 'failed',
        summary: 'runner stopped unexpectedly',
        returnedResult: 'previous generation answer',
        returnedResultTruncated: true,
      }));
      h.listPiSubagentRuns.mockResolvedValue([olderHealthyGeneration]);
      h.listPiSubagentRunDiagnostics.mockResolvedValue([crashedNewerGeneration]);

      const response = await detail({}, {
        sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool',
      }) as { run: Record<string, unknown> };

      // Nothing from the superseded generation reaches the view: no completed
      // children, no result body, and no stale truncation flag implying one.
      expect(response.run.children).toBeUndefined();
      expect('returnedResult' in response.run).toBe(false);
      expect('returnedResultTruncated' in response.run).toBe(false);
      expect(JSON.stringify(response.run)).not.toContain('previous generation answer');
      // What is left is the diagnostic the row already records.
      expect(response.run.status).toBe('failed');
      expect(response.run.summary).toBe('runner stopped unexpectedly');
    });

    it('still projects the newest generation when no diagnostic supersedes it', async () => {
      registerSubagentRunsIpc();
      const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
      h.getSubagentRunDetail.mockResolvedValue(detailRow({
        status: 'completed',
        returnedResult: 'previous generation answer',
      }));
      h.listPiSubagentRuns.mockResolvedValue([olderHealthyGeneration]);
      h.listPiSubagentRunDiagnostics.mockResolvedValue([]);

      const response = await detail({}, {
        sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool',
      }) as { run: { children: Array<{ output?: string }>; returnedResult?: string } };

      expect(response.run.children.map((child) => child.output))
        .toEqual(['previous generation answer']);
      expect(response.run.returnedResult).toBe('previous generation answer');
    });

    it('still projects a healthy generation newer than every diagnostic', async () => {
      registerSubagentRunsIpc();
      const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
      h.getSubagentRunDetail.mockResolvedValue(detailRow({
        status: 'completed',
        returnedResult: 'resumed answer',
        providerRunIds: ['123e4567-e89b-42d3-a456-426614174092'],
      }));
      h.listPiSubagentRuns.mockResolvedValue([{
        ...olderHealthyGeneration,
        runId: '123e4567-e89b-42d3-a456-426614174092',
        title: 'Newer healthy generation',
        startedAt: 5_000,
        updatedAt: 6_000,
        endedAt: 6_000,
        tasks: [{ ...olderHealthyGeneration.tasks[0]!, output: 'resumed answer' }],
      }]);
      // The crash is the *older* generation now: it must not blank the resume.
      h.listPiSubagentRunDiagnostics.mockResolvedValue([{
        ...crashedNewerGeneration,
        startedAt: 1_000,
        updatedAt: 2_000,
      }]);

      const response = await detail({}, {
        sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool',
      }) as { run: { children: Array<{ output?: string }>; returnedResult?: string } };

      expect(response.run.children.map((child) => child.output)).toEqual(['resumed answer']);
      expect(response.run.returnedResult).toBe('resumed answer');
    });
  });

  /**
   * `resume` only works while the parent task is a loaded PI session — the
   * control handler resolves `maker.getSession(sessionId)` and refuses
   * otherwise. Browsing a finished run after a restart never loads it, so the
   * stored `resume: true` was offering a follow-up composer whose every send
   * was guaranteed to fail.
   */
  describe('resume capability masking', () => {
    const finished = {
      id: 'run-1',
      logicalAgentId: 'parent-tool',
      provider: 'pi' as const,
      status: 'completed' as const,
      providerRunIds: ['run-1'],
      capabilities: { viewActivity: true, viewFullTranscript: true, resume: true, steer: false, stop: false },
    };

    it('hides resume while the parent task is not a live PI session', async () => {
      registerSubagentRunsIpc({ isParentPiSessionLive: () => false });
      const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
      const list = h.ipcHandlers.get('local-db:subagent-runs:list')!;
      h.listPiSubagentRuns.mockResolvedValue([]);
      h.listPiSubagentRunDiagnostics.mockResolvedValue([]);
      h.getSubagentRunDetail.mockResolvedValue({ ...finished });
      h.listSubagentRuns.mockResolvedValue({ runs: [{ ...finished }], nextCursor: null });

      const detailResponse = await detail({}, {
        sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool',
      }) as { run: { capabilities: { resume: boolean; viewFullTranscript: boolean } } };
      expect(detailResponse.run.capabilities.resume).toBe(false);
      // Only that one capability is masked; the rest of the row is untouched.
      expect(detailResponse.run.capabilities.viewFullTranscript).toBe(true);

      const listResponse = await list({}, { sessionId: 'session-1' }) as {
        runs: Array<{ capabilities: { resume: boolean } }>;
      };
      expect(listResponse.runs[0]?.capabilities.resume).toBe(false);
    });

    it('offers resume again once the task is loaded', async () => {
      // The detail poll re-reads capabilities, so opening the task restores it
      // without anything being rewritten in the database.
      registerSubagentRunsIpc({ isParentPiSessionLive: () => true });
      const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
      h.listPiSubagentRuns.mockResolvedValue([]);
      h.listPiSubagentRunDiagnostics.mockResolvedValue([]);
      h.getSubagentRunDetail.mockResolvedValue({ ...finished });

      const response = await detail({}, {
        sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool',
      }) as { run: { capabilities: { resume: boolean } } };
      expect(response.run.capabilities.resume).toBe(true);
    });

    it('applies the same judgement to a device-link read', async () => {
      // Remote detail goes through this very handler, so there is no second
      // assembly path that could still advertise it.
      h.deviceLinkInvoke = true;
      registerSubagentRunsIpc({ isParentPiSessionLive: () => false });
      const detail = h.ipcHandlers.get('local-db:subagent-runs:detail')!;
      h.listPiSubagentRuns.mockResolvedValue([]);
      h.listPiSubagentRunDiagnostics.mockResolvedValue([]);
      h.getSubagentRunDetail.mockResolvedValue({ ...finished });

      const response = await detail({}, {
        sessionId: 'session-1', provider: 'pi', runIdOrAlias: 'parent-tool',
      }) as { run: { capabilities: { resume: boolean } } };
      expect(response.run.capabilities.resume).toBe(false);
    });
  });

  it('retries a projection the parent had not become visible for yet', async () => {
    // A fast run reaches a terminal state before its parent tool_use has left
    // the durable-write FIFO, so `persistSubagentTaskUpdate` refuses with null —
    // no row written. Memoising that refusal was permanent for exactly the
    // records it hurt most: a terminal status never changes again, so its
    // fingerprint never changes either and every later reconciliation skipped
    // the write. The Subagent stayed out of the sidebar until the process-level
    // cache was evicted.
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list')!;
    const finished = {
      version: 1, runId: '123e4567-e89b-42d3-a456-4266141740bb', taskId: 'fast-tool',
      parentSessionId: 'session-1', runnerInstanceId: 'runner-1', state: 'completed',
      context: 'fresh', title: 'Fast run', startedAt: 1_000, updatedAt: 2_000,
      endedAt: 2_000,
      tasks: [{
        childId: 'child-1', sessionId: 'session-child', agent: 'worker',
        status: 'completed', output: 'the answer',
      }],
    };
    h.listPiSubagentRuns.mockResolvedValue([finished]);
    h.listPiSubagentRunDiagnostics.mockResolvedValue([]);

    // 1. Parent not visible yet: refused, nothing written.
    h.persistSubagentTaskUpdate.mockResolvedValue(null);
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalled();

    // 2. Parent is visible now, and the run's state is byte-identical — which
    // is the whole problem: only a memo of the refusal could suppress this.
    h.persistSubagentTaskUpdate.mockClear();
    h.persistSubagentTaskUpdate.mockResolvedValue({
      runId: 'row-1', created: true, firstForSession: true,
    });
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1', expect.objectContaining({ status: 'completed', taskId: 'fast-tool' }), 'pi', 2_000,
    );

    // 3. And the memo still does its job once a row exists: no repeat write for
    // an unchanged record.
    h.persistSubagentTaskUpdate.mockClear();
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).not.toHaveBeenCalled();
  });

  it('does not close a row when status.json is only unreadable', async () => {
    // Unreadable is not death. Writing `failed` stripped the active-run
    // visibility exemption so a /clear or rewind boundary then hid the row
    // permanently while the runner kept spending credentials.
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list')!;
    const healthy = {
      version: 1, runId: '123e4567-e89b-42d3-a456-4266141740aa', taskId: 'parent-tool',
      parentSessionId: 'session-1', runnerInstanceId: 'runner-1', state: 'running',
      context: 'fresh', title: 'Live run', startedAt: 1_000, updatedAt: 2_000,
      tasks: [{
        childId: 'child-1', sessionId: 'session-child', agent: 'worker',
        status: 'running',
      }],
    };

    h.persistSubagentTaskUpdate.mockResolvedValue({
      runId: 'row-1', created: true, firstForSession: true,
    });
    h.listPiSubagentRuns.mockResolvedValue([healthy]);
    h.listPiSubagentRunDiagnostics.mockResolvedValue([]);
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1', expect.objectContaining({ status: 'running' }), 'pi', 2_000,
    );

    h.persistSubagentTaskUpdate.mockClear();
    h.listPiSubagentRuns.mockResolvedValue([]);
    h.listPiSubagentRunDiagnostics.mockResolvedValue([{
      kind: 'corrupt', runId: healthy.runId, taskId: 'parent-tool',
      parentSessionId: 'session-1', title: 'Live run',
      startedAt: 1_000, updatedAt: 3_000, message: 'status is unreadable',
    }]);
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).not.toHaveBeenCalled();
  });

  it('recovers the row after one transient unreadable status', async () => {
    // A terminal record is reconciled, then the same generation becomes briefly
    // unreadable. Corrupt diagnostics must not write `failed`; the completed
    // projection stays put and is still there when the file reads again.
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list')!;
    const healthy = {
      version: 1, runId: '123e4567-e89b-42d3-a456-4266141740aa', taskId: 'parent-tool',
      parentSessionId: 'session-1', runnerInstanceId: 'runner-1', state: 'completed',
      context: 'fresh', title: 'Finished run', startedAt: 1_000, updatedAt: 2_000,
      endedAt: 2_000,
      tasks: [{
        childId: 'child-1', sessionId: 'session-child', agent: 'worker',
        status: 'completed', output: 'the answer',
      }],
    };

    h.persistSubagentTaskUpdate.mockResolvedValue({
      runId: 'row-1', created: true, firstForSession: true,
    });
    h.listPiSubagentRuns.mockResolvedValue([healthy]);
    h.listPiSubagentRunDiagnostics.mockResolvedValue([]);
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1', expect.objectContaining({ status: 'completed' }), 'pi', 2_000,
    );

    h.persistSubagentTaskUpdate.mockClear();
    h.listPiSubagentRuns.mockResolvedValue([]);
    h.listPiSubagentRunDiagnostics.mockResolvedValue([{
      kind: 'corrupt', runId: healthy.runId, taskId: 'parent-tool',
      parentSessionId: 'session-1', title: 'Finished run',
      startedAt: 1_000, updatedAt: 3_000, message: 'status is unreadable',
    }]);
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).not.toHaveBeenCalled();

    h.persistSubagentTaskUpdate.mockClear();
    h.listPiSubagentRuns.mockResolvedValue([healthy]);
    h.listPiSubagentRunDiagnostics.mockResolvedValue([]);
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).not.toHaveBeenCalled();
  });

  it('prefers the newest generation when health and diagnostics disagree', async () => {
    // The healthy and unreadable sets are walked separately. Walking health
    // first and dropping any diagnostic for a task already seen showed last
    // run's completed result while this run's crash stayed hidden.
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list')!;
    const healthy = {
      version: 1, runId: '123e4567-e89b-42d3-a456-426614174000', taskId: 'parent-tool',
      parentSessionId: 'session-1', runnerInstanceId: 'runner-1', state: 'completed',
      context: 'fresh', title: 'Older healthy generation', startedAt: 1_000, updatedAt: 2_000,
      endedAt: 2_000,
      tasks: [{
        childId: 'child-1', sessionId: 'session-child', agent: 'worker',
        status: 'completed', output: 'previous result',
      }],
    };
    h.listPiSubagentRuns.mockResolvedValue([healthy]);
    // A *newer* generation is unreadable: this run crashed.
    h.listPiSubagentRunDiagnostics.mockResolvedValue([{
      kind: 'stale', runId: '123e4567-e89b-42d3-a456-426614174001', taskId: 'parent-tool',
      parentSessionId: 'session-1', title: 'Crashed resume',
      startedAt: 3_000, updatedAt: 4_000, message: 'runner stopped unexpectedly',
    }]);

    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledOnce();
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        taskId: 'parent-tool',
        taskType: 'pi_subagent_diagnostic',
        summary: 'runner stopped unexpectedly',
      }),
      'pi',
      4_000,
    );

    // The mirror case: an older diagnostic must not shout down a newer healthy
    // generation.
    __resetSubagentReconcileFingerprintsForTests();
    h.persistSubagentTaskUpdate.mockClear();
    h.listPiSubagentRuns.mockResolvedValue([{
      ...healthy, runId: '123e4567-e89b-42d3-a456-426614174002',
      title: 'Newer healthy generation', startedAt: 5_000, updatedAt: 6_000, endedAt: 6_000,
    }]);

    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledOnce();
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ taskId: 'parent-tool', taskType: 'pi_subagent' }),
      'pi',
      6_000,
    );
  });

  it('skips reconciliation writes while durable state is unchanged', async () => {
    // The remote detail view polls list + detail once a second and both
    // reconcile, so every readable run used to re-write its alias rows and main
    // row ~2N times a second for nothing — and several controllers multiplied
    // that into write-lock contention.
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list')!;
    const status = {
      version: 1, runId: '123e4567-e89b-42d3-a456-426614174000', taskId: 'parent-tool',
      parentSessionId: 'session-1', runnerInstanceId: 'runner-1', state: 'completed',
      context: 'fresh', title: 'Finished run', startedAt: 1_000, updatedAt: 2_000,
      endedAt: 2_000, totalTokens: 5, toolUses: 1,
      tasks: [{
        childId: 'child-1', sessionId: 'session-child', agent: 'worker',
        status: 'completed', output: 'first result',
      }],
    };
    h.listPiSubagentRuns.mockResolvedValue([status]);
    // A memo is only earned by a projection that actually wrote a row; the
    // suite's default mock refuses (null), which is now correctly retried.
    h.persistSubagentTaskUpdate.mockResolvedValue({
      runId: 'row-1', created: true, firstForSession: true,
    });

    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledOnce();

    // Same durable state, three more polls: nothing to write.
    await list({}, { sessionId: 'session-1' });
    await list({}, { sessionId: 'session-1' });
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledOnce();

    // A late backfill of truncated output is a real change and must still land,
    // which is why the fingerprint covers the rendered payload rather than just
    // `updatedAt`.
    h.listPiSubagentRuns.mockResolvedValue([{
      ...status,
      tasks: [{ ...status.tasks[0], output: 'first result, now complete' }],
    }]);
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledTimes(2);
    expect(h.persistSubagentTaskUpdate).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({ returnedResult: 'first result, now complete' }),
      'pi',
      2_000,
    );

    // An account boundary invalidates the cache: the first write into the
    // replaced database must never be suppressed.
    h.ownerScopeKey = 'owner-b:1';
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledTimes(3);
  });

  it('sends only to a currently trusted Cindy renderer window', () => {
    const payload = {
      sessionId: 'session-1',
      runId: 'run-1',
      created: true,
      firstForSession: true,
    };

    broadcastSubagentRunsChanged(payload);

    expect(h.trusted.webContents.send).toHaveBeenCalledWith(
      SUBAGENT_RUNS_CHANGED_CHANNEL,
      payload,
      h.activeStamp,
    );
    expect(h.navigated.webContents.send).not.toHaveBeenCalled();
    expect(h.destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it('drops a late old-owner broadcast instead of relabeling it', () => {
    h.scopeCurrent = false;

    broadcastSubagentRunsChanged(
      { sessionId: 'session-1', runId: 'run-1', created: false, firstForSession: false },
      {
        ownerScopeKey: 'old-owner',
        ownerStamp: { dataOwnerId: 'old-owner', ownerGeneration: 1 },
      },
    );

    expect(h.trusted.webContents.send).not.toHaveBeenCalled();
  });

  it('uses the captured owner stamp when the scope is still current', () => {
    const captured = { dataOwnerId: 'captured-owner', ownerGeneration: 7 };
    const payload = {
      sessionId: 'session-1',
      runId: 'run-1',
      created: false,
      firstForSession: false,
    };

    broadcastSubagentRunsChanged(payload, {
      ownerScopeKey: 'captured-owner',
      ownerStamp: captured,
    });

    expect(h.trusted.webContents.send).toHaveBeenCalledWith(
      SUBAGENT_RUNS_CHANGED_CHANNEL,
      payload,
      captured,
    );
  });

  it('broadcasts a session-level invalidation for clear and rewind boundaries', () => {
    broadcastSubagentRunsInvalidated('session-1');

    expect(h.trusted.webContents.send).toHaveBeenCalledWith(
      SUBAGENT_RUNS_CHANGED_CHANNEL,
      {
        sessionId: 'session-1',
        runId: null,
        created: false,
        firstForSession: false,
      },
      h.activeStamp,
    );
  });

  it('reconciles a detached PI status before returning the Fleet list', async () => {
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list');
    if (!list) throw new Error('Subagent list handler not registered');
    h.listPiSubagentRuns.mockResolvedValue([{
      version: 1,
      runId: '123e4567-e89b-42d3-a456-426614174000',
      runnerInstanceId: 'runner-1',
      taskId: 'parent-tool',
      parentSessionId: 'session-1',
      state: 'completed',
      mode: 'single',
      context: 'fresh',
      title: 'Recovered run',
      description: 'Survives parent unload',
      startedAt: 1_000,
      updatedAt: 2_000,
      endedAt: 2_000,
      totalTokens: 5,
      toolUses: 1,
      usage: { input: 2, output: 3, cost: 0.01 },
      tasks: [{
        childId: 'child-1', sessionId: 'session-child', agent: 'worker',
        status: 'completed', output: 'recovered result', model: 'fixture-model', thinking: 'high',
      }],
    }]);
    await list({}, { sessionId: 'session-1' });
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        taskId: 'parent-tool',
        status: 'completed',
        returnedResult: 'recovered result',
        createdAt: new Date(1_000).toISOString(),
      }),
      'pi',
      2_000,
    );
    expect(h.listSubagentRuns).toHaveBeenCalledWith('session-1', { cursor: undefined, limit: undefined });
  });

  it('projects the runner launch queue as a running product record', async () => {
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list');
    if (!list) throw new Error('Subagent list handler not registered');
    h.listPiSubagentRuns.mockResolvedValue([{
      version: 1,
      runId: '123e4567-e89b-42d3-a456-426614174001',
      runnerInstanceId: 'launch-pending-1',
      taskId: 'queued-parent-tool',
      parentSessionId: 'session-1',
      state: 'queued',
      startedAt: 1_000,
      updatedAt: 1_000,
      tasks: [{
        childId: 'queued-child', sessionId: 'queued-session', agent: 'worker', status: 'queued',
      }],
    }]);

    await list({}, { sessionId: 'session-1' });

    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ taskId: 'queued-parent-tool', status: 'running' }),
      'pi',
      1_000,
    );
  });

  it('keeps PI diagnostics inside their parent message generation', async () => {
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list');
    if (!list) throw new Error('Subagent list handler not registered');
    h.listPiSubagentRunDiagnostics.mockResolvedValue([
      {
        kind: 'stale',
        runId: '123e4567-e89b-42d3-a456-426614174010',
        taskId: 'parent-tool',
        parentSessionId: 'session-1',
        startedAt: 1_000,
        updatedAt: 2_000,
        message: 'runner stopped',
      },
      {
        kind: 'corrupt',
        runId: '123e4567-e89b-42d3-a456-426614174011',
        parentSessionId: 'session-1',
        startedAt: 1_000,
        updatedAt: 2_000,
        message: 'missing parent identity',
      },
    ]);

    await list({}, { sessionId: 'session-1' });

    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledOnce();
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        taskId: 'parent-tool',
        parentToolUseId: 'parent-tool',
        taskType: 'pi_subagent_diagnostic',
        subagentObservation: expect.objectContaining({
          parentToolUseId: 'parent-tool',
        }),
      }),
      'pi',
      2_000,
    );
  });

  it('does not let an older diagnostic overwrite a healthy resumed generation', async () => {
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list');
    if (!list) throw new Error('Subagent list handler not registered');
    h.listPiSubagentRuns.mockResolvedValue([{
      version: 1,
      runId: '123e4567-e89b-42d3-a456-426614174020',
      runnerInstanceId: 'runner-current',
      taskId: 'resumed-parent-tool',
      parentSessionId: 'session-1',
      state: 'running',
      startedAt: 3_000,
      updatedAt: 4_000,
      tasks: [{
        childId: 'current-child', sessionId: 'resumed-session', agent: 'worker', status: 'running',
      }],
    }]);
    h.listPiSubagentRunDiagnostics.mockResolvedValue([{
      kind: 'corrupt',
      runId: '123e4567-e89b-42d3-a456-426614174019',
      taskId: 'resumed-parent-tool',
      parentSessionId: 'session-1',
      startedAt: 1_000,
      updatedAt: 2_000,
      message: 'older generation is corrupt',
    }]);

    await list({}, { sessionId: 'session-1' });

    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledOnce();
    expect(h.persistSubagentTaskUpdate).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        taskId: 'resumed-parent-tool',
        taskType: 'pi_subagent',
        status: 'running',
      }),
      'pi',
      4_000,
    );
  });

  it('reads a PI transcript across every durable generation, oldest first', async () => {
    // `providerRunIds` is the run's generations in the order they happened, with
    // child ids mixed in. Passing only the newest — the previous behaviour —
    // dropped the original task and everything before the last follow-up.
    registerSubagentRunsIpc();
    const transcript = h.ipcHandlers.get('local-db:subagent-runs:transcript');
    if (!transcript) throw new Error('Subagent transcript handler not registered');
    h.getSubagentRunDetail.mockResolvedValue({
      provider: 'pi',
      providerRunIds: [
        '123e4567-e89b-42d3-a456-426614174000',
        'child-not-a-run-directory',
        '123e4567-e89b-42d3-a456-426614174001',
      ],
      capabilities: { viewFullTranscript: true },
    });
    await expect(transcript({}, {
      sessionId: 'session-1',
      provider: 'pi',
      runIdOrAlias: 'run-1',
      limit: 25,
    })).resolves.toEqual({ supported: true, entries: [] });
    expect(h.readPiSubagentTranscriptPage).toHaveBeenCalledWith(
      '/user-data/pi-agent-home/runtime/pi-subagent-runs/session-1',
      [
        '123e4567-e89b-42d3-a456-426614174000',
        '123e4567-e89b-42d3-a456-426614174001',
      ],
      { cursor: undefined, limit: 25 },
    );
  });

  it('limits device-link reads to PI before querying durable records', async () => {
    h.deviceLinkInvoke = true;
    registerSubagentRunsIpc();
    const list = h.ipcHandlers.get('local-db:subagent-runs:list');
    const detail = h.ipcHandlers.get('local-db:subagent-runs:detail');
    const transcript = h.ipcHandlers.get('local-db:subagent-runs:transcript');
    if (!list || !detail || !transcript) throw new Error('Subagent handlers not registered');

    await list({}, { sessionId: 'session-1' });
    expect(h.listSubagentRuns).toHaveBeenCalledWith('session-1', {
      cursor: undefined,
      limit: undefined,
      provider: 'pi',
    });
    await expect(detail({}, {
      sessionId: 'session-1', provider: 'codex', runIdOrAlias: 'native-id',
    })).resolves.toEqual({ supported: false, run: null });
    await expect(transcript({}, {
      sessionId: 'session-1', provider: 'claude-code', runIdOrAlias: 'native-id',
    })).resolves.toEqual({ supported: false, entries: [] });
    expect(h.getSubagentRunDetail).not.toHaveBeenCalled();
  });

  it('validates and forwards provider-scoped detail lookups', async () => {
    registerSubagentRunsIpc();
    const detail = h.ipcHandlers.get('local-db:subagent-runs:detail');
    if (!detail) throw new Error('Subagent detail handler not registered');

    await expect(
      detail({}, {
        sessionId: 'session-1',
        provider: 'codex',
        runIdOrAlias: 'shared-native-id',
      }),
    ).resolves.toEqual({ supported: true, run: null });
    expect(h.getSubagentRunDetail).toHaveBeenCalledWith(
      'session-1',
      'codex',
      'shared-native-id',
    );

    await expect(
      detail({}, {
        sessionId: 'session-1',
        provider: 'other-harness',
        runIdOrAlias: 'shared-native-id',
      }),
    ).rejects.toThrow(/provider/);
  });
});
