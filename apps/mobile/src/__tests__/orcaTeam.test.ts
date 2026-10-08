import { beforeAll, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import {
  archiveOrcaWorker,
  buildOrcaEnableOptions,
  convergeOrcaWorkerModel,
  createOrcaWorker,
  describeOrcaError,
  enableOrcaTeam,
  isOrcaCollabEligible,
  orcaWorkerFormFromPrefs,
  readOrcaCollabEntryStatus,
  rememberOrcaStartFailure,
  narrowOrcaWorkerProvider,
  orcaWorkerProvidersForLead,
  subscribeOrcaStartFailure,
  takeOrcaStartFailure,
} from '@/session/orcaTeam';
import type { ProviderView } from '@cindy/model-providers/registry';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { defaultOrcaWorkerCreationPrefs } from '@/session/orcaWorkerPrefs';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

type OrcaFake = Partial<MobileMakerTransport['orca']>;

function fakeMaker(opts: {
  capabilities?: unknown;
  capabilitiesError?: Error;
  orca?: OrcaFake;
}): MobileMakerTransport {
  return {
    getCapabilities: vi.fn(async () => {
      if (opts.capabilitiesError) throw opts.capabilitiesError;
      return opts.capabilities ?? { supportsOrcaWorkerPermissionMode: true };
    }),
    orca: {
      getCollabPolicy: vi.fn(async () => ({ effectiveEnabled: true })),
      enable: vi.fn(async () => ({ workerSessionId: 'worker-1' })),
      disable: vi.fn(async () => ({ ok: true })),
      createWorker: vi.fn(async () => ({ ok: true, workerSessionId: 'worker-2' })),
      listWorkers: vi.fn(async () => []),
      getTeamByWorkerSession: vi.fn(async () => null),
      switchFocus: vi.fn(async () => ({ ok: true })),
      acknowledgeDone: vi.fn(async () => ({ ok: true })),
      archiveWorker: vi.fn(async () => ({ ok: true })),
      getCollaborationSettings: vi.fn(async () => ({})),
      ...opts.orca,
    },
  } as unknown as MobileMakerTransport;
}

const project = { orcaRole: null, workspaceKind: 'project' as const, workingDir: '/repo', remoteHostId: null };

describe('mobile Orca collaboration entry', () => {
  it('only offers collaboration to Lead-capable tasks', () => {
    expect(isOrcaCollabEligible(project)).toBe(true);
    expect(isOrcaCollabEligible({ ...project, workingDir: '' })).toBe(false);
    expect(isOrcaCollabEligible({ ...project, workspaceKind: 'dialogue', workingDir: null })).toBe(true);
    expect(isOrcaCollabEligible({ ...project, orcaRole: 'worker' })).toBe(false);
    expect(isOrcaCollabEligible(null)).toBe(false);
  });

  it('fails closed when the computer does not declare Worker permission support', async () => {
    const maker = fakeMaker({ capabilities: {} });
    await expect(readOrcaCollabEntryStatus(maker, project, 'codex')).resolves.toBe('unsupported');
    expect(maker.orca.getCollabPolicy).not.toHaveBeenCalled();
  });

  it('maps policy query results to entry states', async () => {
    await expect(readOrcaCollabEntryStatus(fakeMaker({}), project, 'codex')).resolves.toBe('ready');
    await expect(readOrcaCollabEntryStatus(fakeMaker({
      orca: { getCollabPolicy: vi.fn(async () => ({ effectiveEnabled: false })) },
    }), project, 'codex')).resolves.toBe('disabled');
    await expect(readOrcaCollabEntryStatus(fakeMaker({
      orca: { getCollabPolicy: vi.fn(async () => { throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] no'); }) },
    }), project, 'codex')).resolves.toBe('unsupported');
    await expect(readOrcaCollabEntryStatus(fakeMaker({
      orca: { getCollabPolicy: vi.fn(async () => { throw new Error('[NOT_CONNECTED] offline'); }) },
    }), project, 'codex')).resolves.toBe('unavailable');
  });

  it('skips the project policy query for SSH-remote sessions and existing Leads', async () => {
    const remote = fakeMaker({});
    await readOrcaCollabEntryStatus(remote, { ...project, remoteHostId: 'host-1' }, 'claude-code');
    expect(remote.orca.getCollabPolicy).toHaveBeenCalledWith(undefined, 'project');

    const lead = fakeMaker({});
    await expect(readOrcaCollabEntryStatus(lead, { ...project, orcaRole: 'lead' }, 'claude-code')).resolves.toBe('ready');
    expect(lead.orca.getCollabPolicy).not.toHaveBeenCalled();
  });
});

describe('mobile Orca collaboration mutations', () => {
  it('settles a timed-out Worker archive by rechecking the team once', async () => {
    const timeout = new Error('[INVOKE_TIMEOUT] timed out');
    const gone = fakeMaker({ orca: { archiveWorker: vi.fn(async () => { throw timeout; }), listWorkers: vi.fn(async () => []) } });
    await expect(archiveOrcaWorker(gone, 'lead-1', 'w-1')).resolves.toBeUndefined();
    const stillListed = fakeMaker({ orca: {
      archiveWorker: vi.fn(async () => { throw timeout; }),
      listWorkers: vi.fn(async () => [{ id: 'w-1', sessionId: 's-1' }]),
    } });
    await expect(archiveOrcaWorker(stillListed, 'lead-1', 'w-1')).rejects.toThrow('ORCA_ACTION_UNCONFIRMED');
    const recheckFailed = fakeMaker({ orca: {
      archiveWorker: vi.fn(async () => { throw timeout; }),
      listWorkers: vi.fn(async () => { throw new Error('[NOT_CONNECTED] offline'); }),
    } });
    await expect(archiveOrcaWorker(recheckFailed, 'lead-1', 'w-1')).rejects.toThrow('ORCA_ACTION_UNCONFIRMED');
    // 非超时错误是权威失败:原样抛出,不回查。
    const listWorkers = vi.fn(async () => []);
    const rejected = fakeMaker({ orca: { archiveWorker: vi.fn(async () => { throw new Error('[WORKER_NOT_FOUND] x'); }), listWorkers } });
    await expect(archiveOrcaWorker(rejected, 'lead-1', 'w-1')).rejects.toThrow('WORKER_NOT_FOUND');
    expect(listWorkers).not.toHaveBeenCalled();
  });

  const form = {
    ...orcaWorkerFormFromPrefs({ ...defaultOrcaWorkerCreationPrefs(), workerPermissionMode: 'auto' }, 'codex'),
    model: null,
    role: 'Reviewer',
    initialTask: 'check tests',
  };

  it('builds enable options with a derived label and only the chosen model fields', () => {
    expect(buildOrcaEnableOptions(form, 'task')).toEqual({
      workerAgent: 'codex',
      role: 'Reviewer',
      label: 'reviewer',
      workerPermissionMode: 'auto',
      delegateTask: 'task',
    });
    expect(buildOrcaEnableOptions({
      ...form,
      model: { id: 'gpt-5.5', providerId: 'openai', effort: 'high', fast: true },
    }, '  ')).toEqual({
      workerAgent: 'codex',
      role: 'Reviewer',
      label: 'reviewer',
      model: 'gpt-5.5',
      effort: 'high',
      fast: true,
      providerId: 'openai',
      workerPermissionMode: 'auto',
    });
  });

  it('restores the remembered Worker choice like the desktop create panel', () => {
    const prefs = defaultOrcaWorkerCreationPrefs();
    expect(orcaWorkerFormFromPrefs(prefs, prefs.lastAgent)).toEqual({
      role: 'developer',
      agent: 'codex',
      model: { id: 'codex/gpt-5.5', providerId: null, effort: 'high', fast: false },
      permissionMode: 'bypassPermissions',
      initialTask: '',
    });
  });

  it('converges a remembered model to what the computer can run', () => {
    const capabilities = {
      hasFastMode: true,
      availableModels: [{
        id: 'gpt-5.5', label: 'GPT', efforts: ['low', 'medium'], effortDisplayNames: {},
        defaultEffort: 'medium', supportsFastMode: false,
      }],
    };
    expect(convergeOrcaWorkerModel({ id: 'gone', providerId: null, effort: 'high', fast: false }, capabilities)).toBeNull();
    expect(convergeOrcaWorkerModel({ id: 'gpt-5.5', providerId: null, effort: 'high', fast: true }, capabilities))
      .toEqual({ id: 'gpt-5.5', providerId: null, effort: 'medium', fast: false });
    const kept = { id: 'x', providerId: null, effort: 'high', fast: true };
    expect(convergeOrcaWorkerModel(kept, null)).toBe(kept);
    expect(convergeOrcaWorkerModel(null, capabilities)).toBeNull();
  });

  it('re-checks capabilities before enabling and refuses on downgraded hosts', async () => {
    const maker = fakeMaker({ capabilities: { supportsOrcaWorkerPermissionMode: false } });
    await expect(enableOrcaTeam(maker, 'lead-1', buildOrcaEnableOptions(form))).rejects.toThrow('CHANNEL_NOT_ALLOWED');
    expect(maker.orca.enable).not.toHaveBeenCalled();
  });

  it('treats a tunnel timeout as ambiguous and confirms the team from the Worker list', async () => {
    const maker = fakeMaker({
      orca: {
        enable: vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); }),
        listWorkers: vi.fn(async () => [{ id: 'w-1', sessionId: 'worker-9' }]),
      },
    });
    await expect(enableOrcaTeam(maker, 'lead-1', buildOrcaEnableOptions(form))).resolves.toEqual({ workerSessionId: 'worker-9' });
    expect(maker.orca.enable).toHaveBeenCalledTimes(1);
  });

  it('confirms an already-existing team from the Worker list before treating it as started', async () => {
    const withWorker = fakeMaker({
      orca: {
        enable: vi.fn(async () => { throw new Error('[ALREADY_EXISTS] active team'); }),
        listWorkers: vi.fn(async () => [{ id: 'w-1', sessionId: 'worker-7' }]),
      },
    });
    await expect(enableOrcaTeam(withWorker, 'lead-1', buildOrcaEnableOptions(form))).resolves.toEqual({ workerSessionId: 'worker-7' });

    // 团队已建但首个 Worker 没落库:不能按成功处理。
    const teamOnly = fakeMaker({
      orca: {
        enable: vi.fn(async () => { throw new Error('[ALREADY_EXISTS] active team'); }),
        listWorkers: vi.fn(async () => []),
      },
    });
    vi.useFakeTimers();
    const pending = enableOrcaTeam(teamOnly, 'lead-1', buildOrcaEnableOptions(form));
    const assertion = expect(pending).rejects.toThrow('ALREADY_EXISTS');
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });

  it('does not retry authoritative enable failures', async () => {
    const maker = fakeMaker({
      orca: { enable: vi.fn(async () => { throw new Error('[PRECONDITION_FAILED] disabled'); }) },
    });
    await expect(enableOrcaTeam(maker, 'lead-1', buildOrcaEnableOptions(form))).rejects.toThrow('PRECONDITION_FAILED');
    expect(maker.orca.listWorkers).not.toHaveBeenCalled();
  });

  it('skips labels still held by archived Workers instead of re-deriving the same one', async () => {
    // 已归档的 reviewer / reviewer-2 不在列表里,但 label 仍被占用。
    const createWorker = vi.fn()
      .mockRejectedValueOnce(new Error('[DUPLICATE_LABEL] taken'))
      .mockRejectedValueOnce(new Error('[DUPLICATE_LABEL] taken'))
      .mockResolvedValueOnce({ ok: true, workerSessionId: 'worker-3' });
    const maker = fakeMaker({ orca: { createWorker, listWorkers: vi.fn(async () => []) } });
    await expect(createOrcaWorker(maker, 'lead-1', form, [])).resolves.toEqual({ workerSessionId: 'worker-3' });
    expect(createWorker.mock.calls.map((call) => call[0].label)).toEqual(['reviewer', 'reviewer-2', 'reviewer-3']);
    expect(createWorker.mock.calls[2][0]).toMatchObject({ initialTask: 'check tests', agent: 'codex' });
  });

  it('refuses to create Workers on computers that would ignore the chosen permission', async () => {
    const maker = fakeMaker({ capabilities: {} });
    await expect(createOrcaWorker(maker, 'lead-1', form, [])).rejects.toThrow('CHANNEL_NOT_ALLOWED');
    expect(maker.orca.createWorker).not.toHaveBeenCalled();
  });

  it('confirms a timed-out Worker creation by its exact label instead of retrying', async () => {
    const createWorker = vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); });
    const landed = fakeMaker({
      orca: {
        createWorker,
        listWorkers: vi.fn(async () => [
          { id: 'w-0', sessionId: 'old', role: 'reviewer', label: 'other' },
          { id: 'w-1', sessionId: 'new', role: 'Reviewer', label: 'reviewer' },
        ]),
      },
    });
    await expect(createOrcaWorker(landed, 'lead-1', form, [])).resolves.toEqual({ workerSessionId: 'new' });
    expect(createWorker).toHaveBeenCalledTimes(1);

    const lost = fakeMaker({
      orca: {
        createWorker: vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); }),
        listWorkers: vi.fn(async () => []),
      },
    });
    vi.useFakeTimers();
    const pending = createOrcaWorker(lost, 'lead-1', form, []);
    const assertion = expect(pending).rejects.toThrow('ORCA_CREATE_UNCONFIRMED');
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
    expect(lost.orca.createWorker).toHaveBeenCalledTimes(1);
    expect(describeOrcaError(new Error('[ORCA_CREATE_UNCONFIRMED] x'), 'session.collab.errors.createFailed'))
      .toContain('暂时无法确认是否成功');
  });

  it('describes known Orca errors in the interface language', () => {
    expect(describeOrcaError(new Error('[WORKER_LIMIT_HARD_EXCEEDED] full'), 'session.collab.errors.createFailed'))
      .toBe('已达 Worker 硬上限，请先归档现有 Worker。');
    expect(describeOrcaError(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old'), 'session.collab.errors.startFailed'))
      .toBe('电脑端版本过旧，暂不支持协同');
    expect(describeOrcaError(new Error('boom'), 'session.collab.errors.startFailed')).toContain('开启协同失败。');
  });

  it('hands a new-task start failure to the session page exactly once, including late failures', () => {
    rememberOrcaStartFailure('s-1', 'reason');
    expect(takeOrcaStartFailure('s-1')).toBe('reason');
    expect(takeOrcaStartFailure('s-1')).toBeNull();

    const seen: string[] = [];
    const unsubscribe = subscribeOrcaStartFailure((sessionId) => seen.push(sessionId));
    rememberOrcaStartFailure('s-2', 'late');
    unsubscribe();
    rememberOrcaStartFailure('s-3', 'after');
    expect(seen).toEqual(['s-2']);
  });

  it('bounds the timeout probe by an overall deadline', async () => {
    vi.useFakeTimers();
    const listWorkers = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 20_000)));
    const maker = fakeMaker({
      orca: { enable: vi.fn(async () => { throw new Error('[INVOKE_TIMEOUT] timed out'); }), listWorkers },
    });
    const pending = enableOrcaTeam(maker, 'lead-1', buildOrcaEnableOptions(form));
    const assertion = expect(pending).rejects.toThrow('INVOKE_TIMEOUT');
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
    // 20s 一次的探针在 30s 总时限内只来得及两次,不会跑满四次。
    expect(listWorkers.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('clears an explicit provider that no longer serves the chosen model before submitting', () => {
    const provider = (id: string, connected = true) => ({
      id, name: id, agents: ['codex'], connected, routing: { codex: {} }, models: { codex: [{ id: 'gpt-5.5' }] },
    }) as unknown as ProviderView;
    const chosen = { ...form, agent: 'codex' as const, model: { id: 'gpt-5.5', providerId: 'a', effort: 'high', fast: false } };
    // 来源 A 仍可路由 → 原样;A 断开、B 仍提供同名模型 → 清掉来源交给被控端默认路由。
    expect(narrowOrcaWorkerProvider(chosen, [provider('a'), provider('b')])).toBe(chosen);
    expect(narrowOrcaWorkerProvider(chosen, [provider('a', false), provider('b')]).model?.providerId).toBeNull();
    // 目录未就绪时不猜。
    expect(narrowOrcaWorkerProvider(chosen, null)).toBe(chosen);
  });

  it('hides routes an SSH Lead cannot run for its Workers', () => {
    const gateway = {
      id: 'gateway', name: 'gateway', agents: ['codex'], connected: true, routing: { codex: {} },
      models: { codex: [{ id: 'gpt-5.5' }, { id: 'chatgpt/gpt-5.5' }] },
    } as unknown as ProviderView;
    const bridged = {
      id: 'bridged', name: 'bridged', agents: ['codex'], connected: true,
      routing: { codex: { wireProtocol: 'openai-chat' } }, models: { codex: [{ id: 'kimi' }] },
    } as unknown as ProviderView;
    const ssh = orcaWorkerProvidersForLead([gateway, bridged], true);
    expect(ssh[0]!.models.codex?.map((model) => model.id)).toEqual(['gpt-5.5']);
    expect(ssh[1]!.models.codex).toEqual([]);
    const local = [gateway, bridged];
    expect(orcaWorkerProvidersForLead(local, false)).toBe(local);
  });

  it('sends an explicit Fast off for a chosen model and leaves the default model to the computer', () => {
    const chosen = { ...form, agent: 'codex' as const, model: { id: 'gpt-5.5', providerId: null, effort: 'high', fast: false } };
    expect(buildOrcaEnableOptions(chosen)).toMatchObject({ model: 'gpt-5.5', fast: false });
    expect(buildOrcaEnableOptions({ ...chosen, model: null })).not.toHaveProperty('fast');
  });

  it('reconciles effort and Fast against the explicitly chosen provider, not the flattened list', () => {
    const provider = (id: string, efforts: string[], supportsFastMode: boolean) => ({
      id, name: id, agents: ['codex'], connected: true, routing: { codex: {} },
      models: { codex: [{ id: 'gpt-5.5', efforts, defaultEffort: efforts[0] ?? null, supportsFastMode }] },
    }) as unknown as ProviderView;
    const chosen = { ...form, agent: 'codex' as const, model: { id: 'gpt-5.5', providerId: 'a', effort: 'xhigh', fast: true } };
    // 拍平能力只有 low/high 且不支持 Fast:显式来源时不改 effort / Fast。
    const flat = { hasFastMode: true, availableModels: [{ id: 'gpt-5.5', efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: false }] };
    expect(convergeOrcaWorkerModel(chosen.model, flat as never)).toEqual(chosen.model);
    // 来源 A 支持 xhigh 与 Fast → 原样;来源 A 不支持时按 A 自己的默认收敛。
    expect(narrowOrcaWorkerProvider(chosen, [provider('a', ['high', 'xhigh'], true)])).toBe(chosen);
    expect(narrowOrcaWorkerProvider(chosen, [provider('a', ['medium'], false)]).model)
      .toMatchObject({ providerId: 'a', effort: 'medium', fast: false });
  });

  it('reconciles an unpinned model against the default source it will actually route to', () => {
    const provider = (id: string, efforts: string[]) => ({
      id, name: id, agents: ['codex'], connected: true, routing: { codex: {} },
      models: { codex: [{ id: 'gpt-5.5', efforts, defaultEffort: efforts[0] ?? null, supportsFastMode: false }] },
    }) as unknown as ProviderView;
    const unpinned = { ...form, agent: 'codex' as const, model: { id: 'gpt-5.5', providerId: null, effort: 'xhigh', fast: true } };
    const result = narrowOrcaWorkerProvider(unpinned, [provider('only', ['low', 'medium'])]);
    // 仍不钉来源(交给被控端路由),但 effort / Fast 按该默认来源的条目收敛。
    expect(result.model).toMatchObject({ providerId: null, effort: 'low', fast: false });
  });

  it('omits effort when the routed provider has no effort levels for the model', () => {
    const provider = {
      id: 'a', name: 'a', agents: ['codex'], connected: true, routing: { codex: {} },
      models: { codex: [{ id: 'gpt-5.5', efforts: [], defaultEffort: null, supportsFastMode: false }] },
    } as unknown as ProviderView;
    const chosen = { ...form, agent: 'codex' as const, model: { id: 'gpt-5.5', providerId: 'a', effort: 'high', fast: false } };
    const narrowed = narrowOrcaWorkerProvider(chosen, [provider]);
    expect(narrowed.model?.effort).toBeNull();
    expect(buildOrcaEnableOptions(narrowed)).not.toHaveProperty('effort');
  });
});

