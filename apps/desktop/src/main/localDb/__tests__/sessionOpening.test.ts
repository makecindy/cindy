import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ owner: {} as object | null,
  run: vi.fn(async () => undefined), values: vi.fn(), bootstrap: vi.fn(async () => undefined),
}));
vi.mock('../client/current', () => ({ getCurrentDbClientSnapshot: () => h.owner,
  getDbClient: () => ({ drizzle: { insert: () => ({ values: h.values }) } }) }));
vi.mock('../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: (id: string) => `/dialogue/${id}` }));
vi.mock('../../git-snapshot/projectGitBootstrap', () => ({ ensureProjectGitInitialized: h.bootstrap }));
vi.mock('../../maker-host/git-safety-settings-store', () => ({ readGitSafetySettings: () => ({ autoSnapshotEnabled: false, autoInitProjectGit: false }) }));
import { openSession, setSessionOpeningModelAdmission, type OpenedSessionRow } from '../sessionOpening';
import { resolveSessionExecutionSelection } from '../../maker-ipc/sessionExecutionSelection';
import { createOrcaRemoteWorkerHost, createOrcaRemoteWorkerSessionOpener } from '../../maker-ipc/orcaRemoteWorkerHost';
import { parseOrcaRemoteLead } from '../../../shared/orcaRemoteWorker';

const remoteLead = {
  leadDeviceId: 'lead-device', leadDeviceName: 'Lead computer', leadSessionId: 'lead-1',
  leadTitle: 'Lead task', workerLabel: 'tester',
};
const remoteRequest = {
  sessionId: 'remote-worker', agentKind: 'codex' as const, model: 'model', providerId: 'connected',
  permissionMode: 'auto' as const, title: 'Worker task',
  lead: { leadSessionId: 'lead-1', leadTitle: 'Lead task', workerLabel: 'tester' },
};
function remoteOpener() {
  const bootstrapSession = vi.fn(async (_row: OpenedSessionRow, _assertCurrent: () => void) => undefined);
  const broadcastSessionCreated = vi.fn();
  const open = createOrcaRemoteWorkerSessionOpener({
    openSession,
    insertSession: async row => { await h.values(row).run(); },
    bootstrapSession, broadcastSessionCreated,
  });
  return { open, bootstrapSession, broadcastSessionCreated };
}

const body = { agentKind: 'codex' as const, model: 'model', providerId: 'connected', effort: '', fastMode: false,
  workspaceKind: 'dialogue' as const, permissionMode: 'ask', title: 'Normal task' };
beforeEach(() => {
  vi.clearAllMocks(); h.owner = {}; h.values.mockReturnValue({ run: h.run });
  h.bootstrap.mockResolvedValue(undefined);
  setSessionOpeningModelAdmission(async request => {
    const route = resolveSessionExecutionSelection({ selection: request,
      availableAgents: ['codex'], availableModels: [{ id: 'model', efforts: [] }], hasCindyAiApiKey: false,
      providerRouting: { availability: { 'claude-code': [], pi: [], codex: [{ id: 'connected', name: 'Connected', models: ['model'] }] },
        resolveDefaultProviderIdForModel: () => 'connected' } });
    return { ...request, model: route.model, providerId: route.providerId, effort: route.effort ?? '' };
  });
});
it.each(['desktop', 'plugin'] as const)('opens the same normal Session for %s without inventing model/permission defaults', async source => {
  const opened = await openSession({ id: 'session', body, source });
  expect(opened.row).toMatchObject({ id: 'session', model: 'model', providerId: 'connected', agentKind: 'codex',
    effort: '', permissionMode: 'ask', source, workingDir: '/dialogue/session' });
  expect(h.run).toHaveBeenCalledOnce();
});
it('rejects an unavailable route before directory preparation and persistence', async () => {
  await expect(openSession({ body: { ...body, providerId: 'disconnected' } })).rejects.toThrow('供应商');
  expect(h.bootstrap).not.toHaveBeenCalled(); expect(h.values).not.toHaveBeenCalled();
});
it('commits a companion receipt with the admitted Session while sampling current permission after preparation', async () => {
  let permission = 'bypassPermissions';
  h.bootstrap.mockImplementationOnce(async () => { permission = 'plan'; });
  const commit = vi.fn(async (row: OpenedSessionRow) => ({ receiptSessionId: row.id, permission: row.permissionMode }));
  const opened = await openSession({ body, finalize: () => ({ permissionMode: permission, parentSessionId: 'parent' }) }, commit);
  expect(opened.value).toEqual({ receiptSessionId: opened.row.id, permission: 'plan' });
  expect(opened.row.parentSessionId).toBe('parent');
  expect(h.values).not.toHaveBeenCalled(); expect(commit).toHaveBeenCalledOnce();
});
it('does not retry a failed atomic commit as an ordinary insert', async () => {
  const commit = vi.fn(async () => { throw new Error('transaction failed'); });
  await expect(openSession({ body }, commit)).rejects.toThrow('transaction failed');
  expect(commit).toHaveBeenCalledOnce(); expect(h.values).not.toHaveBeenCalled();
});
it('rejects account changes during directory preparation before committing', async () => {
  h.bootstrap.mockImplementationOnce(async () => { h.owner = {}; });
  await expect(openSession({ body })).rejects.toThrow('账号已变化');
  expect(h.values).not.toHaveBeenCalled();
});

it('lets a queued commit recheck the account before its actual insert', async () => {
  await expect(openSession({ body }, async (_row, assertCurrent) => {
    await Promise.resolve();
    h.owner = {};
    assertCurrent();
    await h.run();
  })).rejects.toThrow('账号已变化');
  expect(h.run).not.toHaveBeenCalled();
});

it("leaves model admission to the computer running the agent when the task's agent runs elsewhere", async () => {
  // 那台的模型(如内网 Spark)本机目录里没有：本机不校验，由那台启动时按它的目录裁决。
  const opened = await openSession({ id: 'device-task', body: { ...body, model: 'spark/qwen', providerId: 'spark', agentDeviceId: 'device-b' } });
  expect(opened.row).toMatchObject({ model: 'spark/qwen', providerId: 'spark', agentDeviceId: 'device-b' });
  expect(h.run).toHaveBeenCalledOnce();
});

it('still admits the model here for a blank agent computer', async () => {
  await expect(openSession({ body: { ...body, providerId: 'disconnected', agentDeviceId: '  ' } })).rejects.toThrow('供应商');
  expect(h.values).not.toHaveBeenCalled();
});

it.each([undefined, '/execution/project'])('inserts the remote Worker identity atomically before Agent startup (directory=%s)', async workingDir => {
  const { open, bootstrapSession, broadcastSessionCreated } = remoteOpener();
  const result = await open({ ...remoteRequest, workingDir }, remoteLead);
  const persisted = h.values.mock.calls[0]![0] as OpenedSessionRow;
  expect(parseOrcaRemoteLead(persisted.orcaRemoteLead)).toEqual(remoteLead);
  expect(persisted).toMatchObject({ id: 'remote-worker', permissionMode: 'auto',
    workspaceKind: workingDir ? 'project' : 'dialogue', workingDir: workingDir ?? '/dialogue/remote-worker' });
  expect(bootstrapSession).toHaveBeenCalledWith(persisted, expect.any(Function));
  expect(h.run.mock.invocationCallOrder[0]).toBeLessThan(bootstrapSession.mock.invocationCallOrder[0]!);
  expect(bootstrapSession.mock.invocationCallOrder[0]).toBeLessThan(broadcastSessionCreated.mock.invocationCallOrder[0]!);
  expect(h.values).toHaveBeenCalledOnce();
  expect(result).toEqual({ agentKind: 'codex', model: 'model', workingDir: persisted.workingDir, effort: '', fastMode: false });
});

it.each(['medium', 'low', ''] as const)('returns the execution provider admitted effort %s', async effort => {
  setSessionOpeningModelAdmission(async request => {
    const route = resolveSessionExecutionSelection({ selection: request,
      availableAgents: ['codex'], availableModels: [{ id: 'model', efforts: ['high'], defaultEffort: 'high' }],
      hasCindyAiApiKey: false,
      providerRouting: {
        availability: { 'claude-code': [], pi: [], codex: [{ id: 'connected', name: 'Connected', models: ['model'],
          effortMetaByModel: { model: { efforts: effort ? [effort] : [], defaultEffort: effort || null } } }] },
        resolveDefaultProviderIdForModel: () => 'connected',
      },
    });
    return { ...request, effort: route.effort ?? '' };
  });
  const { open, bootstrapSession } = remoteOpener();
  await expect(open(remoteRequest, remoteLead)).resolves.toMatchObject({ effort });
  expect(h.values.mock.calls[0]![0]).toMatchObject({ effort });
  expect(bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ effort }), expect.any(Function));
});

