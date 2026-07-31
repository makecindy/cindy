import type { AgentKind } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  createOrcaLifecycleService,
  ORCA_WORKER_READY_MESSAGE,
  type OrcaLifecycleDeps,
} from '../orcaLifecycleService';
import type { DispatchWorkerTaskResult } from '../orcaTeamService';
import type { OrcaWorkerCreationResult } from '../orcaWorkerCreationService';

function createdWorker(overrides: Partial<Extract<OrcaWorkerCreationResult, { ok: true }>> = {}): Extract<OrcaWorkerCreationResult, { ok: true }> {
  return {
    ok: true,
    teamId: 'team-1',
    workerId: 'worker-1',
    workerSessionId: 'worker-session-1',
    softLimitExceeded: false,
    resolved: {
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
      fastMode: false,
      providerId: null,
      role: 'reviewer',
      label: 'reviewer',
    },
    ...overrides,
  };
}

function createDeps(overrides: Partial<OrcaLifecycleDeps> = {}) {
  const calls: string[] = [];
  const deps: OrcaLifecycleDeps = {
    getActiveTeamByLead: vi.fn(async () => null),
    createActiveTeam: vi.fn(async (leadSessionId) => {
      calls.push(`createActiveTeam:${leadSessionId}`);
      return { id: 'team-1', leadSessionId };
    }),
    createWorkerInTeam: vi.fn(async (params) => {
      calls.push(`createWorkerInTeam:${params.teamId}:${params.label}`);
      return createdWorker({
        teamId: params.teamId,
        resolved: {
          agent: params.agent,
          model: params.model ?? 'gpt-5.5',
          effort: params.effort ?? 'medium',
          fastMode: params.fast ?? false,
          providerId: null,
          role: params.role,
          label: params.label,
        },
      });
    }),
    dispatchWorkerTask: vi.fn(async (params) => {
      calls.push(`dispatchWorkerTask:${params.dispatchMeta.context}`);
      return {
        dispatched: true,
        queued: false,
        dispatchOutcome: {
          kind: 'session-dispatch',
          source: params.dispatchMeta.source,
          dispatched: true,
        },
        agentKind: 'codex',
        wakeKind: 'resumed',
        targetTitle: 'Worker',
        targetLastUserSendAt: null,
      } satisfies DispatchWorkerTaskResult;
    }),
    markTeamEnded: vi.fn(async (teamId, status) => {
      calls.push(`markTeamEnded:${teamId}:${status}`);
    }),
    setSessionOrcaRole: vi.fn(async (sessionId, role) => {
      calls.push(`setSessionOrcaRole:${sessionId}:${role ?? 'null'}`);
    }),
    clearKnownNonOrcaSession: vi.fn((sessionId) => {
      calls.push(`clearKnownNonOrcaSession:${sessionId}`);
    }),
    setLeadVendorOptions: vi.fn(async (params) => {
      calls.push(`setLeadVendorOptions:${params.leadSessionId}:${params.workerSessionId}`);
    }),
    clearLeadVendorOptions: vi.fn(async (leadSessionId) => {
      calls.push(`clearLeadVendorOptions:${leadSessionId}`);
    }),
    sendWorkerReadyPlaceholder: vi.fn(async (params) => {
      calls.push(`sendWorkerReadyPlaceholder:${params.entrypoint}:${params.context}`);
    }),
    rollbackCreatedWorker: vi.fn(async ({ workerId, workerSessionId }) => {
      calls.push(`rollbackCreatedWorker:${workerId}:${workerSessionId}`);
    }),
    broadcastSessionCreated: vi.fn((sessionId) => {
      calls.push(`broadcastSessionCreated:${sessionId}`);
    }),
    broadcastOrcaWorkerChanged: vi.fn((leadSessionId) => {
      calls.push(`broadcastOrcaWorkerChanged:${leadSessionId}`);
    }),
    ...overrides,
  };
  return {
    calls,
    deps,
    service: createOrcaLifecycleService(deps),
  };
}

