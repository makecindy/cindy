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
