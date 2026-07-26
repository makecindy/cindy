import type { AgentKind } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildNoProviderMessage,
  createOrcaWorkerCreationService,
  type OrcaWorkerCreationDeps,
  type OrcaWorkerProviderRoutingContext,
  type OrcaWorkerProviderSnapshot,
} from '../orcaWorkerCreationService';
import type { DispatchWorkerTaskResult, OrcaWorkerStatus } from '../orcaTeamService';
import type { MakerSessionCreateOpts } from '../sessionRequest';
import { CredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';
import { isActiveWorkerStatus } from '../../../shared/orca-worker-status';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function providerRoutingContext(
  availability: Record<AgentKind, OrcaWorkerProviderSnapshot[]>,
): OrcaWorkerProviderRoutingContext {
  return {
    availability,
    resolveDefaultProviderIdForModel: (agent, model) => (
      availability[agent].find((provider) => provider.models.includes(model))?.id ?? null
    ),
  };
}

function createDeps(overrides: Partial<OrcaWorkerCreationDeps> = {}) {
  const calls: string[] = [];
  const ids = ['worker-1'];
  const reservations = new Set<string>();
  const deps: OrcaWorkerCreationDeps = {
    getActiveTeamByLead: vi.fn(async (leadSessionId) => (
      leadSessionId === 'lead-1' ? { id: 'team-1', leadSessionId: 'lead-1' } : null
    )),
    listWorkersByLead: vi.fn(async () => []),
    isActiveWorkerStatus: vi.fn(isActiveWorkerStatus),
    readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 3, workerHardLimit: 5 })),
    getLeadSessionRow: vi.fn(async () => ({
      id: 'lead-1',
      agentKind: 'codex' as const,
      workingDir: 'C:\\repo',
      model: 'gpt-5.5',
      effort: 'medium',
      permissionMode: 'default',
      fastMode: false,
      providerId: 'xd',
    })),
    getWorkerDefaults: vi.fn(() => ({})),
    getAvailableModels: vi.fn((agent: AgentKind) => (
      agent === 'codex'
        ? [
            { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'gpt-5.4-mini', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
            { id: 'codex/budget', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
          ]
        : [{ id: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }]
    )),
    getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
      'claude-code': [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
      codex: [{
        id: 'xd',
        name: 'XD Gateway',
        models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/budget', 'gpt-no-fast'],
      }],
    })),
    readClaudeApiKey: vi.fn((): string | null => 'sk-test'),
    reserveWorkerCreation: vi.fn(async ({ label }) => {
      const canonical = label.toLowerCase();
      if (reservations.has(canonical)) {
        return { ok: false as const, errorCode: 'WORKER_CREATION_IN_PROGRESS' as const };
      }
      reservations.add(canonical);
      return { ok: true as const, occupiedSlotsBefore: 0 };
    }),
    renewWorkerCreationReservation: vi.fn(async () => true),
    releaseWorkerCreationReservation: vi.fn(async () => undefined),
    createId: vi.fn(() => ids.shift() ?? `id-${ids.length}`),
    createSessionId: vi.fn(() => WORKER_SESSION_ID),
    buildCreateOptsWithStderr: vi.fn((opts: MakerSessionCreateOpts) => opts),
    bootstrapSession: vi.fn(async (opts: MakerSessionCreateOpts) => {
      calls.push(`bootstrapSession:${opts.id}`);
      return {
        session: {
          id: opts.id ?? WORKER_SESSION_ID,
          agentKind: opts.agentKind,
        },
        didInjectOrcaInstructions: true,
        didInjectProjectContext: false,
      };
    }),
    addOrUpdateWorker: vi.fn(async (worker) => {
      calls.push(`addOrUpdateWorker:${worker.id}`);
    }),
    markOrcaRoleIfNeeded: vi.fn(async (sessionId, role) => {
      calls.push(`markOrcaRoleIfNeeded:${sessionId}:${role}`);
    }),
    dispatchWorkerTask: vi.fn(async (params) => {
      calls.push(`dispatchWorkerTask:${params.targetSessionId}`);
      return {
        dispatched: true,
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
    broadcastSessionCreated: vi.fn((sessionId) => {
      calls.push(`broadcastSessionCreated:${sessionId}`);
    }),
    broadcastOrcaWorkerChanged: vi.fn((leadSessionId) => {
      calls.push(`broadcastOrcaWorkerChanged:${leadSessionId}`);
    }),
    closeWorkerSession: vi.fn(async (sessionId) => {
      calls.push(`closeWorkerSession:${sessionId}`);
    }),
    archiveWorkerSession: vi.fn(async (sessionId) => {
      calls.push(`archiveWorkerSession:${sessionId}`);
    }),
    forgetWorkerSession: vi.fn((sessionId) => {
      calls.push(`forgetWorkerSession:${sessionId}`);
    }),
    removeWorker: vi.fn(async (workerId) => {
      calls.push(`removeWorker:${workerId}`);
    }),
    ...overrides,
  };
  return {
    calls,
    deps,
    service: createOrcaWorkerCreationService(deps),
  };
}

describe('OrcaWorkerCreationService', () => {
  const workerStatus = (status: OrcaWorkerStatus): OrcaWorkerStatus => status;

  it('returns NOT_FOUND without side effects when the lead has no active team', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'missing-lead',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'NOT_FOUND',
      message: 'no active team for this lead',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects duplicate labels before bootstrapping a worker session', async () => {
    const { deps, service } = createDeps({
      listWorkersByLead: vi.fn(async () => [{ id: 'worker-existing', label: 'reviewer', status: workerStatus('idle') }]),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'DUPLICATE_LABEL',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects labels outside the shared worker label contract before reading worker slots', async () => {
    for (const label of ['bad label', '中文', 'x'.repeat(33)]) {
      const { deps, service } = createDeps();

      await expect(
        service.createWorker({
          leadSessionId: 'lead-1',
          role: 'reviewer',
          agent: 'codex',
          label,
        }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: 'INVALID_PARAMS',
      });

      expect(deps.listWorkersByLead).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
      expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
      expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
    }
  });

  it('persists trimmed worker labels after validating the shared label contract', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: ' Reviewer_1 ',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        label: 'reviewer_1',
      },
    });

    expect(deps.addOrUpdateWorker).toHaveBeenCalledWith(expect.objectContaining({
      label: 'reviewer_1',
    }));
  });

  it('allows only one full create lifecycle for concurrent case-insensitive labels', async () => {
    const { deps, service } = createDeps();
    const results = await Promise.all([
      service.createWorker({ leadSessionId: 'lead-1', role: 'tester', agent: 'codex', label: 'tester' }),
      service.createWorker({ leadSessionId: 'lead-1', role: 'tester', agent: 'codex', label: 'TESTER' }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.errorCode === 'WORKER_CREATION_IN_PROGRESS')).toHaveLength(1);
    expect(deps.bootstrapSession).toHaveBeenCalledTimes(1);
    expect(deps.addOrUpdateWorker).toHaveBeenCalledTimes(1);
    expect(deps.markOrcaRoleIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('counts terminal workers toward the hard limit before any creation side effects', async () => {
    const { deps, service } = createDeps({
      readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 2, workerHardLimit: 4 })),
      listWorkersByLead: vi.fn(async () => [
        { id: 'worker-1', label: 'one', status: workerStatus('idle') },
        { id: 'worker-2', label: 'two', status: workerStatus('running') },
        { id: 'worker-3', label: 'three', status: workerStatus('done') },
        { id: 'worker-4', label: 'four', status: workerStatus('error') },
      ]),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
      limit: {
        workerHardLimit: 4,
        occupiedSlots: 4,
        remainingSlots: 0,
      },
    });

    expect(deps.getAvailableModels).not.toHaveBeenCalled();
    expect(deps.getProviderRoutingContext).not.toHaveBeenCalled();
    expect(deps.getLeadSessionRow).not.toHaveBeenCalled();
    expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('returns a hard-limit snapshot when the atomic reservation loses a concurrent slot race', async () => {
    const { deps, service } = createDeps({
      readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 2, workerHardLimit: 3 })),
      reserveWorkerCreation: vi.fn(async () => ({
        ok: false as const,
        errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' as const,
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
      limit: {
        workerHardLimit: 3,
        occupiedSlots: 3,
        remainingSlots: 0,
      },
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('rejects unavailable explicit models before reading lead defaults', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-unknown',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('gpt-unknown'),
    });

    expect(deps.getLeadSessionRow).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('rejects worker creation when the target agent has no connected provider, suggesting another agent', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
        codex: [],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'NO_PROVIDER_FOR_AGENT',
      message: expect.stringContaining('Claude Code'),
    });

    expect(deps.getLeadSessionRow).not.toHaveBeenCalled();
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('rejects worker creation when no agent has a connected provider, without an agent suggestion', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({ 'claude-code': [], codex: [] })),
    });

    const result = await service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'NO_PROVIDER_FOR_AGENT' });
    if (!result.ok) {
      expect(result.message).toContain('设置 → 模型供应商');
      expect(result.message).not.toContain('改用');
    }

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND when the lead session row is missing', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => null),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
      message: 'lead session lead-1 not found',
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('rejects a budget Codex model when no api key is configured', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'codex/budget', providerId: null })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: expect.stringContaining('codex/budget'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('returns the budget-model error before explicit route fallback when the api key is missing', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5', providerId: 'openai' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'openai', name: 'OpenAI', models: ['gpt-5.5'] }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'codex/budget',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: expect.stringContaining('codex/budget'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('returns the budget-model error for an XD-routed default when another provider is connected', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'codex/budget', providerId: 'xd' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'openai', name: 'OpenAI', models: ['gpt-5.5'] }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
      message: expect.stringContaining('codex/budget'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('rejects explicit minimal effort for a Codex GPT worker at the creation boundary', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-5.4-mini',
        effort: 'minimal',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('minimal'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('normalizes inherited minimal effort from worker defaults to low for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'minimal', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'low',
    }));
  });

  it('normalizes inherited minimal effort from the lead session to low for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workingDir: 'C:\\repo',
        model: 'gpt-5.4-mini',
        effort: 'minimal',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'xd',
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'low',
    }));
  });

  it('normalizes inherited max effort to xhigh when the selected model uses Codex effort names', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'max', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'xhigh',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'xhigh',
    }));
  });

  it('cascades inherited ultra effort down to xhigh when the model tops out at xhigh (issue #352)', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'ultra', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        // ultra 无对应档 → 级联到最高兼容档 xhigh,而不是掉回 defaultEffort(high)。
        effort: 'xhigh',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'xhigh',
    }));
  });

  it('rejects explicit max effort when the selected Codex model only supports xhigh', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-5.4-mini',
        effort: 'max',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('max'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('rejects explicit minimal effort for a Claude Code worker at the creation boundary', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'claude-code',
        label: 'reviewer',
        model: 'claude-sonnet-4-6',
        effort: 'minimal',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('minimal'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
  });

  it('normalizes inherited minimal effort to low for a Claude Code worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'claude-sonnet-4-6', effort: 'minimal' })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'claude-code',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'claude-sonnet-4-6',
        effort: 'low',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-6',
      effort: 'low',
    }));
  });

  it('disables fast mode when the selected model capability does not support it', async () => {
    const { deps, service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'codex'
          ? [{ id: 'gpt-no-fast', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium', supportsFastMode: false }]
          : [{ id: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }]
      )),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'gpt-no-fast',
        fast: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-no-fast',
        fastMode: false,
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-no-fast',
      fastMode: false,
    }));
  });

  it('keeps medium effort for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4-mini', effort: 'medium', fastMode: false })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'medium',
    }));
  });

  it('creates a worker with resolved defaults without dispatching or broadcasting from the creation boundary', async () => {
    const { calls, deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({
        model: 'gpt-5.4',
        effort: 'high',
        fastMode: true,
        providerId: 'xd',
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      teamId: 'team-1',
      workerId: 'worker-1',
      workerSessionId: WORKER_SESSION_ID,
      softLimitExceeded: false,
      limit: {
        workerHardLimit: 5,
        occupiedSlots: 1,
        remainingSlots: 4,
      },
    });

    expect(deps.createSessionId).toHaveBeenCalledTimes(1);
    expect(WORKER_SESSION_ID).toMatch(UUID_V4_RE);
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      id: WORKER_SESSION_ID,
      agentKind: 'codex',
      workingDir: 'C:\\repo',
      model: 'gpt-5.4',
      providerId: 'xd',
      effort: 'high',
      fastMode: true,
      permissionMode: 'bypassPermissions',
      title: 'Worker · reviewer · reviewer',
      orcaRole: 'worker',
      vendorOptions: expect.objectContaining({
        orcaRole: 'worker',
        orcaWorkflowId: 'team-1',
        orcaLeadSessionId: 'lead-1',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: WORKER_SESSION_ID,
      }),
    }));
    expect(deps.addOrUpdateWorker).toHaveBeenCalledWith(expect.objectContaining({
      id: 'worker-1',
      teamId: 'team-1',
      sessionId: WORKER_SESSION_ID,
      status: 'idle',
      label: 'reviewer',
      role: 'reviewer',
      focused: false,
    }));
    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:worker-1',
      `markOrcaRoleIfNeeded:${WORKER_SESSION_ID}:worker`,
    ]);
  });

  it('inherits the target-agent New Maker provider and persists it on the worker session', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({
        model: 'codex/budget',
        effort: 'high',
        fastMode: false,
        providerId: 'custom-codex',
      })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'custom-codex', name: 'Custom Codex', models: ['codex/budget'] }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom-codex', model: 'codex/budget' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'custom-codex',
      model: 'codex/budget',
    }));
  });

  it('falls back from a stale New Maker provider to the current native default route', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4', providerId: 'deleted-custom' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'xd', name: 'XD Gateway', models: ['gpt-5.4'] }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: null, model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: null,
      model: 'gpt-5.4',
    }));
  });

  it('falls back from a stale New Maker provider to a sole custom credential route', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4', providerId: 'deleted-custom' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'current-custom',
          name: 'Current Custom',
          models: ['gpt-5.4'],
          requiresExplicitRoute: true,
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'current-custom', model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'current-custom',
      model: 'gpt-5.4',
    }));
  });

  it('falls back to the Lead provider for a same-agent worker when older defaults omit providerId', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5' })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'xd', model: 'gpt-5.5' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'xd',
    }));
  });

  it('keeps the default route while validating connected sources when only the worker model is explicit', async () => {
    const availability = {
      'claude-code': [],
      codex: [
        { id: 'custom-codex', name: 'Custom Codex', models: ['gpt-5.5'] },
        { id: 'xd', name: 'XD Gateway', models: ['gpt-5.4'] },
      ],
    } satisfies Record<AgentKind, OrcaWorkerProviderSnapshot[]>;
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5', providerId: 'custom-codex' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext(availability)),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.4',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: null, model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: null,
      model: 'gpt-5.4',
    }));
  });

  it('persists the sole custom route when an explicit worker model requires session credentials', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5', providerId: 'xd' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'custom-codex',
          name: 'Custom Codex',
          models: ['gpt-5.4'],
          requiresExplicitRoute: true,
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.4',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom-codex', model: 'gpt-5.4' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'custom-codex',
      model: 'gpt-5.4',
    }));
  });

  it('does not require a Cindy API key for an explicit budget model on a custom route', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'custom-codex',
          name: 'Custom Codex',
          models: ['codex/budget'],
          requiresExplicitRoute: true,
        }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'codex/budget',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom-codex', model: 'codex/budget' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'custom-codex',
      model: 'codex/budget',
    }));
  });

  it('returns a route-specific error when no connected provider offers an explicit worker model', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.5', providerId: 'custom-codex' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'custom-codex', name: 'Custom Codex', models: ['gpt-5.5'] }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.4',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: expect.stringContaining('没有已连接的供应商提供模型 "gpt-5.4"'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('rejects a stale cached provider when no current source offers its model', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4', providerId: 'custom-codex' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'custom-codex', name: 'Custom Codex', models: ['gpt-5.5'] }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
      message: expect.stringContaining('没有已连接的供应商提供模型 "gpt-5.4"'),
    });

    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('reports soft-limit overflow while still creating the worker', async () => {
    const { deps, service } = createDeps({
      readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 1, workerHardLimit: 3 })),
      listWorkersByLead: vi.fn(async () => [{ id: 'worker-existing', label: 'existing', status: workerStatus('idle') }]),
      reserveWorkerCreation: vi.fn(async () => ({ ok: true as const, occupiedSlotsBefore: 1 })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: true,
      softLimitExceeded: true,
    });

    expect(deps.bootstrapSession).toHaveBeenCalledTimes(1);
    expect(deps.addOrUpdateWorker).toHaveBeenCalledTimes(1);
  });

  it('maps credential busy during worker bootstrap to BUSY without creating a worker row', async () => {
    const { deps, service } = createDeps({
      bootstrapSession: vi.fn(async () => {
        throw new CredentialModeSwitchBusyError(['busy-session']);
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'BUSY',
    });

    expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    expect(deps.markOrcaRoleIfNeeded).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('archives a bootstrapped worker session when persistence fails', async () => {
    const { calls, deps, service } = createDeps({
      addOrUpdateWorker: vi.fn(async () => {
        calls.push('addOrUpdateWorker:throw');
        throw new Error('insert failed');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'insert failed',
    });

    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:throw',
      `closeWorkerSession:${WORKER_SESSION_ID}`,
      `forgetWorkerSession:${WORKER_SESSION_ID}`,
      `archiveWorkerSession:${WORKER_SESSION_ID}`,
    ]);
    expect(deps.markOrcaRoleIfNeeded).not.toHaveBeenCalled();
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });

  it('recognizes SQLite expression-index conflicts regardless of quote style', async () => {
    const { deps, service } = createDeps({
      addOrUpdateWorker: vi.fn(async () => {
        throw new Error("UNIQUE constraint failed: index 'uniq_orca_workers_team_label'");
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'DUPLICATE_LABEL',
    });

    expect(deps.archiveWorkerSession).toHaveBeenCalledWith(WORKER_SESSION_ID);
  });

  it('removes the worker link when role marking fails after persistence', async () => {
    const { calls, deps, service } = createDeps({
      markOrcaRoleIfNeeded: vi.fn(async () => {
        calls.push('markOrcaRoleIfNeeded:throw');
        throw new Error('role failed');
      }),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'role failed',
    });

    expect(calls).toEqual([
      `bootstrapSession:${WORKER_SESSION_ID}`,
      'addOrUpdateWorker:worker-1',
      'markOrcaRoleIfNeeded:throw',
      `closeWorkerSession:${WORKER_SESSION_ID}`,
      `forgetWorkerSession:${WORKER_SESSION_ID}`,
      `archiveWorkerSession:${WORKER_SESSION_ID}`,
      'removeWorker:worker-1',
    ]);
    expect(deps.dispatchWorkerTask).not.toHaveBeenCalled();
  });
});

describe('buildNoProviderMessage', () => {
  it('suggests the other agent when it has a connected provider', () => {
    const msg = buildNoProviderMessage('codex', {
      'claude-code': [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
      codex: [],
    });
    expect(msg).toContain('Codex 当前没有可用的模型供应商');
    expect(msg).toContain('改用');
    expect(msg).toContain('Claude Code(已连接:XD Gateway)');
  });

  it('omits the agent suggestion when no agent has a connected provider', () => {
    const msg = buildNoProviderMessage('claude-code', { 'claude-code': [], codex: [] });
    expect(msg).toContain('Claude Code 当前没有可用的模型供应商');
    expect(msg).toContain('设置 → 模型供应商');
    expect(msg).not.toContain('改用');
  });

  it('honors an explicit panel-selected provider over the forced default route', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] },
          { id: 'openai', name: 'OpenAI', models: ['gpt-5.5'] },
        ],
      })),
    });

    // 显式 model 且未显式来源时既有语义是强制默认路由(providerId=null);
    // 标准面板显式选定来源后必须原样生效,不再被强制回落。
    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'openai',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'openai', model: 'gpt-5.5' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'openai',
      model: 'gpt-5.5',
    }));
  });

  it('treats an empty-string providerId as not-explicit and keeps the forced default route', async () => {
    const { service } = createDeps();

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: '',
    })).resolves.toMatchObject({
      ok: true,
      // 与「显式 model 未显式来源」同语义:providerId 强制默认路由,不进显式 preflight。
      resolved: { providerId: null, model: 'gpt-5.5' },
    });
  });

  it('resolves Fast from the explicit provider catalog entry, not the flattened union', async () => {
    // gpt-5.5 在 xd(拍平清单首来源,不支持 Fast)与 openai(支持)都有:显式选 openai
    // 时 Fast 必须按 openai 自己的条目放行,不被拍平首来源误杀;反向显式选 xd 时压掉。
    const routing = () => providerRoutingContext({
      'claude-code': [],
      codex: [
        { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'], fastModels: [] },
        { id: 'openai', name: 'OpenAI', models: ['gpt-5.5'], fastModels: ['gpt-5.5'] },
      ],
    });
    const supportsFastByUnion = (supported: boolean) => vi.fn((agent: AgentKind) => (
      agent === 'codex'
        ? [{ id: 'gpt-5.5', efforts: ['high'], defaultEffort: 'high', supportsFastMode: supported }]
        : []
    ));

    const enabled = createDeps({
      getProviderRoutingContext: vi.fn(async () => routing()),
      // 拍平清单说不支持(首来源 xd wins)——显式 openai 仍应放行。
      getAvailableModels: supportsFastByUnion(false),
    });
    await expect(enabled.service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'openai',
      fast: true,
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'openai', fastMode: true },
    });

    const suppressed = createDeps({
      getProviderRoutingContext: vi.fn(async () => routing()),
      // 拍平清单说支持(假设首来源换位)——显式 xd 不支持,必须压掉。
      getAvailableModels: supportsFastByUnion(true),
    });
    await expect(suppressed.service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'xd',
      fast: true,
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'xd', fastMode: false },
    });
  });

  it('normalizes effort against the explicit provider catalog entry, not the flattened union', async () => {
    // gpt-5.5 的拍平首见条目只有 medium 档,而显式来源 openai 的同 id 条目支持
    // low/medium/high:explicit effort=high 必须按 openai 自己的元数据放行,不被
    // 拍平条目在 resolveWorkerConfig 内 error 早退误拒(codex review)。
    const { service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'codex'
          ? [{ id: 'gpt-5.5', efforts: ['medium'], defaultEffort: 'medium', supportsFastMode: false }]
          : []
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] },
          {
            id: 'openai',
            name: 'OpenAI',
            models: ['gpt-5.5'],
            effortMetaByModel: {
              'gpt-5.5': { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
            },
          },
        ],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'openai', effort: 'high' },
    });
  });

  it('rejects efforts the explicit no-effort provider copy does not support and defaults to null', async () => {
    // 自定义来源的 gpt-5.5 副本无 effort 档(efforts:[]):explicit effort 必须按该
    // 来源条目拒绝,不能沿用拍平首见条目的档位表放行;非显式输入则落该来源的
    // defaultEffort(null),不带着拍平归一出的档位派发(codex review)。
    const routing = () => providerRoutingContext({
      'claude-code': [],
      codex: [
        { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/budget'] },
        {
          id: 'custom',
          name: 'Custom Gateway',
          models: ['gpt-5.5'],
          effortMetaByModel: { 'gpt-5.5': { efforts: [], defaultEffort: null } },
        },
      ],
    });

    const rejected = createDeps({ getProviderRoutingContext: vi.fn(async () => routing()) });
    await expect(rejected.service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'custom',
      effort: 'high',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
    });

    const defaulted = createDeps({ getProviderRoutingContext: vi.fn(async () => routing()) });
    await expect(defaulted.service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'custom',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom', effort: null },
    });
  });

  it('allows an explicit effort the flattened descriptor lacks when the route provider supports it', async () => {
    // 拍平首见条目(可能来自已断开来源,不含连接态)缺 xhigh,而实际路由来源
    // (未显式时的生效默认来源)支持:explicit effort 不得在首次归一处 error 早退,
    // 暂存后由路由来源档位表裁决放行(codex review)。
    const { service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'codex'
          ? [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false }]
          : []
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'xd',
          name: 'XD Gateway',
          models: ['gpt-5.5'],
          effortMetaByModel: {
            'gpt-5.5': { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
          },
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      effort: 'xhigh',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { model: 'gpt-5.5', effort: 'xhigh' },
    });
  });

  it('surfaces the flattened rejection when the route provider carries no effort metadata', async () => {
    // 路由来源无 effort 元数据(旧组装方)时没有更权威的档位表:explicit 无效输入
    // 的暂存拒绝按拍平条目落地,不静默吞掉派发 null(行为与重构前一致)。
    const { service } = createDeps();

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      effort: 'ultra',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
    });
  });

  it('renormalizes effort against the default route provider when no explicit source is set', async () => {
    // 未显式选来源时实际路由来源是 lead/defaults 解析出的 xd:其 gpt-5.5 条目只有
    // low 档,lead effort=medium 按拍平条目(四档)归一原样通过,必须再按路由来源
    // 条目重归一落到该来源的 defaultEffort(codex review;与 Fast 的路由来源口径一致)。
    const { service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{
          id: 'xd',
          name: 'XD Gateway',
          models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex/budget'],
          effortMetaByModel: { 'gpt-5.5': { efforts: ['low'], defaultEffort: 'low' } },
        }],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { model: 'gpt-5.5', effort: 'low' },
    });
  });

  it('rejects an explicit provider that does not offer the requested model', async () => {
    const { deps, service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] },
          { id: 'openai', name: 'OpenAI', models: ['gpt-5.4'] },
        ],
      })),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'gpt-5.5',
      providerId: 'openai',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
    });
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });

  it('does not demand the gateway API key for a budget model on an explicit non-gateway route', async () => {
    const { service } = createDeps({
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'custom-codex', name: 'Custom Codex', models: ['codex/budget'] }],
      })),
      readClaudeApiKey: vi.fn((): string | null => null),
    });

    await expect(service.createWorker({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      model: 'codex/budget',
      providerId: 'custom-codex',
    })).resolves.toMatchObject({
      ok: true,
      resolved: { providerId: 'custom-codex', model: 'codex/budget' },
    });
  });
});
