import { hasAcceptedUserTaskInput } from '../pluginTaskInput.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PluginTaskError } from '../pluginTaskService.js';
import type { AgentKind } from '@cindy/maker-core';
import { AcceptedCallbackDispatchCancelled, runAcceptedCallback } from '../acceptedCallbackRunner';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The lifecycle unit owns no credential/runtime I/O.
vi.mock('../../maker-host/codex-credential-switch.js', () => ({isCredentialModeSwitchBusyError: () => false}));

import {
  createOrcaLifecycleService,
  ORCA_WORKER_READY_MESSAGE,
  type OrcaLifecycleDeps,
} from '../orcaLifecycleService';
import type { DispatchWorkerTaskResult } from '../orcaTeamService';
import type {
  OrcaTeamSnapshot,
  OrcaWorkerCreationResult,
} from '../orcaWorkerCreationService';

function activeTeam(): OrcaTeamSnapshot {
  return { id: 'team-existing', leadSessionId: 'lead-1' };
}

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
    isOrphanedTeamInit: vi.fn(async () => false),
    getWorkerPermissionMode: vi.fn(() => 'auto' as const),
    setWorkerPermissionMode: vi.fn((workerPermissionMode) => {
      calls.push(`setWorkerPermissionMode:${workerPermissionMode}`);
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
  it.each(['create-task', 'create-placeholder', 'enable-task', 'enable-placeholder', 'enable-deferred'].flatMap(action => [true, false].flatMap(revoked => ['source', 'directory'].map(scope => ({ action, revoked, scope }))))) (
    'guards $action $scope at acceptance, revoked=$revoked, and cleans up outside dispatch', async ({ action, revoked, scope }) => {
      let allowed = true, insideSend = false, nativeCalls = 0;
      const { deps, service } = createDeps({
        getActiveTeamByLead: async () => action.startsWith('create') ? activeTeam() : null,
        getWorkerPermissionModeOverride: async () => ({ permissionMode: 'auto', assertCurrent: async () => { if (scope === 'source' && !allowed) throw new Error('Revoked'); } }),
      });
      const create = deps.createWorkerInTeam;
      deps.createWorkerInTeam = async (params, assertCurrent, onCreated) => {
        const result = await create(params, assertCurrent);
        onCreated?.(async () => { await assertCurrent?.(); if (scope === 'directory' && !allowed) throw Error('Revoked'); });
        return result;
      };
      deps.dispatchWorkerTask = vi.fn(async (params, assertCurrent): Promise<DispatchWorkerTaskResult> => {
        insideSend = true; allowed = !revoked;
        try {
          try { await assertCurrent?.(); } catch { return { dispatched: false, dispatchOutcome: { kind: 'host-send', code: 'SEND_FAILED', accepted: false, message: 'Revoked', source: 'test', context: 'initial' } }; }
          nativeCalls++;
          return { dispatched: true, dispatchOutcome: { kind: 'session-dispatch', source: params.dispatchMeta.source, dispatched: true }, agentKind: 'codex', wakeKind: 'resumed', targetTitle: 'Worker', targetLastUserSendAt: null };
        } finally { insideSend = false; }
      });
      const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
      const lifecycleFrom = source.indexOf('  const orcaLifecycleService = createOrcaLifecycleService(');
      expect(lifecycleFrom).toBeGreaterThan(-1);
      const dispatchFrom = source.indexOf('    dispatchWorkerTask: (', lifecycleFrom);
      const dispatchAdapter = source.slice(dispatchFrom, source.indexOf('    markTeamEnded,', dispatchFrom));
      const dispatchJs = ts.transpileModule(`return ({${dispatchAdapter}}).dispatchWorkerTask;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      deps.dispatchWorkerTask = new Function('orcaTeamService', dispatchJs)({ dispatchWorkerTask: deps.dispatchWorkerTask });
      const from = source.indexOf('    sendWorkerReadyPlaceholder: async (');
      const callback = source.slice(from, source.indexOf('    rollbackCreatedWorker:', from));
      const bindings = { maker: { getSession: () => ({ id: 'worker-session-1', send: async (_message: unknown, opts: { onAccepted?: () => Promise<void> }) => {
        insideSend = true; allowed = !revoked;
        try { await runAcceptedCallback(opts.onAccepted, 'worker-session-1', 'placeholder'); nativeCalls++; return { dispatched: true }; }
        finally { insideSend = false; }
      } }) }, ORCA_WORKER_READY_MESSAGE, AcceptedCallbackDispatchCancelled, assertDesktopSendDispatched: vi.fn(), log: { info: vi.fn() } };
      const js = ts.transpileModule(`return ({${callback}}).sendWorkerReadyPlaceholder;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      deps.sendWorkerReadyPlaceholder = new Function('hasAcceptedUserTaskInput', ...Object.keys(bindings), js)(hasAcceptedUserTaskInput, ...Object.values(bindings));
      deps.rollbackCreatedWorker = vi.fn(async () => { expect(insideSend).toBe(false); });
      const result = action.startsWith('create')
        ? await service.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'reviewer', label: 'reviewer', ...(action.endsWith('task') ? { initialTask: 'Evaluate' } : {}) })
        : await service.enableTeam({ leadSessionId: 'lead-1', workerAgent: 'codex', ...(action === 'enable-task' || action === 'enable-deferred' ? { delegateTask: 'Evaluate' } : {}), deferDelegateTask: action === 'enable-deferred' });
      expect(result.ok).toBe(!revoked);
      expect(nativeCalls).toBe(revoked ? 0 : 1);
      expect(deps.rollbackCreatedWorker).toHaveBeenCalledTimes(revoked ? 1 : 0);
      expect(deps.markTeamEnded).toHaveBeenCalledTimes(revoked && action.startsWith('enable') ? 1 : 0);
    },
  );

  it.each((['createWorker', 'enableTeam'] as const).flatMap(action => ['source', 'directory'].map(scope => ({ action, scope }))))(
    'keeps the Worker when queued $scope acceptance rejects before $action returns', async ({ action, scope }) => {
      let allowed = true;
      const { deps, service } = createDeps({
        getActiveTeamByLead: async () => action === 'createWorker' ? activeTeam() : null,
        getWorkerPermissionModeOverride: async () => ({
          permissionMode: 'auto',
          assertCurrent: async () => { if (scope === 'source' && !allowed) throw new Error('Revoked'); },
        }),
        dispatchWorkerTask: vi.fn(async (_params, assertCurrent): Promise<DispatchWorkerTaskResult> => {
          // A coordinator drain can reject independently before the queued
          // result reaches lifecycle; it still owns this queued input only.
          allowed = false;
          await expect(assertCurrent!()).rejects.toThrow('Revoked');
          return {
            dispatched: false,
            queued: true,
            dispatchOutcome: { kind: 'session-dispatch', dispatched: true, source: 'test', wakeKind: 'queued' },
            agentKind: 'codex',
            wakeKind: 'queued',
            targetTitle: 'Worker',
            targetLastUserSendAt: null,
            queuedMessageId: 'queued-1',
          };
        }),
      });
      const create = deps.createWorkerInTeam;
      deps.createWorkerInTeam = async (params, assertCurrent, onCreated) => {
        const result = await create(params, assertCurrent);
        onCreated?.(async () => { await assertCurrent?.(); if (scope === 'directory' && !allowed) throw Error('Revoked'); });
        return result;
      };
      const result = action === 'createWorker'
        ? await service.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'reviewer', label: 'reviewer', initialTask: 'Evaluate' })
        : await service.enableTeam({ leadSessionId: 'lead-1', workerAgent: 'codex', delegateTask: 'Evaluate' });
      expect(result).toMatchObject({ ok: true, dispatched: false, dispatchOutcome: { wakeKind: 'queued' } });
      expect(deps.rollbackCreatedWorker).not.toHaveBeenCalled();
      expect(deps.markTeamEnded).not.toHaveBeenCalled();
    },
  );

  it('starts a team without creating a worker and refreshes lead state', async () => {
    const { calls, service } = createDeps();

    await expect(service.startTeam({ leadSessionId: 'lead-1' })).resolves.toEqual({
      ok: true,
      teamId: 'team-1',
      workerPermissionMode: 'auto',
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
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
    });

    await expect(service.startTeam({ leadSessionId: 'lead-1' })).resolves.toEqual({
      ok: true,
      teamId: 'team-existing',
      workerPermissionMode: 'auto',
      reused: true,
    });

    expect(calls).toEqual([
      'setSessionOrcaRole:lead-1:lead',
      'clearKnownNonOrcaSession:lead-1',
      'setLeadVendorOptions:lead-1:undefined',
    ]);
  });

  it('persists an explicit Full access Worker creation preference when start_team creates the team', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.startTeam({
        leadSessionId: 'lead-1',
        workerPermissionMode: 'bypassPermissions',
      }),
    ).resolves.toEqual({
      ok: true,
      teamId: 'team-1',
      workerPermissionMode: 'bypassPermissions',
    });

    expect(deps.createActiveTeam).toHaveBeenCalledWith('lead-1');
    expect(deps.setWorkerPermissionMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('switches the shared Worker creation preference when start_team explicitly specifies it', async () => {
    const { calls, deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
    });

    await expect(
      service.startTeam({
        leadSessionId: 'lead-1',
        workerPermissionMode: 'bypassPermissions',
      }),
    ).resolves.toMatchObject({
      ok: true,
      teamId: 'team-existing',
      workerPermissionMode: 'bypassPermissions',
      reused: true,
    });

    expect(deps.setWorkerPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(calls).toContain('setWorkerPermissionMode:bypassPermissions');
  });

  it('uses the saved Full access preference when start_team omits the mode', async () => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
      getWorkerPermissionMode: vi.fn(() => 'bypassPermissions' as const),
    });

    await expect(service.startTeam({ leadSessionId: 'lead-1' })).resolves.toMatchObject({
      ok: true,
      teamId: 'team-existing',
      workerPermissionMode: 'bypassPermissions',
      reused: true,
    });
    expect(deps.setWorkerPermissionMode).not.toHaveBeenCalled();
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
      'clearLeadVendorOptions:lead-1',
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
      'clearLeadVendorOptions:lead-1',
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
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
        initialTask: 'review PR',
        workingDir: '/remote/explicit-project',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      dispatched: true,
    });

    expect(deps.createActiveTeam).not.toHaveBeenCalled();
    expect(deps.createWorkerInTeam).toHaveBeenCalledWith(expect.objectContaining({ workingDir: '/remote/explicit-project' }), undefined, expect.any(Function));
    expect(calls).toEqual([
      'createWorkerInTeam:team-existing:reviewer',
      'dispatchWorkerTask:create_worker/worker-session-1/initial_task',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it.each(['missing', 'failed'])('does not change the ordinary preference when team lookup is %s', async outcome => {
    const { deps, service } = createDeps({
      getWorkerPermissionModeOverride: async () => ({ assertCurrent: async () => undefined }),
      getActiveTeamByLead: async () => { if (outcome === 'failed') throw new Error('storage'); return null; },
    });
    const result = await service.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'eval', label: 'sample', workerPermissionMode: 'bypassPermissions' }).catch(() => ({ ok: false }));
    expect(result.ok).toBe(false);
    expect(deps.setWorkerPermissionMode).not.toHaveBeenCalled();
    expect(deps.createWorkerInTeam).not.toHaveBeenCalled();
  });

  it('uses the saved Worker creation preference for later create_worker calls', async () => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
      getWorkerPermissionMode: vi.fn(() => 'bypassPermissions' as const),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex' as AgentKind,
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(deps.createWorkerInTeam).toHaveBeenCalledWith(
      expect.objectContaining({ workerPermissionMode: 'bypassPermissions' }),
      undefined, expect.any(Function));
  });

  it('keeps a created worker when initial task dispatch throws before vendor dispatch', async () => {
    const { calls, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
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
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
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
    }, undefined);
    expect(ORCA_WORKER_READY_MESSAGE).toBe(
      '[系统] Orca Worker 已就绪，当前没有待执行任务。不要调用任何工具来等待、观察或轮询 Lead。只回复一句简短确认并立即结束本轮；Lead 后续会主动发送任务。',
    );
    expect(calls).toEqual([
      'createWorkerInTeam:team-existing:reviewer',
      'sendWorkerReadyPlaceholder:create_worker:create_worker/worker-session-1/worker-ready-placeholder',
      'broadcastSessionCreated:worker-session-1',
      'broadcastOrcaWorkerChanged:lead-1',
    ]);
  });

  it('treats blank create_worker initial task as empty and does not dispatch whitespace', async () => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
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
    }, undefined);
  });

  it('rolls back create_worker when the ready placeholder is not accepted', async () => {
    const { calls, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
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
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
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
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
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
    }), undefined);
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

  it('uses and saves the explicitly selected preference for the first UI-created Worker', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'reviewer',
        label: 'reviewer',
        workerPermissionMode: 'bypassPermissions',
      }),
    ).resolves.toMatchObject({
      ok: true,
      workerPermissionMode: 'bypassPermissions',
    });

    expect(deps.createActiveTeam).toHaveBeenCalledWith('lead-1');
    expect(deps.setWorkerPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(deps.createWorkerInTeam).toHaveBeenCalledWith(
      expect.objectContaining({ workerPermissionMode: 'bypassPermissions' }),
      undefined, expect.any(Function));
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
      uiAssignmentSnapshotBeforeMs: expect.any(Number),
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
    const { calls, deps, service } = createDeps();

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
    expect(deps.dispatchWorkerTask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('[Orca UI Assignment]'),
        dispatchMeta: expect.objectContaining({
          context: 'enable_collab_mode/worker-session-1/delegate_task',
        }),
      }),
      undefined,
    );
    const dispatchedMessage = vi.mocked(deps.dispatchWorkerTask).mock.calls[0]?.[0].message;
    expect(dispatchedMessage).toContain('Task:\nReview PR #42 now');
    expect(dispatchedMessage).toContain('Lead session id: "lead-1"');
    expect(dispatchedMessage).toContain('orca_worker_bridge.read_lead_history');
    expect(dispatchedMessage).toContain('If the task is self-contained, proceed directly');
    expect(dispatchedMessage).toContain(
      "do not assume the process cwd is the Lead's active worktree",
    );
  });

  it('initializes a deferred-task Worker with the ready placeholder without dispatching the task', async () => {
    const { calls, deps, service } = createDeps();

    await expect(
      service.enableTeam({
        leadSessionId: 'lead-1',
        workerAgent: 'codex',
        role: 'Code Review',
        delegateTask: 'Review the attached spec',
        deferDelegateTask: true,
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
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    expect(deps.sendWorkerReadyPlaceholder).toHaveBeenCalledOnce();
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

describe('enableTeam — 孤儿空团队自动回收 (#3555)', () => {
  const enableParams = {
    leadSessionId: 'lead-1',
    workerAgent: 'codex',
    role: 'reviewer',
    label: 'reviewer',
  } as const;

  it('active 空团队(零 worker 且无存活 reservation)→ 按 failed 收口后继续启用', async () => {
    const { calls, deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
      isOrphanedTeamInit: vi.fn(async () => true),
    });
    await expect(service.enableTeam(enableParams)).resolves.toMatchObject({
      teamId: 'team-1',
      workerId: 'worker-1',
    });
    expect(deps.isOrphanedTeamInit).toHaveBeenCalledWith('team-existing');
    expect(deps.markTeamEnded).toHaveBeenCalledWith('team-existing', 'failed');
    expect(calls).toContain('createActiveTeam:lead-1');
  });

  it('非孤儿 → 维持 ALREADY_EXISTS,不动既有 team', async () => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
      isOrphanedTeamInit: vi.fn(async () => false),
    });
    await expect(service.enableTeam(enableParams)).resolves.toMatchObject({
      ok: false,
      errorCode: 'ALREADY_EXISTS',
    });
    expect(deps.markTeamEnded).not.toHaveBeenCalled();
  });

  it('孤儿判定抛错 → 保守维持 ALREADY_EXISTS,绝不误收可能有内容的 team', async () => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
      isOrphanedTeamInit: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    await expect(service.enableTeam(enableParams)).resolves.toMatchObject({
      ok: false,
      errorCode: 'ALREADY_EXISTS',
    });
    expect(deps.markTeamEnded).not.toHaveBeenCalled();
  });

  it('并发 enableTeam:in-flight 初始化中的 team 不会被误判孤儿收口(review P1)', async () => {
    // 竞态:A 已 createActiveTeam、worker/reservation 尚未落地时,B 进来看到
    // 零 worker 团队。若无 in-flight 守卫,B 会把 A 的 team 判孤儿标 failed,
    // A 随后把 worker 写进 failed team 并返回成功——结果与持久化状态不一致。
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const { deps, service } = createDeps({
      // 若守卫失效,B 会调用它并走收口——断言它根本不被咨询。
      isOrphanedTeamInit: vi.fn(async () => true),
    });
    let activeTeam: OrcaTeamSnapshot | null = null;
    vi.mocked(deps.getActiveTeamByLead).mockImplementation(async () => activeTeam);
    vi.mocked(deps.createActiveTeam).mockImplementation(async (leadSessionId) => {
      activeTeam = { id: 'team-a', leadSessionId };
      return activeTeam;
    });
    vi.mocked(deps.createWorkerInTeam).mockImplementation(async (params) => {
      await gate;
      return createdWorker({ teamId: params.teamId });
    });

    const first = service.enableTeam({
      leadSessionId: 'lead-1',
      workerAgent: 'codex',
      role: 'reviewer',
      label: 'reviewer',
    });
    await vi.waitFor(() => expect(deps.createWorkerInTeam).toHaveBeenCalled());

    const second = await service.enableTeam({
      leadSessionId: 'lead-1',
      workerAgent: 'codex',
      role: 'reviewer',
      label: 'reviewer-2',
    });
    expect(second).toMatchObject({ ok: false, errorCode: 'ALREADY_EXISTS' });
    expect(deps.isOrphanedTeamInit).not.toHaveBeenCalled();
    expect(deps.markTeamEnded).not.toHaveBeenCalled();

    releaseCreate();
    await expect(first).resolves.toMatchObject({ teamId: 'team-a' });
  });
});


