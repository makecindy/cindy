import type { SessionSendResult } from '@cindy/maker-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  userDataDir: 'collab-send-outcome-test-user-data',
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
  collabService: null as null | {
    [key: string]: ReturnType<typeof vi.fn>;
  },
  capturedProvidersConfig: null as null | Record<string, unknown>,
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => mockState.userDataDir,
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mockState.logger,
}));

vi.mock('../../maker-ipc/register.js', () => ({
  tryGetOrcaCollabService: () => mockState.collabService,
}));

vi.mock('@cindy/mcps', () => ({
  createLiziMcpProviders: vi.fn((config: Record<string, unknown>) => {
    mockState.capturedProvidersConfig = config;
    return [
      {
        name: 'cindy_ios_simulator',
        isEnabled: () => true,
        toClaudeSdkConfig: () => null,
      },
      {
        name: 'cindy_orca',
        isEnabled: () => true,
        toClaudeSdkConfig: () => null,
      },
    ];
  }),
}));

vi.mock('../../maker-host/plugins/builtin-plugins.js', () => ({
  BUILTIN_LIZI_MCP_IDS: ['cindy_orca', 'cindy_helper'],
  pluginIdForProviderName: (name: string) =>
    name === 'cindy_orca'
      ? 'collab'
      : name === 'cindy_ios_simulator'
        ? 'ios-simulator'
        : name,
}));

vi.mock('../../maker-host/index.js', () => ({
  getPluginRegistry: () => ({
    isEnabled: () => true,
  }),
}));

vi.mock('../../scheduler-host/index.js', () => ({
  getScheduler: () => null,
}));

vi.mock('../../im/index.js', () => ({
  feishuIm: {
    sendFile: vi.fn(),
  },
}));

vi.mock('../cindyProxyMedia.js', () => ({
  getCindyProxyMediaService: () => ({ mcp: {} }),
}));

vi.mock('../../maker-host/session-search.js', () => ({
  searchSessionsFn: vi.fn(),
}));

vi.mock('../../maker-host/lsp-mode-store.js', () => ({
  readLspModeSettings: () => ({ enabled: true }),
}));

vi.mock('../../localDb/chatHistoryReader.js', () => ({
  listWorkdirsForHistory: vi.fn(),
  listSessionsForHistory: vi.fn(),
  getMessagesForHistory: vi.fn(),
}));

vi.mock('../../localDb/chatHistorySearch.js', () => ({
  searchChatHistoryHybrid: vi.fn(),
}));

import {
  logCollabDispatchFailure,
  resolveCollabDispatchResult,
} from '../../maker-ipc/collabSendOutcome.js';
import { createDesktopMcpProviders } from '../mcp-providers.js';

function collabMeta(overrides: Record<string, unknown> = {}) {
  return {
    source: 'maker-ipc/collab',
    context: 'enable_collab_mode/worker-session-1/delegate_task',
    ...overrides,
  };
}

function logMeta(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'orca-collab',
    entrypoint: 'enable_collab_mode',
    sessionId: 'worker-session-1',
    agentKind: 'codex',
    action: 'delegate_task',
    context: 'enable_collab_mode/worker-session-1/delegate_task',
    ...overrides,
  };
}

function createCollabService(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  return {
    startTeam: vi.fn(),
    createWorker: vi.fn(),
    listWorkers: vi.fn(),
    switchFocus: vi.fn(),
    sendToWorker: vi.fn(),
    idleWorker: vi.fn(),
    endTeam: vi.fn(),
    archiveWorker: vi.fn(),
    listAvailableModels: vi.fn(),
    getWorkspaceInfo: vi.fn(),
    getWorkerStatus: vi.fn(),
    readWorker: vi.fn(),
    listSessionQueue: vi.fn(),
    listSessionQueuedCounts: vi.fn(),
    updateSessionQueuedMessage: vi.fn(),
    cancelSessionQueuedMessage: vi.fn(),
    steerSession: vi.fn(),
    stopSessionTurn: vi.fn(),
    getSessionRuntime: vi.fn(),
    ...overrides,
  };
}

