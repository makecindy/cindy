import type { AgentKind } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildNoProviderMessage,
  createOrcaWorkerCreationService,
  providerRouteRequiresExplicitSelection,
  type OrcaWorkerCreationDeps,
  type OrcaWorkerCreateParams,
  type OrcaWorkerModelCapabilities,
  type OrcaWorkerProviderRoutingContext,
  type OrcaWorkerProviderSnapshot,
} from '../orcaWorkerCreationService';
import type { DispatchWorkerTaskResult, OrcaWorkerStatus } from '../orcaTeamService';
import type { MakerSessionCreateOpts } from '../sessionRequest';
import { CredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch';
import { isActiveWorkerStatus } from '../../../shared/orca-worker-status';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('buildNoProviderMessage (pi first-class)', () => {
  const snap = (name: string): OrcaWorkerProviderSnapshot => ({ name }) as OrcaWorkerProviderSnapshot;
  it('names Pi (not Claude Code) when pi has no connected provider', () => {
    const msg = buildNoProviderMessage('pi', { 'claude-code': [], codex: [], pi: [] });
    expect(msg).toContain('Pi 当前没有可用的模型供应商');
    expect(msg).not.toContain('Claude Code 当前没有');
  });
  it('suggests pi as a fallback agent when pi alone has a connected provider', () => {
    const msg = buildNoProviderMessage('codex', {
      'claude-code': [],
      codex: [],
      pi: [snap('Cindy AI')],
    });
    expect(msg).toContain('Pi(已连接:Cindy AI)');
  });
});

describe('providerRouteRequiresExplicitSelection', () => {
  it.each(['api-key-header', 'oauth-token', 'none'] as const)(
    'keeps %s routes pinned to the selected provider',
    (strategy) => {
      expect(providerRouteRequiresExplicitSelection(strategy)).toBe(true);
    },
  );

  it.each(['oauth-passthrough', 'provider-oauth-header', 'gateway-key', undefined] as const)(
    'does not force an explicit route for %s',
    (strategy) => {
      expect(providerRouteRequiresExplicitSelection(strategy)).toBe(false);
    },
  );
});

function providerRoutingContext(
  partial: Partial<Record<AgentKind, OrcaWorkerProviderSnapshot[]>>,
): OrcaWorkerProviderRoutingContext {
  const availability: Record<AgentKind, OrcaWorkerProviderSnapshot[]> = {
    'claude-code': partial['claude-code'] ?? [],
    codex: partial.codex ?? [],
    pi: partial.pi ?? [],
  };
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
      leadSessionId === 'lead-1'
        ? { id: 'team-1', leadSessionId: 'lead-1' }
        : null
    )),
    listWorkersByLead: vi.fn(async () => []),
    isActiveWorkerStatus: vi.fn(isActiveWorkerStatus),
    readCollaborationSettings: vi.fn(() => ({ workerSoftLimit: 3, workerHardLimit: 5 })),
    getLeadSessionRow: vi.fn(async () => ({
      id: 'lead-1',
      agentKind: 'codex' as const,
      workspaceKind: 'project' as const,
      workingDir: 'C:\\repo',
      model: 'gpt-5.5',
      effort: 'medium',
      permissionMode: 'default',
      fastMode: false,
      providerId: 'xd',
      remoteHostId: null,
    })),
    getWorkerDefaults: vi.fn(() => ({})),
    getWorkerPermissionMode: vi.fn(() => 'auto' as const),
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

  it('runs the remote ensure before bootstrap for a remote lead, and skips it for a local lead', async () => {
    // codex-1/orca-2 回归:remote lead 的 worker 继承 remoteHostId, 创建前必须
    // 走 SSH 重连 / agent 安装 / codex daemon MCP 注入的 ensure, 否则远端
    // 协同 MCP 通道不就绪。
    const order: string[] = [];
    const ensureRemoteReadyForSessionStart = vi.fn(async () => {
      order.push('ensure');
    });
    const remoteLeadRow = {
      id: 'lead-1',
      agentKind: 'codex' as const,
      workspaceKind: 'project' as const,
      workingDir: '/srv/repo',
      model: 'gpt-5.5',
      effort: 'medium',
      permissionMode: 'default',
      fastMode: false,
      providerId: 'xd',
      remoteHostId: 'host-remote-1',
    };
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
      ensureRemoteReadyForSessionStart,
      bootstrapSession: vi.fn(async (opts: MakerSessionCreateOpts) => {
        order.push('bootstrap');
        return {
          session: { id: opts.id ?? WORKER_SESSION_ID, agentKind: opts.agentKind },
          didInjectOrcaInstructions: true,
          didInjectProjectContext: false,
        };
      }),
    });

    await expect(
      service.createWorker({ leadSessionId: 'lead-1', role: 'reviewer', agent: 'codex', label: 'reviewer' }),
    ).resolves.toMatchObject({ ok: true });

    expect(ensureRemoteReadyForSessionStart).toHaveBeenCalledTimes(1);
    expect(ensureRemoteReadyForSessionStart).toHaveBeenCalledWith({
      createOpts: expect.objectContaining({ remoteHostId: 'host-remote-1' }),
    });
    expect(order.slice(0, 2)).toEqual(['ensure', 'bootstrap']);

    // 本地 lead: 不调 ensure。
    const local = createDeps();
    await expect(
      local.service.createWorker({ leadSessionId: 'lead-1', role: 'reviewer', agent: 'codex', label: 'reviewer' }),
    ).resolves.toMatchObject({ ok: true });
    expect(local.deps.ensureRemoteReadyForSessionStart).toBeUndefined();
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

  describe('provider-aware managed model aliases', () => {
    const shortId = 'deepseek-v4-flash';
    const canonicalId = 'deepseek/deepseek-v4-flash';
    const shortModelCapabilities: OrcaWorkerModelCapabilities = {
      id: shortId,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
      supportsFastMode: false,
    };
    const canonicalModelCapabilities: OrcaWorkerModelCapabilities = {
      id: canonicalId,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
      supportsFastMode: false,
    };
    const modelCapabilities: OrcaWorkerModelCapabilities[] = [
      shortModelCapabilities,
      canonicalModelCapabilities,
    ];

    const managedProvider = (
      models: string[] = [canonicalId],
      registryIdentityByModel: Readonly<Record<string, string>> = Object.fromEntries(
        models.map((model) => [model, model]),
      ),
    ): OrcaWorkerProviderSnapshot => ({
      id: 'xd',
      name: 'Cindy AI',
      models,
      registryIdentityByModel,
    });
    const customProvider = (models: string[] = [shortId]): OrcaWorkerProviderSnapshot => ({
      id: 'deepseek',
      name: 'DeepSeek',
      models,
      requiresExplicitRoute: true,
    });
    const workerParams = (
      overrides: Partial<OrcaWorkerCreateParams> = {},
    ): OrcaWorkerCreateParams => ({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer',
      ...overrides,
    });
    const leadWithLegacyModel = (providerId: string | null) => ({
      id: 'lead-1',
      agentKind: 'codex' as const,
      workspaceKind: 'project' as const,
      workingDir: 'C:\\repo',
      model: shortId,
      effort: 'high',
      permissionMode: 'default',
      fastMode: false,
      providerId,
      remoteHostId: null,
    });
    const aliasHarness = (options: {
      agent?: AgentKind;
      providers?: OrcaWorkerProviderSnapshot[];
      availableModels?: OrcaWorkerModelCapabilities[];
      overrides?: Partial<OrcaWorkerCreationDeps>;
    } = {}) => {
      const agent = options.agent ?? 'codex';
      return createDeps({
        getAvailableModels: vi.fn(() => options.availableModels ?? modelCapabilities),
        getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
          [agent]: options.providers ?? [managedProvider()],
        })),
        ...options.overrides,
      });
    };
    const expectNoCreationState = (deps: OrcaWorkerCreationDeps): void => {
      expect(deps.reserveWorkerCreation).not.toHaveBeenCalled();
      expect(deps.bootstrapSession).not.toHaveBeenCalled();
      expect(deps.addOrUpdateWorker).not.toHaveBeenCalled();
    };

    it('keeps an exact managed canonical ID unchanged', async () => {
      const { deps, service } = aliasHarness();

      await expect(service.createWorker(workerParams({
        model: canonicalId,
      }))).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId },
      });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
      }));
    });

    it.each(['codex', 'claude-code'] as const)(
      'maps a unique short ID to the managed canonical ID for %s workers',
      async (agent) => {
        const { deps, service } = aliasHarness({
          agent,
          // Gateway capabilities only advertise the managed canonical ID in the real regression.
          availableModels: [canonicalModelCapabilities],
        });

        await expect(service.createWorker(workerParams({
          agent,
          model: shortId,
        }))).resolves.toMatchObject({
          ok: true,
          resolved: { model: canonicalId },
        });

        expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
          agentKind: agent,
          model: canonicalId,
        }));
      },
    );

    it('keeps a Custom Provider short ID unchanged', async () => {
      const { deps, service } = aliasHarness({
        providers: [managedProvider(), customProvider()],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
        providerId: 'deepseek',
      }))).resolves.toMatchObject({
        ok: true,
        resolved: { model: shortId, providerId: 'deepseek' },
      });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: shortId,
        providerId: 'deepseek',
      }));
    });

    it('prefers an exact connected short ID over a managed alias candidate', async () => {
      const { deps, service } = aliasHarness({
        providers: [managedProvider(), customProvider()],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
      }))).resolves.toMatchObject({
        ok: true,
        resolved: { model: shortId, providerId: 'deepseek' },
      });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: shortId,
        providerId: 'deepseek',
      }));
    });

    it('rejects ambiguous managed canonical candidates before creating state', async () => {
      const otherCanonicalId = `mirror/${shortId}`;
      const { deps, service } = aliasHarness({
        providers: [managedProvider([canonicalId, otherCanonicalId])],
        availableModels: [
          ...modelCapabilities,
          { id: otherCanonicalId, efforts: ['high'], defaultEffort: 'high' },
        ],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
      }))).resolves.toMatchObject({
        ok: false,
        errorCode: 'INVALID_PARAMS',
        message: expect.stringContaining('ambiguous'),
      });

      expectNoCreationState(deps);
    });

    it('rejects a unique managed suffix candidate with a different catalog identity', async () => {
      const standardId = 'gpt-5.5';
      const budgetId = 'codex/gpt-5.5';
      const { deps, service } = aliasHarness({
        providers: [managedProvider(
          [budgetId],
          { [budgetId]: 'xd/codex-gpt-5.5' },
        )],
        availableModels: [
          { id: standardId, efforts: ['high'], defaultEffort: 'high' },
          { id: budgetId, efforts: ['high'], defaultEffort: 'high' },
        ],
      });

      await expect(service.createWorker(workerParams({
        model: standardId,
        providerId: 'xd',
      }))).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: expect.stringContaining(`"${standardId}"`),
      });

      expectNoCreationState(deps);
    });

    it('fails closed when an explicit non-managed provider has no exact short ID', async () => {
      const custom = { ...customProvider(['another-model']), id: 'custom', name: 'Custom' };
      const { deps, service } = aliasHarness({
        providers: [managedProvider(), custom],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
        providerId: 'custom',
      }))).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: expect.stringContaining('Custom'),
      });

      expectNoCreationState(deps);
    });

    it('does not map a managed candidate that is absent from list_available_models capabilities', async () => {
      const { deps, service } = aliasHarness({
        // list_available_models consumes this capabilities list; the resolver must not create
        // a route to a canonical ID that the same host snapshot does not advertise.
        availableModels: [modelCapabilities[0]],
      });

      await expect(service.createWorker(workerParams({
        model: shortId,
        providerId: 'xd',
      }))).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: expect.stringContaining('Cindy AI'),
      });

      expectNoCreationState(deps);
    });

    it('resolves a legacy persisted Lead model in memory without rewriting the Lead row', async () => {
      const legacyLead = leadWithLegacyModel('xd');
      const { deps, service } = aliasHarness({
        overrides: { getLeadSessionRow: vi.fn(async () => legacyLead) },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId, providerId: 'xd' },
      });

      expect(legacyLead.model).toBe(shortId);
      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
        providerId: 'xd',
      }));
    });

    it('resolves an inherited legacy Worker default with the same rule as an explicit model', async () => {
      const legacyDefaults = { model: shortId, providerId: 'xd' };
      const { deps, service } = aliasHarness({
        overrides: { getWorkerDefaults: vi.fn(() => legacyDefaults) },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId, providerId: 'xd' },
      });

      expect(legacyDefaults.model).toBe(shortId);
      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
        providerId: 'xd',
      }));
    });

    it('falls back from a stale default route while canonicalizing its legacy short ID', async () => {
      const legacyDefaults = { model: shortId, providerId: 'deleted-custom' };
      const { deps, service } = aliasHarness({
        overrides: { getWorkerDefaults: vi.fn(() => legacyDefaults) },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId, providerId: null },
      });

      expect(legacyDefaults).toEqual({ model: shortId, providerId: 'deleted-custom' });
      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
        providerId: null,
      }));
    });

    it('ignores a stale provider-only default when resolving a legacy Lead short ID', async () => {
      const legacyLead = leadWithLegacyModel('xd');
      const providerOnlyDefaults = { providerId: 'deleted-custom' };
      const { deps, service } = aliasHarness({
        overrides: {
          getLeadSessionRow: vi.fn(async () => legacyLead),
          getWorkerDefaults: vi.fn(() => providerOnlyDefaults),
        },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: canonicalId, providerId: 'xd' },
      });

      expect(legacyLead.model).toBe(shortId);
      expect(providerOnlyDefaults).toEqual({ providerId: 'deleted-custom' });
      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: canonicalId,
        providerId: 'xd',
      }));
    });

    it('does not let a provider-only default override the paired Lead route when another provider offers the same model', async () => {
      const customLead = leadWithLegacyModel('deepseek');
      const otherCustom = {
        ...customProvider(),
        id: 'other-custom',
        name: 'Other Custom',
      };
      const { deps, service } = aliasHarness({
        // Default-route lookup would choose this first exact Custom route if the stale
        // provider-only default incorrectly triggered model route re-resolution.
        providers: [managedProvider(), otherCustom, customProvider()],
        overrides: {
          getLeadSessionRow: vi.fn(async () => customLead),
          getWorkerDefaults: vi.fn(() => ({ providerId: 'xd' })),
        },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: true,
        resolved: { model: shortId, providerId: 'deepseek' },
      });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        model: shortId,
        providerId: 'deepseek',
      }));
    });

    it('rejects a listed short ID when no connected provider can route it', async () => {
      const legacyLead = leadWithLegacyModel(null);
      const { deps, service } = aliasHarness({
        providers: [{ id: 'other', name: 'Other', models: ['other-model'] }],
        availableModels: [
          modelCapabilities[0],
          { id: 'other-model', efforts: ['high'], defaultEffort: 'high' },
        ],
        overrides: { getLeadSessionRow: vi.fn(async () => legacyLead) },
      });

      await expect(service.createWorker(workerParams())).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROVIDER_ROUTE_UNAVAILABLE',
        message: expect.stringContaining(`"${shortId}"`),
      });

      expectNoCreationState(deps);
    });
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

  it('inherits remoteHostId from a remote lead into the worker create opts', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'project' as const,
        workingDir: '/srv/repo',
        model: 'gpt-5.5',
        effort: 'medium',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'xd',
        remoteHostId: 'remote-host-1',
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });

    // remote lead 的 worker 必须在同一台远端主机 spawn,继承远端 workingDir。
    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      workingDir: '/srv/repo',
      remoteHostId: 'remote-host-1',
    }));
  });

  it('omits remoteHostId in worker create opts for a local lead', async () => {
    const { deps, service } = createDeps();

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });

    const arg = (deps.buildCreateOptsWithStderr as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect('remoteHostId' in arg).toBe(false);
  });

  it('inherits dialogue workspace identity and the managed cwd from its lead', async () => {
    const dialogueWorkingDir = '/app-managed/dialogues/2026-08-02/lead-1';
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'dialogue' as const,
        workingDir: dialogueWorkingDir,
        model: 'gpt-5.5',
        effort: 'medium',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'xd',
        remoteHostId: null,
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      workspaceKind: 'dialogue',
      workingDir: dialogueWorkingDir,
    }));
  });

  it('normalizes inherited minimal effort from the lead session to low for a Codex GPT worker', async () => {
    const { deps, service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'project' as const,
        workingDir: 'C:\\repo',
        model: 'gpt-5.4-mini',
        effort: 'minimal',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'xd',
        remoteHostId: null,
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

  it('honors an explicit fast request for a Pi worker on a fast-capable model', async () => {
    // Pi 也支持 Fast:显式 fast:true 必须被消费(此前两处判定只认 codex,静默丢弃)。
    // lead.fastMode 默认 false —— 若 pi 未接线,结果会退回 false,构成有效判别。
    const { deps, service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'pi'
          ? [{ id: 'pi-fast-model', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: true }]
          : [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true }]
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        pi: [{ id: 'xd', name: 'XD Gateway', models: ['pi-fast-model'], fastModels: ['pi-fast-model'] }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'pi',
        label: 'reviewer',
        model: 'pi-fast-model',
        fast: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'pi-fast-model',
        fastMode: true,
      },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'pi',
      model: 'pi-fast-model',
      fastMode: true,
    }));
  });

  it('drops an explicit fast request for a Pi worker when the model lacks Fast capability', async () => {
    const { service } = createDeps({
      getAvailableModels: vi.fn((agent: AgentKind) => (
        agent === 'pi'
          ? [{ id: 'pi-no-fast', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', supportsFastMode: false }]
          : [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true }]
      )),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        pi: [{ id: 'xd', name: 'XD Gateway', models: ['pi-no-fast'], fastModels: [] }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'pi',
        label: 'reviewer',
        model: 'pi-no-fast',
        fast: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      resolved: {
        model: 'pi-no-fast',
        fastMode: false,
      },
    });
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
      permissionMode: 'auto',
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

  it.each(
    (['auto', 'bypassPermissions'] as const).flatMap((workerPermissionMode) =>
      (['claude-code', 'codex', 'pi'] as const).map((workerAgent) => ({
        workerPermissionMode,
        workerAgent,
      })),
    ),
  )(
    'starts a $workerAgent Worker with the saved preference $workerPermissionMode',
    async ({ workerPermissionMode, workerAgent }) => {
      const workerModel = workerAgent === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6';
      const { deps, service } = createDeps({
        getWorkerPermissionMode: vi.fn(() => workerPermissionMode),
        getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
          'claude-code': [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
          codex: [{ id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] }],
          pi: [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
        })),
      });

      await expect(service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: workerAgent,
        label: 'reviewer',
        model: workerModel,
        providerId: 'xd',
      })).resolves.toMatchObject({ ok: true });

      expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
        agentKind: workerAgent,
        permissionMode: workerPermissionMode,
      }));
    },
  );

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

  it('keeps a model-only legacy default on the current native default route', async () => {
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
      resolved: { providerId: null, model: 'gpt-5.5' },
    });

    expect(deps.buildCreateOptsWithStderr).toHaveBeenCalledWith(expect.objectContaining({
      providerId: null,
    }));
  });

  it('routes a model-only legacy default through another connected provider', async () => {
    const { deps, service } = createDeps({
      getWorkerDefaults: vi.fn(() => ({ model: 'gpt-5.4' })),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [
          { id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] },
          {
            id: 'current-custom',
            name: 'Current Custom',
            models: ['gpt-5.4'],
            requiresExplicitRoute: true,
          },
        ],
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

  it('keeps the default route while validating connected sources when only the worker model is explicit', async () => {
    const availability = {
      'claude-code': [],
      codex: [
        { id: 'custom-codex', name: 'Custom Codex', models: ['gpt-5.5'] },
        { id: 'xd', name: 'XD Gateway', models: ['gpt-5.4'] },
      ],
      pi: [],
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
      pi: [],
      codex: [],
    });
    expect(msg).toContain('Codex 当前没有可用的模型供应商');
    expect(msg).toContain('改用');
    expect(msg).toContain('Claude Code(已连接:XD Gateway)');
  });

  it('omits the agent suggestion when no agent has a connected provider', () => {
    const msg = buildNoProviderMessage('claude-code', { 'claude-code': [], codex: [], pi: [] });
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

describe('SSH remote worker model/provider compatibility gate (R23 P2)', () => {
  const remoteLeadRow = {
    id: 'lead-1',
    agentKind: 'codex' as const,
    workspaceKind: 'project' as const,
    workingDir: '/srv/repo',
    model: 'gpt-5.5',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    providerId: 'xd',
    remoteHostId: 'remote-host-1',
  };

  it('rejects subscription-direct models for a remote lead (they require the local proxy path)', async () => {
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
      getAvailableModels: vi.fn(() => [
        { id: 'chatgpt/gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'chatgpt', name: 'ChatGPT Subscription', models: ['chatgpt/gpt-5.5'] }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'chatgpt/gpt-5.5',
        providerId: 'chatgpt',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('not available for SSH remote workers'),
    });
  });

  it('rejects chat-bridged codex providers for a remote lead (wireProtocol=openai-chat)', async () => {
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
      getAvailableModels: vi.fn(() => [
        { id: 'deepseek-v4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4'], chatBridgedCodex: true }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'deepseek-v4',
        providerId: 'deepseek',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('not available for SSH remote workers'),
    });
  });

  it('still allows SSH-compatible models for a remote lead', async () => {
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
    });
    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('rejects Pi workers for a remote lead before bootstrap (pi sessions are local-only)', async () => {
    // codex-connector 回归:PiAgent.startSession 对 remoteHostId 一律 NotSupportedError,
    // 不在 preflight 拒绝会让远程 Lead + Pi 组合在 bootstrap 期落成笼统 INTERNAL。
    const { service, deps } = createDeps({
      getLeadSessionRow: vi.fn(async () => remoteLeadRow),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'xd', name: 'XD Gateway', models: ['gpt-5.5'] }],
        pi: [{ id: 'xd', name: 'XD Gateway', models: ['claude-sonnet-4-6'] }],
      })),
    });
    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'developer',
        agent: 'pi',
        label: 'pi-dev',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('local-only'),
    });
    expect(deps.bootstrapSession).not.toHaveBeenCalled();
  });
});

  it('rejects chat-bridged providers resolved through the default route (no explicit providerId)', async () => {
    // R23 P2 回归:resolved.providerId 为 null (默认路由) 时, 兼容闸必须
    // 仍按 budgetRouteProviderId 解析出的实际落点判定 — 只查显式选择会漏。
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'project' as const,
        workingDir: '/srv/repo',
        model: 'gpt-5.5',
        effort: 'medium',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'deepseek',
        remoteHostId: 'remote-host-1',
      })),
      getAvailableModels: vi.fn(() => [
        { id: 'deepseek-v4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4'], chatBridgedCodex: true }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        model: 'deepseek-v4',
        // 不传 providerId — 走默认路由解析到 deepseek (chatBridged)。
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('not available for SSH remote workers'),
    });
  });

  it('rejects chat-bridged providers resolved for an inherited (lead) model with no explicit worker model/provider (R24 P2)', async () => {
    // R24 P2 回归:worker 不传 model/provider 时 resolved.providerId 与
    // budgetRouteProviderId 均为 null — 兼容闸必须按 routeProviderId
    // (resolveDefaultProviderIdForModel 解析的实际落点) 判定。
    const { service } = createDeps({
      getLeadSessionRow: vi.fn(async () => ({
        id: 'lead-1',
        agentKind: 'codex' as const,
        workspaceKind: 'project' as const,
        workingDir: '/srv/repo',
        model: 'deepseek-v4',
        effort: 'medium',
        permissionMode: 'default',
        fastMode: false,
        providerId: 'deepseek',
        remoteHostId: 'remote-host-1',
      })),
      getAvailableModels: vi.fn(() => [
        { id: 'deepseek-v4', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true },
      ]),
      getProviderRoutingContext: vi.fn(async () => providerRoutingContext({
        'claude-code': [],
        codex: [{ id: 'deepseek', name: 'DeepSeek', models: ['deepseek-v4'], chatBridgedCodex: true }],
      })),
    });

    await expect(
      service.createWorker({
        leadSessionId: 'lead-1',
        role: 'reviewer',
        agent: 'codex',
        label: 'reviewer',
        // 不传 model / providerId — 继承 lead 的 deepseek-v4 + 默认路由。
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
      message: expect.stringContaining('not available for SSH remote workers'),
    });
  });