describe('OrcaLifecycleService', () => {
  it('starts a team without creating a worker and refreshes lead state', async () => {
    const { calls, service } = createDeps();

    await expect(service.startTeam({ leadSessionId: 'lead-1' })).resolves.toEqual({
      ok: true,
      teamId: 'team-1',
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:undefined',
    ]);
  });

  it('reuses an existing team and refreshes lead state for MCP start_team', async () => {
    const { calls, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-existing', leadSessionId: 'lead-1' })),
    });

    await expect(service.startTeam({ leadSessionId: 'lead-1' })).resolves.toEqual({
      ok: true,
      teamId: 'team-existing',
      reused: true,
    });

    expect(calls).toEqual([
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:undefined',
    ]);
  });

  it('fails a newly created team when start_team lead activation fails', async () => {
    const { calls, service } = createDeps({
      setSessionOrcaRole: vi.fn(async (sessionId, role) => {
        calls.push(`setSessionOrcaRole:${sessionId}:${role ?? 'null'}`);
        if (role === 'lead') throw new Error('lead role failed');
      }),
    });

    await expect(service.startTeam({ leadSessionId: 'lead-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'lead role failed',
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'setSessionOrcaRole:lead-1:lead',
      'markTeamEnded:team-1:failed',
      'setSessionOrcaRole:lead-1:null',
    ]);
  });

  it('fails a newly created team when start_team live lead refresh fails', async () => {
    const { calls, service } = createDeps({
      setLeadVendorOptions: vi.fn(async (params) => {
        calls.push(`setLeadVendorOptions:${params.leadSessionId}:${params.workerSessionId}`);
        throw new Error('vendor refresh failed');
      }),
    });

    await expect(service.startTeam({ leadSessionId: 'lead-1' })).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'vendor refresh failed',
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:undefined',
      'markTeamEnded:team-1:failed',
      'setSessionOrcaRole:lead-1:null',
    ]);
  });

  it('requires an active team before creating a worker', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'NOT_FOUND',
      message: 'no active team for this lead',
    });

    expect(deps.createWorkerInTeam).not.toHaveBeenCalled();
  });

  it('creates a worker in an existing team and dispatches the initial task before broadcasting', async () => {
    const { calls, deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-existing', leadSessionId: 'lead-1' })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
        initialTask: 'review PR',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      dispatched: true,
    });

    expect(deps.createActiveTeam).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'createWorkerInTeam:team-existing:reviewer',
      'dispatchWorkerTask:create_worker/worker-session-1/initial_task',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('keeps a created worker when initial task dispatch throws before vendor dispatch', async () => {
    const { calls, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-existing', leadSessionId: 'lead-1' })),
      dispatchWorkerTask: vi.fn(async (params) => {
        calls.push(`dispatchWorkerTask:${params.dispatchMeta.context}`);
        throw new Error('dispatch failed');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
        initialTask: 'review PR',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        accepted: false,
        code: 'SEND_FAILED',
        source: 'maker-ipc/collab',
        context: 'create_worker/worker-session-1/initial_task',
      },
    });

    expect(calls).toEqual([
      'createWorkerInTeam:team-existing:reviewer',
      'dispatchWorkerTask:create_worker/worker-session-1/initial_task',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('sends the shared ready placeholder when create_worker has no initial task', async () => {
    const { calls, deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-existing', leadSessionId: 'lead-1' })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
    });

    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    expect(deps.sendWorkerReadyPlaceholder).toHaveBeenCalledWith({
      workerSessionId: 'worker-session-1',
      agentKind: 'codex',
      entrypoint: 'create_worker',
      context: 'create_worker/worker-session-1/worker-ready-placeholder',
    });
    expect(ORCA_WORKER_READY_MESSAGE).toBe('[系统] Orca Worker 已就绪，等待 Lead 分配任务。');
    expect(calls).toEqual([
      'createWorkerInTeam:team-existing:reviewer',
      'sendWorkerReadyPlaceholder:create_worker:create_worker/worker-session-1/worker-ready-placeholder',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('treats blank create_worker initial task as empty and does not dispatch whitespace', async () => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-existing', leadSessionId: 'lead-1' })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
        initialTask: '   ',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-1',
    });

    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    expect(deps.sendWorkerReadyPlaceholder).toHaveBeenCalledWith({
      workerSessionId: 'worker-session-1',
      agentKind: 'codex',
      entrypoint: 'create_worker',
      context: 'create_worker/worker-session-1/worker-ready-placeholder',
    });
  });

  it('rolls back create_worker when the ready placeholder is not accepted', async () => {
    const { calls, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-existing', leadSessionId: 'lead-1' })),
      sendWorkerReadyPlaceholder: vi.fn(async (params) => {
        calls.push(`sendWorkerReadyPlaceholder:${params.entrypoint}:${params.context}`);
        throw new Error('ready placeholder cancelled');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'ready placeholder cancelled',
    });

    expect(calls).toEqual([
      'createWorkerInTeam:team-existing:reviewer',
      'sendWorkerReadyPlaceholder:create_worker:create_worker/worker-session-1/worker-ready-placeholder',
      'rollbackCreatedWorker:worker-1:worker-session-1',
    ]);
  });

  it('rolls back create_worker when the ready placeholder start fails', async () => {
    const { calls, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-existing', leadSessionId: 'lead-1' })),
      sendWorkerReadyPlaceholder: vi.fn(async (params) => {
        calls.push(`sendWorkerReadyPlaceholder:${params.entrypoint}:${params.context}`);
        throw new Error('ready placeholder start failed');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'ready placeholder start failed',
    });

    expect(calls).toEqual([
      'createWorkerInTeam:team-existing:reviewer',
      'sendWorkerReadyPlaceholder:create_worker:create_worker/worker-session-1/worker-ready-placeholder',
      'rollbackCreatedWorker:worker-1:worker-session-1',
    ]);
  });

  it('keeps an explicit create_worker initial task unchanged instead of replacing it with the ready placeholder', async () => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => ({ id: 'team-existing', leadSessionId: 'lead-1' })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
        initialTask: '  review PR  ',
      }),
    ).resolves.toMatchObject({
      ok: true,
      dispatched: true,
    });

    expect(deps.sendWorkerReadyPlaceholder).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).toHaveBeenCalledWith(expect.objectContaining({
      message: '  review PR  ',
      dispatchMeta: expect.objectContaining({
        context: 'create_worker/worker-session-1/initial_task',
      }),
    }));
  });

  it('enables a team through the same worker creation boundary and sends the ready placeholder when no delegate task exists', async () => {
    const { calls, service } = createDeps();

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'reviewer',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      teamId: 'team-1',
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      dispatched: false,
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'createWorkerInTeam:team-1:reviewer',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:worker-session-1',
      'sendWorkerReadyPlaceholder:enable_collab_mode:enable_collab_mode/worker-session-1/worker-ready-placeholder',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('uses the worker role slug as the default label when enabling a team', async () => {
    const { calls, service } = createDeps();

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'Code Review',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-1',
      dispatched: false,
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'createWorkerInTeam:team-1:code-review',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:worker-session-1',
      'sendWorkerReadyPlaceholder:enable_collab_mode:enable_collab_mode/worker-session-1/worker-ready-placeholder',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('keeps the worker role slug as the default label when a delegate task exists', async () => {
    const { calls, service } = createDeps();

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'Code Review',
        delegateTask: 'Review PR #42 now',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-1',
      dispatched: true,
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'createWorkerInTeam:team-1:code-review',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:worker-session-1',
      'dispatchWorkerTask:enable_collab_mode/worker-session-1/delegate_task',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('falls back to worker when the worker role cannot produce a label slug', async () => {
    const { calls, service } = createDeps();

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: '评审',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-1',
      dispatched: false,
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'createWorkerInTeam:team-1:worker',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:worker-session-1',
      'sendWorkerReadyPlaceholder:enable_collab_mode:enable_collab_mode/worker-session-1/worker-ready-placeholder',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('rejects invalid explicit worker labels before creating an enabled team', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'reviewer',
        label: 'bad label',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: 'label may only contain letters, numbers, hyphens and underscores',
    });

    expect(deps.createActiveTeam).not.toHaveBeenCalled();
    expect(deps.createWorkerInTeam).not.toHaveBeenCalled();
  });

  it('rolls back a created worker when enable_collab_mode live lead refresh fails', async () => {
    const { calls, service } = createDeps({
      setLeadVendorOptions: vi.fn(async (params) => {
        calls.push(`setLeadVendorOptions:${params.leadSessionId}:${params.workerSessionId}`);
        throw new Error('vendor refresh failed');
      }),
    });

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'reviewer',
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'vendor refresh failed',
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'createWorkerInTeam:team-1:reviewer',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:worker-session-1',
      'rollbackCreatedWorker:worker-1:worker-session-1',
      'markTeamEnded:team-1:failed',
      'setSessionOrcaRole:lead-1:null',
    ]);
  });

  it('rolls back a newly enabled team and clears lead options when the ready placeholder is not accepted', async () => {
    const { calls, service } = createDeps({
      sendWorkerReadyPlaceholder: vi.fn(async (params) => {
        calls.push(`sendWorkerReadyPlaceholder:${params.entrypoint}:${params.context}`);
        throw new Error('ready placeholder cancelled');
      }),
    });

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'reviewer',
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'ready placeholder cancelled',
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'createWorkerInTeam:team-1:reviewer',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:worker-session-1',
      'sendWorkerReadyPlaceholder:enable_collab_mode:enable_collab_mode/worker-session-1/worker-ready-placeholder',
      'rollbackCreatedWorker:worker-1:worker-session-1',
      'markTeamEnded:team-1:failed',
      'setSessionOrcaRole:lead-1:null',
      'clearLeadVendorOptions:lead-1',
    ]);
  });

  it('keeps the enabled team when delegate task dispatch throws before vendor dispatch', async () => {
    const { calls, service } = createDeps({
      dispatchWorkerTask: vi.fn(async (params) => {
        calls.push(`dispatchWorkerTask:${params.dispatchMeta.context}`);
        throw new Error('dispatch failed');
      }),
    });

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'reviewer',
        label: 'reviewer',
        delegateTask: 'review PR',
      }),
    ).resolves.toMatchObject({
      ok: true,
      teamId: 'team-1',
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      dispatched: false,
      dispatchOutcome: {
        kind: 'host-send',
        accepted: false,
        code: 'SEND_FAILED',
        source: 'maker-ipc/collab',
        context: 'enable_collab_mode/worker-session-1/delegate_task',
      },
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'createWorkerInTeam:team-1:reviewer',
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:worker-session-1',
      'dispatchWorkerTask:enable_collab_mode/worker-session-1/delegate_task',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('marks a newly created team failed when worker creation is rejected', async () => {
    const { calls, service } = createDeps({
      createWorkerInTeam: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE' as const,
        message: 'budget unavailable',
      })),
    });

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'reviewer',
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: 'budget unavailable',
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'markTeamEnded:team-1:failed',
      'setSessionOrcaRole:lead-1:null',
    ]);
  });

  it('removes the created worker and fails the team when lead role persistence fails', async () => {
    const { calls, service } = createDeps({
      setSessionOrcaRole: vi.fn(async (sessionId, role) => {
        calls.push(`setSessionOrcaRole:${sessionId}:${role ?? 'null'}`);
        if (role === 'lead') throw new Error('lead role failed');
      }),
    });

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'reviewer',
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'lead role failed',
    });

    expect(calls).toEqual([
      'createActiveTeam:lead-1',
      'createWorkerInTeam:team-1:reviewer',
      'setSessionOrcaRole:lead-1:lead',
      'rollbackCreatedWorker:worker-1:worker-session-1',
      'markTeamEnded:team-1:failed',
      'setSessionOrcaRole:lead-1:null',
    ]);
  });
});
