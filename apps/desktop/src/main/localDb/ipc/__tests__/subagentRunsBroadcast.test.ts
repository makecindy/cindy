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

  it('reads a PI transcript only through a durable native run id', async () => {
    registerSubagentRunsIpc();
    const transcript = h.ipcHandlers.get('local-db:subagent-runs:transcript');
    if (!transcript) throw new Error('Subagent transcript handler not registered');
    h.getSubagentRunDetail.mockResolvedValue({
      provider: 'pi',
      providerRunIds: [
        '123e4567-e89b-42d3-a456-426614174000',
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
      '123e4567-e89b-42d3-a456-426614174001',
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