describe('host-scoped Worker permissions', () => {
  it.each([undefined, 'bypassPermissions'] as const)('keeps plugin Workers Auto despite global or explicit Full access: %s', async (workerPermissionMode) => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
      getWorkerPermissionMode: vi.fn(() => 'bypassPermissions' as const),
      getWorkerPermissionModeOverride: vi.fn(async () => ({ permissionMode: 'auto' as const, assertCurrent: async () => undefined })),
    });
    expect(await service.startTeam({leadSessionId: 'lead-1', workerPermissionMode})).toMatchObject({ok: true, workerPermissionMode: 'auto'});
    await service.createWorker({leadSessionId: 'lead-1', role: 'worker', label: 'sample', agent: 'codex', workerPermissionMode});
    expect(deps.createWorkerInTeam).toHaveBeenCalledWith(expect.objectContaining({workerPermissionMode: 'auto'}), expect.any(Function), expect.any(Function));
    expect(deps.setWorkerPermissionMode).not.toHaveBeenCalled();
  });
  it('does not create a Worker after host authorization is revoked', async () => {
    const { deps, service } = createDeps({
      getActiveTeamByLead: vi.fn(async () => activeTeam()),
      getWorkerPermissionModeOverride: vi.fn(async () => { throw new Error('permission revoked'); }),
    });
    await expect(service.createWorker({leadSessionId: 'lead-1', role: 'worker', label: 'sample', agent: 'codex'})).rejects.toThrow('permission revoked');
    expect(deps.createWorkerInTeam).not.toHaveBeenCalled();
    expect(deps.setWorkerPermissionMode).not.toHaveBeenCalled();
  });
});