describe('collab send outcome semantics', () => {
  afterEach(() => {
    mockState.logger.warn.mockClear();
    mockState.logger.info.mockClear();
    mockState.logger.debug.mockClear();
    mockState.logger.error.mockClear();
    mockState.logger.trace.mockClear();
    mockState.logger.fatal.mockClear();
    mockState.collabService = null;
    mockState.capturedProvidersConfig = null;
    vi.clearAllMocks();
  });

  it('keeps cindy_orca registered when project policy is disabled at session startup', () => {
    const providers = createDesktopMcpProviders({
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => false } as never,
      resolveIOSSimulatorAccess: () => ({ allowed: true }),
      invokeRemote: vi.fn(),
    });
    const orcaProvider = providers.find((provider) => provider.name === 'cindy_orca');
    const iosSimulatorProvider = providers.find(
      (provider) => provider.name === 'cindy_ios_simulator',
    );

    expect(orcaProvider).toBeDefined();
    expect(
      orcaProvider?.isEnabled?.({
        agentKind: 'claude-code',
        workingDir: 'C:/projects/cindy',
      } as never),
    ).toBe(true);
    expect(
      iosSimulatorProvider?.isEnabled?.({
        agentKind: 'claude-code',
        workingDir: 'C:/projects/cindy',
      } as never),
    ).toBe(true);
  });

  it('reports enable_collab_mode delegate_task created-and-dispatched distinctly', async () => {
    const result = await resolveCollabDispatchResult(
      () => Promise.resolve({ accepted: true } satisfies SessionSendResult),
      collabMeta(),
    );

    expect(result).toEqual({
      dispatched: true,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'maker-ipc/collab',
        dispatched: true,
      },
    });
  });

  it('reports enable_collab_mode delegate_task created-but-not-dispatched distinctly', async () => {
    const result = await resolveCollabDispatchResult(
      () => Promise.resolve({ accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult),
      collabMeta(),
    );

    expect(result).toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'maker-ipc/collab',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
        context: 'enable_collab_mode/worker-session-1/delegate_task',
      },
    });
  });

  it('keeps createWorker initialTask accepted false out of running state', async () => {
    const result = await resolveCollabDispatchResult(
      () => Promise.resolve({ accepted: false, reason: 'cancelled-before-dispatch' } satisfies SessionSendResult),
      collabMeta({
        context: 'create_worker/worker-session-2/initial_task',
      }),
    );

    expect(result.dispatchOutcome).toMatchObject({
      kind: 'session-dispatch',
      dispatched: false,
      reason: 'cancelled-before-dispatch',
      context: 'create_worker/worker-session-2/initial_task',
    });
  });

  it('maps thrown send errors, SESSION_RUNNING, and onAccepted rejects to typed host outcomes', async () => {
    const sessionRunningError = new Error('SESSION_RUNNING: prompt text USER_MESSAGE TOKEN_VALUE file body') as Error & { code?: string };
    sessionRunningError.code = 'SESSION_RUNNING';
    const genericSendError = new Error('PROMPT_SECRET full user message TOKEN_VALUE file body');
    const onAcceptedReject = new Error('USER_MESSAGE token value file contents');

    await expect(resolveCollabDispatchResult(() => Promise.reject(sessionRunningError), collabMeta())).resolves.toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        accepted: false,
        code: 'SESSION_RUNNING',
      },
    });
    await expect(resolveCollabDispatchResult(() => Promise.reject(genericSendError), collabMeta())).resolves.toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        accepted: false,
        code: 'SEND_FAILED',
      },
    });
    const onAcceptedResult = await resolveCollabDispatchResult(() => Promise.reject(onAcceptedReject), collabMeta());
    expect(onAcceptedResult).toMatchObject({
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        accepted: false,
        code: 'SEND_FAILED',
      },
    });
  });

  it('logs required ownership fields without prompt text, full messages, tokens, or file contents', async () => {
    const err = new Error('PROMPT_SECRET full user message TOKEN_VALUE file body') as Error & { code?: string };
    err.code = 'SESSION_RUNNING';
    const result = await resolveCollabDispatchResult(() => Promise.reject(err), collabMeta());
    expect(result.dispatched).toBe(false);
    if (result.dispatched || result.queued) {
      throw new Error('expected dispatch failure');
    }

    logCollabDispatchFailure(
      mockState.logger,
      'enableOrca: delegateTask dispatch failed',
      logMeta(),
      result.dispatchOutcome,
      err,
    );

    expect(mockState.logger.warn).toHaveBeenCalledWith(
      'enableOrca: delegateTask dispatch failed',
      expect.objectContaining({
        kind: 'host-send',
        source: 'maker-ipc/collab',
        owner: 'orca-collab',
        entrypoint: 'enable_collab_mode',
        sessionId: 'worker-session-1',
        agentKind: 'codex',
        action: 'delegate_task',
        code: 'SESSION_RUNNING',
        context: 'enable_collab_mode/worker-session-1/delegate_task',
        error: {
          errorName: 'Error',
          errorCode: 'SESSION_RUNNING',
          safeMessage: 'SESSION_RUNNING',
        },
      }),
    );
    const loggedPayload = JSON.stringify(mockState.logger.warn.mock.calls);
    expect(loggedPayload).not.toContain('PROMPT_SECRET');
    expect(loggedPayload).not.toContain('full user message');
    expect(loggedPayload).not.toContain('TOKEN_VALUE');
    expect(loggedPayload).not.toContain('file body');
  });

  it('preserves typed dispatch outcomes through the xdt-helper control provider wrapper', async () => {
    mockState.collabService = createCollabService({
      createWorker: vi.fn().mockResolvedValue({
        ok: true,
        workerSessionId: 'worker-session-1',
        workerId: 'worker-1',
        dispatched: false,
        dispatchOutcome: {
          kind: 'session-dispatch',
          source: 'maker-ipc/collab',
          dispatched: false,
          reason: 'cancelled-before-dispatch',
          context: 'enable_collab_mode/worker-session-1/delegate_task',
          message: 'Session send was cancelled before vendor dispatch: enable_collab_mode/worker-session-1/delegate_task',
        },
      }),
    });

    createDesktopMcpProviders({
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true } as never,
      resolveIOSSimulatorAccess: () => ({ allowed: true }),
      invokeRemote: vi.fn(),
    });
    const orca = (mockState.capturedProvidersConfig?.orca ?? {}) as {
      createWorker: (params: {
        leadSessionId: string;
        role: string;
        agent: 'codex';
        label: string;
        initialTask: string;
      }) => Promise<Record<string, unknown>>;
    };

    const result = await orca.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'codex',
      label: 'dev',
      initialTask: 'do the work',
    });

    expect(result).toMatchObject({
      ok: true,
      workerSessionId: 'worker-session-1',
      workerId: 'worker-1',
      dispatched: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'maker-ipc/collab',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
      },
    });
    expect(result).not.toEqual(expect.objectContaining({ accepted: false }));
  });

  it('preserves typed createWorker failures through the xdt-helper control provider wrapper', async () => {
    mockState.collabService = createCollabService({
      createWorker: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
        message: 'Budget Codex models require API key mode',
      }),
    });

    createDesktopMcpProviders({
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true } as never,
      resolveIOSSimulatorAccess: () => ({ allowed: true }),
      invokeRemote: vi.fn(),
    });
    const orca = (mockState.capturedProvidersConfig?.orca ?? {}) as {
      createWorker: (params: {
        leadSessionId: string;
        role: string;
        agent: 'codex';
        label: string;
        model: string;
      }) => Promise<Record<string, unknown>>;
    };

    const result = await orca.createWorker({
      leadSessionId: 'lead-1',
      role: 'developer',
      agent: 'codex',
      label: 'dev',
      model: 'gpt-5.1-codex-mini',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: 'Budget Codex models require API key mode',
    });
  });

  it('exposes cindy_orca diagnostics through read-only collab provider callbacks', async () => {
    mockState.collabService = createCollabService({
      getWorkspaceInfo: vi.fn().mockResolvedValue({
        ok: true,
        workflow: null,
        ui_capacity: 1,
        worker_count: 0,
        workers: [],
      }),
      getWorkerStatus: vi.fn().mockResolvedValue({
        ok: true,
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        idle_ms: 42,
        restored_from_storage: true,
      }),
      readWorker: vi.fn().mockResolvedValue({
        ok: true,
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        result: 'latest assistant output',
      }),
    });

    createDesktopMcpProviders({
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true } as never,
      resolveIOSSimulatorAccess: () => ({ allowed: true }),
      invokeRemote: vi.fn(),
    });
    const orca = (mockState.capturedProvidersConfig?.orca ?? {}) as {
      getWorkspaceInfo: (params: { leadSessionId: string }) => Promise<Record<string, unknown>>;
      getWorkerStatus: (params: { leadSessionId: string; workerId: string }) => Promise<Record<string, unknown>>;
      readWorker: (params: { leadSessionId: string; workerId: string }) => Promise<Record<string, unknown>>;
    };

    await expect(orca.getWorkspaceInfo({ leadSessionId: 'lead-without-active-team' })).resolves.toMatchObject({
      ok: true,
      workflow: null,
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    });
    await expect(orca.getWorkerStatus({ leadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      session_status: 'not_running',
      restored_from_storage: true,
    });
    await expect(orca.readWorker({ leadSessionId: 'lead-1', workerId: 'worker-1' })).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      result: 'latest assistant output',
    });
    expect(mockState.collabService.getWorkspaceInfo).toHaveBeenCalledWith({ leadSessionId: 'lead-without-active-team' });
    expect(mockState.collabService.getWorkerStatus).toHaveBeenCalledWith({
      leadSessionId: 'lead-1',
      workerId: 'worker-1',
    });
    expect(mockState.collabService.readWorker).toHaveBeenCalledWith({
      leadSessionId: 'lead-1',
      workerId: 'worker-1',
    });
    expect(mockState.collabService.startTeam).not.toHaveBeenCalled();
    expect(mockState.collabService.createWorker).not.toHaveBeenCalled();
  });

  it('exposes arbitrary session queue reads through cindy_helper without Lead ownership', async () => {
    mockState.collabService = createCollabService({
      listSessionQueue: vi.fn().mockResolvedValue({
        ok: true,
        messages: [{ queuedMessageId: 'q-1', position: 0 }],
      }),
      listSessionQueuedCounts: vi.fn().mockResolvedValue({
        ok: true,
        counts: { 'session-1': 1 },
      }),
    });

    createDesktopMcpProviders({
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true } as never,
      resolveIOSSimulatorAccess: () => ({ allowed: true }),
      invokeRemote: vi.fn(),
    });
    const xdtHelper = mockState.capturedProvidersConfig?.xdtHelper as {
      sessionQueue: {
        listSessionQueue: (sessionId: string) => Promise<Record<string, unknown>>;
        listSessionQueuedCounts: (sessionIds: string[]) => Promise<Record<string, unknown>>;
      };
    };

    await expect(xdtHelper.sessionQueue.listSessionQueue('session-1')).resolves.toMatchObject({
      ok: true,
      messages: [{ queuedMessageId: 'q-1', position: 0 }],
    });
    await expect(
      xdtHelper.sessionQueue.listSessionQueuedCounts(['session-1']),
    ).resolves.toEqual({ ok: true, counts: { 'session-1': 1 } });
    expect(mockState.collabService.listSessionQueue).toHaveBeenCalledWith('session-1');
    expect(mockState.collabService.listSessionQueuedCounts).toHaveBeenCalledWith(['session-1']);
  });

  it('preserves retryable host-readiness errors at the cindy_helper control boundary', async () => {
    mockState.collabService = createCollabService({
      listSessionQueue: vi.fn().mockRejectedValue(new Error('DbClient not ready')),
      listSessionQueuedCounts: vi.fn().mockRejectedValue(new Error('localDb not ready')),
      stopSessionTurn: vi.fn().mockRejectedValue({
        code: 'HOST_NOT_READY',
        message: 'database owner unavailable',
      }),
      getSessionRuntime: vi.fn().mockRejectedValue(new Error('storage read failed')),
    });

    createDesktopMcpProviders({
      getMakerMemoryManager: vi.fn(),
      lspPool: {} as never,
      pluginRegistry: { isEnabled: () => true } as never,
      resolveIOSSimulatorAccess: () => ({ allowed: true }),
      invokeRemote: vi.fn(),
    });
    const xdtHelper = mockState.capturedProvidersConfig?.xdtHelper as {
      sessionQueue: {
        listSessionQueue: (sessionId: string) => Promise<Record<string, unknown>>;
        listSessionQueuedCounts: (sessionIds: string[]) => Promise<Record<string, unknown>>;
      };
      sessionControl: {
        stopSessionTurn: (params: { targetSessionId: string }) => Promise<Record<string, unknown>>;
        getSessionRuntime: (params: { targetSessionId: string }) => Promise<Record<string, unknown>>;
      };
    };

    await expect(
      xdtHelper.sessionQueue.listSessionQueue('session-1'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    await expect(
      xdtHelper.sessionQueue.listSessionQueuedCounts(['session-1']),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    await expect(
      xdtHelper.sessionControl.stopSessionTurn({ targetSessionId: 'session-1' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    await expect(
      xdtHelper.sessionControl.getSessionRuntime({ targetSessionId: 'session-1' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INTERNAL' });
  });
});
