import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const run = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ run }));
  return {
    run, values, insert: vi.fn(() => ({ values })),
    bootstrap: vi.fn(async (): Promise<void> => undefined), recent: vi.fn(async () => undefined),
  };
});
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ drizzle: { insert: mocks.insert } }) }));
vi.mock('../localDb/schema', () => ({ sessions: {} }));
vi.mock('../localDb/mapper', () => ({ sessionCreateToRow: (id: string, row: object) => ({ id, ...row }) }));
vi.mock('../localDb/dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../git-snapshot/projectGitBootstrap', () => ({ ensureProjectGitInitialized: mocks.bootstrap }));
vi.mock('../maker-host/git-safety-settings-store', () => ({ readGitSafetySettings: () => ({ autoSnapshotEnabled: true }) }));
vi.mock('../localDb/ipc/recentWorkdirs', () => ({ upsertRecentWorkdir: mocks.recent }));
vi.mock('../localDb/pluginWorkspaceDedupe', () => ({ pickSessionForWorkdir: vi.fn() }));
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

import { createPluginDraftSession } from '../localDb/ipc/pluginWorkspaceSessions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bootstrap.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue(undefined);
});

describe('plugin draft creation commit boundary', () => {
  const params = { dirAbs: '/project', title: 'Project', ghostId: 'test-plugin' };

  it('does not start side effects for an already expired call', async () => {
    expect(await createPluginDraftSession({ ...params, shouldContinue: () => false })).toBeNull();
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('does not insert or announce a draft when the call expires during bootstrap', async () => {
    let active = true;
    let finish!: () => void;
    mocks.bootstrap.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const notify = vi.fn();
    const result = createPluginDraftSession({ ...params, shouldContinue: () => active, notifySessionCreated: notify });
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    active = false;
    finish();
    expect(await result).toBeNull();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.recent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('checks validity and dispatches the insert without an intervening microtask', async () => {
    let checkedAfterBootstrap = false;
    const shouldContinue = vi.fn(() => {
      if (mocks.bootstrap.mock.calls.length) {
        checkedAfterBootstrap = true;
        queueMicrotask(() => { checkedAfterBootstrap = false; });
      }
      return true;
    });
    mocks.run.mockImplementationOnce(async () => { expect(checkedAfterBootstrap).toBe(true); });
    const notify = vi.fn();
    const id = await createPluginDraftSession({ ...params, shouldContinue, notifySessionCreated: notify });
    expect(id).toEqual(expect.any(String));
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.recent).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
  });

  it('retains the user-picked directory creation path without a call predicate', async () => {
    expect(await createPluginDraftSession(params)).toEqual(expect.any(String));
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});