it.each([
  [true, true, true],
  [true, false, false],
  [false, undefined, false],
] as const)('returns persisted Fast with provider support %s and requested Fast %s', async (supportsFast, requested, expected) => {
  setSessionOpeningModelAdmission(async request => {
    const route = resolveSessionExecutionSelection({ selection: request,
      availableAgents: ['codex'], availableModels: [{ id: 'model', efforts: [], supportsFastMode: true }],
      hasCindyAiApiKey: false,
      providerRouting: {
        availability: { 'claude-code': [], pi: [], codex: [{ id: 'connected', name: 'Connected', models: ['model'],
          fastModels: supportsFast ? ['model'] : [] }] },
        resolveDefaultProviderIdForModel: () => 'connected',
      },
    });
    return { ...request, model: route.model, providerId: route.providerId,
      effort: route.effort ?? '', fastMode: route.fastMode };
  });
  const { open, bootstrapSession } = remoteOpener();
  await expect(open({ ...remoteRequest, fastMode: requested }, remoteLead)).resolves.toMatchObject({ fastMode: expected });
  expect(h.values.mock.calls[0]![0]).toMatchObject({ fastMode: expected });
  expect(bootstrapSession).toHaveBeenCalledWith(expect.objectContaining({ fastMode: expected }), expect.any(Function));
});

