/**
 * renameSessionTitlesInDb 回归测试。
 *
 * 批量改名的 expected_current_title / expected_updated_at 必须进入 UPDATE 谓词;
 * 如果 SELECT 后写入前数据变化,整批事务应失败,且不能广播部分成功的 patch。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const selectRows: Array<{
    id: string;
    title: string | null;
    workingDir: string | null;
    updatedAt: number;
  }> = [];
  const returningQueue: Array<
    Array<{ id: string; title: string | null; workingDir: string | null; updatedAt: number }>
  > = [];
  const updateSetCalls: Array<Record<string, unknown>> = [];
  const tx = vi.fn(async () => {
    const err = Object.assign(new Error('Session 标题或 updatedAt 已变化: session-2'), {
      code: 'PRECONDITION_FAILED',
    });
    throw err;
  });

  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => Promise.resolve(selectRows);
    return chain;
  };

  const makeUpdateChain = () => {
    const chain: Record<string, unknown> = {};
    chain.set = (payload: Record<string, unknown>) => {
      updateSetCalls.push(payload);
      return chain;
    };
    chain.where = () => chain;
    chain.returning = () => Promise.resolve(returningQueue.shift() ?? []);
    return chain;
  };

  const fakeDb = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb)),
  };

  return {
    owner: { userId: 'account-a' },
    fakeDb,
    tx,
    selectRows,
    returningQueue,
    updateSetCalls,
    tapWindowBroadcast: vi.fn(),
    webContentsSend: vi.fn(),
    agentIslandService: {
      handleSessionMetadataPatch: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: { once: vi.fn() },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.webContentsSend } }],
  },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: h.fakeDb, tx: h.tx }),
  getCurrentDbClientSnapshot: () => h.owner,
}));
vi.mock('../localDb/dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../git-context/prRefsStore', () => ({ recomputePrRefsForSession: vi.fn() }));
vi.mock('../localDb/ipc/recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn() }));
vi.mock('../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => null),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  isDataOwnerBroadcastScopeCurrent: vi.fn(() => true),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../agent-island/service.js', () => ({
  getAgentIslandService: () => h.agentIslandService,
}));
vi.mock('../imageCacheStore.desktop', () => ({ removeSession: vi.fn() }));

import { renameSessionTitlesInDb } from '../localDb/ipc/sessions.js';
import { admitTaskAction, assertTaskActionCurrent } from '../maker-ipc/taskActionAuthorization.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.owner = { userId: 'account-a' };
  h.selectRows.length = 0;
  h.returningQueue.length = 0;
  h.updateSetCalls.length = 0;
  h.tx.mockClear();
});

describe('renameSessionTitlesInDb', () => {
  it('does not write or broadcast a batch selected under a previous account', async () => {
    h.selectRows.push({ id: 'feishu_shared_id', title: 'Old', workingDir: null, updatedAt: 1_700_000_000_000 });
    await expect(renameSessionTitlesInDb([{ sessionId: 'feishu_shared_id', title: 'Manual' }], false, async () => {
      h.owner = { userId: 'account-b' };
    })).rejects.toThrow('Account changed');
    expect(h.tx).not.toHaveBeenCalled();
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  // #6399: admission alone misses revocation during SELECT. Unit boundary is the
  // production batch writer; the existing conditional-title test only covers DB races.
  it('does not rename after the admitted input is replaced during the read', async () => {
    h.selectRows.push({ id: 'target', title: 'Old', workingDir: null, updatedAt: 1_700_000_000_000 });
    let current = true;
    const decision = await admitTaskAction(
      { server: 'cindy_helper', tool: 'rename_sessions', sessionId: 'caller', args: {} },
      { key: 'input', ownerInput: true, delegated: false, assertCurrent: async () => {
        if (!current) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      } },
    );
    if (!decision.ok || !decision.run) throw new Error('Expected admission');
    h.fakeDb.select.mockImplementationOnce(() => {
      current = false;
      return { from: () => ({ where: () => Promise.resolve(h.selectRows) }) };
    });
    await expect(decision.run(() => renameSessionTitlesInDb(
      [{ sessionId: 'target', title: 'New' }], false, assertTaskActionCurrent,
    ))).rejects.toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(h.tx).not.toHaveBeenCalled();
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('rolls back visible side effects when a conditional update no longer matches', async () => {
    h.selectRows.push(
      { id: 'session-1', title: 'Old 1', workingDir: '/repo', updatedAt: 1_700_000_000_000 },
      { id: 'session-2', title: 'Old 2', workingDir: '/repo', updatedAt: 1_700_000_001_000 },
    );
    await expect(
      renameSessionTitlesInDb(
        [
          {
            sessionId: 'session-1',
            title: 'New 1',
            expectedCurrentTitle: 'Old 1',
          },
          {
            sessionId: 'session-2',
            title: 'New 2',
            expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
          },
        ],
        false,
      ),
    ).rejects.toThrow('PRECONDITION_FAILED');

    expect(h.tx).toHaveBeenCalledWith('sessions.renameTitles', {
      changes: [
        {
          sessionId: 'session-1',
          title: 'New 1',
          expectedCurrentTitle: 'Old 1',
        },
        {
          sessionId: 'session-2',
          title: 'New 2',
          expectedUpdatedAt: new Date(1_700_000_001_000).toISOString(),
        },
      ],
    });
    expect(h.fakeDb.transaction).not.toHaveBeenCalled();
    expect(h.updateSetCalls).toHaveLength(0);
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
    expect(h.webContentsSend).not.toHaveBeenCalled();
    expect(h.agentIslandService.handleSessionMetadataPatch).not.toHaveBeenCalled();
  });
});