describe('retained tasks after explicit plugin uninstall', () => {
  const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('  const assertPluginWorkerAutoAuthorized ='), source.indexOf('  const orcaWorkerCreationService ='));
  const callback = source.slice(source.indexOf('    getWorkerPermissionModeOverride: async (leadSessionId) => {'), source.indexOf('    setWorkerPermissionMode: applyWorkerPermissionModePreference,'));
  const js = ts.transpileModule(`${helper}\nreturn ({${callback}}).getWorkerPermissionModeOverride;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  it.each(['direct','queued'].flatMap(delivery=>['plugin','human-after','plugin-after','none','cleared','forged','rewound','child','manual-retry','unknown'].map(history=>({delivery,history}))))(
    'retains the source across $delivery automatic Worker replies after $history', async({delivery,history})=>{
      const sqlite=new Database(':memory:');
      try {
        sqlite.exec('CREATE TABLE sessions(id TEXT, cleared_at INTEGER); CREATE TABLE messages(client_id TEXT, session_id TEXT, role TEXT, created_at INTEGER, agent_meta TEXT, rewind_at INTEGER);');
        const sessions=sqliteTable('sessions',{id:text('id'),clearedAt:integer('cleared_at')});
        const messages=sqliteTable('messages',{clientId:text('client_id'),sessionId:text('session_id'),role:text('role'),createdAt:integer('created_at'),agentMeta:text('agent_meta'),rewindAt:integer('rewind_at')});
        sqlite.prepare('INSERT INTO sessions VALUES (?,?)').run('lead',history==='cleared'?300:0);
        const insert=sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
        const add=(id:string,at:number,meta:object,rewind:number|null=null)=>insert.run(id,'lead','user',at,JSON.stringify(meta),rewind);
        if(['manual-retry','unknown'].includes(history))add('old-human',50,{delivery:'turn',autoReviewUserText:'Earlier task'});
        if(history!=='none') add('plugin-task:run',100,{delivery:'turn'},history==='manual-retry'?250:null);
        if(['manual-retry','unknown'].includes(history))add(history,300,{delivery:'turn'});
        if(['human-after','plugin-after','rewound','child'].includes(history))add('human',200,{delivery:'turn',autoReviewUserText:'My new task',...(history==='child'?{parentUuid:'child'}:{})},history==='rewound'?250:null);
        if(history==='plugin-after')add('plugin-task:run',250,{delivery:'turn'});
        if(history==='forged')add('fake-human',200,{delivery:'turn',origin:{kind:'desktop'}});
        add('worker-reply',400,{delivery:'turn',origin:{kind:'orca'}});
        const epoch={client:{drizzle:drizzle(sqlite)}};
        const bindings={getCurrentDbClientSnapshot:()=>epoch,PluginTaskError,sessions,messages,and,desc,eq,isNull,sql,
          maker:{getSession:()=>({isTurnRunning:()=>true})},inputCoordinator:{getAcceptedInputProvenance:()=>delivery==='queued'?{clientId:'worker-reply',originKind:'orca'}:null},
          createPluginTaskStore:()=>({get:async(id:string)=>id==='run'?{operation:'send',targetId:'lead',pluginId:'plugin',payload:'{"inputMessageId":"plugin-task:run"}'}:{operation:'create',pluginId:'plugin',payload:'{"ownershipRevoked":true}'}})};
        const override=new Function('hasAcceptedUserTaskInput', ...Object.keys(bindings),js)(hasAcceptedUserTaskInput, ...Object.values(bindings));
        if(history==='human-after')await expect(override('lead')).resolves.toMatchObject({permissionMode:undefined});
        else await expect(override('lead')).rejects.toMatchObject({code:'PERMISSION_DENIED'});
      } finally {sqlite.close();}
    });
  it.each(['plugin','auto-retry','human','manual-retry','idle'].flatMap(input=>['revoked','disabled','ask','plan','healthy'].map(state=>({input,state}))))(
    'keeps $input source distinct from $state task ownership',async({input,state})=>{
      const epoch={client:{}};
      const active=input==='idle'?null:input==='plugin'?{clientId:'plugin-task:run'}:input==='human'?{clientId:'human',authoredText:'Continue my task'}:{clientId:'retry',retrySourceClientId:'plugin-task:run',autoResume:input==='auto-retry'};
      const bindings={getCurrentDbClientSnapshot:()=>epoch,PluginTaskError,
        maker:{getSession:()=>null},inputCoordinator:{getAcceptedInputProvenance:()=>active},
        createPluginTaskStore:()=>({get:async(id:string)=>id==='run'?{operation:'send',targetId:'lead',pluginId:'plugin',payload:'{"inputMessageId":"plugin-task:run"}'}:{operation:'create',pluginId:'plugin',payload:JSON.stringify({ownershipRevoked:state==='revoked'})}}),
        pluginTaskServiceForCurrentOwner:()=>({get:async()=>({status:'active',permissionMode:state==='ask'?'default':'auto',planModeEnabled:state==='plan'})}),
        isPluginTaskAuthorized:()=>state!=='disabled',readGhostErrandConfig:()=>({permissionMode:'auto'})};
      const override=new Function('hasAcceptedUserTaskInput', ...Object.keys(bindings),js)(hasAcceptedUserTaskInput, ...Object.values(bindings));
      const ordinary=state==='revoked'&&['human','idle'].includes(input);
      if(state==='healthy'||ordinary)await expect(override('lead')).resolves.toMatchObject({permissionMode:ordinary?undefined:'auto'});
      else await expect(override('lead')).rejects.toThrow();
    });
  it.each(['enableTeam', 'startTeam', 'createWorker'] as const)('requires an active plugin task outside Plan Mode for %s', async action => {
    for (const {status,planModeEnabled} of [{status:'active',planModeEnabled:false},{status:'archived',planModeEnabled:false},{status:'active',planModeEnabled:true}]) {
      const epoch = { client: {} };
      const callbacks = { getCurrentDbClientSnapshot: () => epoch, PluginTaskError,
        maker: {getSession:()=>null}, inputCoordinator: { getAcceptedInputProvenance: () => null },
        createPluginTaskStore: () => ({ get: async () => ({ operation: 'create', pluginId: 'plugin', payload: '{}' }) }),
        pluginTaskServiceForCurrentOwner: () => ({ get: async () => ({ status, permissionMode: 'auto', planModeEnabled }) }),
        isPluginTaskAuthorized: () => true, readGhostErrandConfig: () => ({ permissionMode: 'auto' }),
      };
      const override = new Function('hasAcceptedUserTaskInput', ...Object.keys(callbacks), js)(hasAcceptedUserTaskInput, ...Object.values(callbacks));
      const { deps, service } = createDeps({ getWorkerPermissionModeOverride: override,
        getActiveTeamByLead: vi.fn(async () => action === 'createWorker' ? activeTeam() : null),
      });
      const result = action === 'enableTeam' ? service.enableTeam({ leadSessionId: 'lead-1', workerAgent: 'codex', role: 'worker', label: 'sample' })
        : action === 'startTeam' ? service.startTeam({ leadSessionId: 'lead-1' })
        : service.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'worker', label: 'sample' });
      if (status === 'active' && !planModeEnabled) await expect(result).resolves.toMatchObject({ ok: true });
      else {
        await expect(result).rejects.toMatchObject({ code: planModeEnabled ? 'PERMISSION_DENIED' : 'TASK_BUSY' });
        expect(deps.createWorkerInTeam).not.toHaveBeenCalled();
        expect(deps.createActiveTeam).not.toHaveBeenCalled();
      }
    }
  });
  it.each(['enableTeam', 'startTeam', 'createWorker'] as const)('uses ordinary permissions for %s with a retained revoked receipt', async action => {
    const epoch = { client: {} }, get = vi.fn(async () => { throw new PluginTaskError('TASK_NOT_FOUND', 'Revoked'); });
    const callbacks = { getCurrentDbClientSnapshot: () => epoch, PluginTaskError,
      maker: {getSession:()=>null}, inputCoordinator: { getAcceptedInputProvenance: () => null },
      createPluginTaskStore: () => ({ get: async () => ({ operation: 'create', pluginId: 'plugin', payload: JSON.stringify({ ownershipRevoked: true }) }) }),
      pluginTaskServiceForCurrentOwner: () => ({ get }), isPluginTaskAuthorized: () => false,
      readGhostErrandConfig: () => ({ permissionMode: 'auto' }),
    };
    const override = new Function('hasAcceptedUserTaskInput', ...Object.keys(callbacks), js)(hasAcceptedUserTaskInput, ...Object.values(callbacks));
    const { deps, service } = createDeps({
      getWorkerPermissionModeOverride: override,
      getWorkerPermissionMode: () => 'bypassPermissions',
      getActiveTeamByLead: vi.fn(async () => action === 'createWorker' ? activeTeam() : null),
    });
    const result = action === 'enableTeam' ? service.enableTeam({ leadSessionId: 'lead-1', workerAgent: 'codex', role: 'worker', label: 'sample' })
      : action === 'startTeam' ? service.startTeam({ leadSessionId: 'lead-1' })
      : service.createWorker({ leadSessionId: 'lead-1', agent: 'codex', role: 'worker', label: 'sample' });
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(get).not.toHaveBeenCalled();
    if (action !== 'startTeam') expect(deps.createWorkerInTeam).toHaveBeenCalledWith(expect.objectContaining({ workerPermissionMode: 'bypassPermissions' }), expect.any(Function), expect.any(Function));
  });
});