it('keeps the current unsupported explicit Fast rejection before remote persistence', async () => {
  setSessionOpeningModelAdmission(async request => {
    const route = resolveSessionExecutionSelection({ selection: request,
      availableAgents: ['codex'], availableModels: [{ id: 'model', efforts: [], supportsFastMode: true }],
      hasCindyAiApiKey: false,
      providerRouting: {
        availability: { 'claude-code': [], pi: [], codex: [{ id: 'connected', name: 'Connected', models: ['model'], fastModels: [] }] },
        resolveDefaultProviderIdForModel: () => 'connected',
      },
    });
    return { ...request, model: route.model, providerId: route.providerId,
      effort: route.effort ?? '', fastMode: route.fastMode };
  });
  const { open, bootstrapSession } = remoteOpener();
  await expect(open({ ...remoteRequest, fastMode: true }, remoteLead)).rejects.toThrow('fast mode is not supported');
  expect(h.values).not.toHaveBeenCalled();
  expect(bootstrapSession).not.toHaveBeenCalled();
});

it('does not start or broadcast a remote Worker when its identity INSERT fails', async () => {
  h.run.mockRejectedValueOnce(new Error('INSERT failed'));
  const { open, bootstrapSession, broadcastSessionCreated } = remoteOpener();
  await expect(open(remoteRequest, remoteLead)).rejects.toThrow('INSERT failed');
  expect(bootstrapSession).not.toHaveBeenCalled();
  expect(broadcastSessionCreated).not.toHaveBeenCalled();
});

it('keeps a persisted remote Worker recognizable after startup fails or the host restarts', async () => {
  const { open, bootstrapSession, broadcastSessionCreated } = remoteOpener();
  bootstrapSession.mockRejectedValueOnce(new Error('startup interrupted'));
  const start = vi.fn(open);
  const deps = {
    getCaller: () => ({ controllerDeviceId: 'lead-device', controllerName: 'Lead computer' }),
    readSession: async () => {
      const row = h.values.mock.calls[0]?.[0] as OpenedSessionRow | undefined;
      return row ? { orcaRemoteLead: parseOrcaRemoteLead(row.orcaRemoteLead),
        status: row.status ?? 'active',
        workingDir: row.workingDir ?? null, model: row.model, agentKind: 'codex' as const, effort: row.effort } : null;
    },
    openSession: start,
    writeRemoteLead: vi.fn(),
    withSessionLock: async <T,>(_id: string, task: () => Promise<T>) => task(),
    now: () => 1000,
  };
  await expect(createOrcaRemoteWorkerHost(deps).open(remoteRequest)).rejects.toThrow('startup interrupted');
  expect(broadcastSessionCreated).not.toHaveBeenCalled();
  // 重建 Host，仅使用已 INSERT 的任务身份；同 ID 重试可对账，无 ALREADY_EXISTS。
  await expect(createOrcaRemoteWorkerHost(deps).open(remoteRequest)).resolves.toMatchObject({ sessionId: 'remote-worker', model: 'model', effort: '' });
  expect(h.run).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  const foreign = createOrcaRemoteWorkerHost({ ...deps, getCaller: () => ({ controllerDeviceId: 'other-device' }) });
  await expect(foreign.open(remoteRequest)).rejects.toThrow('ALREADY_EXISTS');
});

it('does not start a persisted remote Worker in a replacement account', async () => {
  h.run.mockImplementationOnce(async () => { h.owner = {}; });
  const { open, bootstrapSession, broadcastSessionCreated } = remoteOpener();
  await expect(open(remoteRequest, remoteLead)).rejects.toThrow('账号已变化');
  expect(parseOrcaRemoteLead(h.values.mock.calls[0]![0].orcaRemoteLead)).toEqual(remoteLead);
  expect(bootstrapSession).not.toHaveBeenCalled();
  expect(broadcastSessionCreated).not.toHaveBeenCalled();
});
