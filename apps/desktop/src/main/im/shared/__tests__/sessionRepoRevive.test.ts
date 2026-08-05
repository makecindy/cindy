/**
 * 回归 #748:飞书/Slack 等 IM 渠道用确定性 session id(同一 bot×用户永远同一行),
 * 该行被桌面端归档/删除(软删,行仍在库里)后,用户从 IM 侧继续发消息曾走
 * "findActiveSession 返 null → 同 id INSERT" 撞 UNIQUE(sessions.id),之后每条
 * 消息都稳定报错。修复:
 *   - findActiveSession 命中软删行时原地复活(status 翻回 active),保留
 *     sdkSessionId(上下文)与模型/权限设置,并广播 created 让 sidebar 重现该会话;
 *   - createSession 的 INSERT 带 onConflictDoUpdate 兜并发竞态,冲突时只翻
 *     status 不碰上下文列。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const updateWhere = vi.fn(async (_where: unknown) => {});
  const updateSet = vi.fn((_set: unknown) => ({ where: updateWhere }));
  const insertConflict = vi.fn(async (_conflict: unknown) => {});
  const insertValues = vi.fn((_values: unknown) => ({ onConflictDoUpdate: insertConflict }));
  const selectLimit = vi.fn(async (): Promise<unknown[]> => []);
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    updateSet,
    updateWhere,
    insertConflict,
    insertValues,
    selectLimit,
    webContentsSend: vi.fn(),
    tapWindowBroadcast: vi.fn(),
  };
});

// 用轻量 eq 替身让断言能直接核对 WHERE 的列与值(真 eq 返回不可比对的 SQL 对象)
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mocks.webContentsSend } },
    ],
  },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  tapWindowBroadcast: mocks.tapWindowBroadcast,
}));
vi.mock('../../../logger', () => ({
  createLogger: () => mocks.logger,
  maskPath: (p: string) => p,
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({ where: () => ({ limit: mocks.selectLimit }) }),
      }),
      update: () => ({ set: mocks.updateSet }),
      insert: () => ({ values: mocks.insertValues }),
    },
  }),
}));
vi.mock('../../../localDb/schema', () => ({ sessions: { id: 'sessions.id' } }));
vi.mock('../../../maker-host/session-provider-store', () => ({
  setSessionProvider: vi.fn(),
}));
vi.mock('../../defaultSessionSettings', () => ({
  getImDefaultEffortFor: vi.fn(() => 'high'),
  resolveImSessionDefaults: vi.fn(async () => ({
    agentKind: 'claude-code',
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    providerId: null,
  })),
}));

import { createImSessionRepo, type ImSessionRow } from '../sessionRepo';
import type { ImOrchestratorConfig, ImSessionNamespace } from '../types';

const ns: ImSessionNamespace = {
  source: 'feishu',
  sessionIdFor: (bot: string, user: string) => `feishu_${bot}_${user}`,
  defaultTitle: () => '飞书',
  ensureWorkingDir: () => '/tmp/im-working-dir/bot',
  extraInsertColumns: (bot: string, user: string) => ({
    feishuBotAppId: bot,
    feishuOpenId: user,
  }),
} as unknown as ImSessionNamespace;

function dbRow(status: 'active' | 'archived' | 'deleted') {
  return {
    id: 'feishu_bot_user',
    status,
    agentKind: 'cc',
    workingDir: '/tmp/im-working-dir/bot',
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    sdkSessionId: 'sdk-ctx-1',
    providerId: null,
  };
}

function makeRepo() {
  return createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);
}

describe('sessionRepo.findActiveSession 软删行复活(#748)', () => {
  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.updateWhere.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.webContentsSend.mockClear();
    mocks.tapWindowBroadcast.mockClear();
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it.each(['archived', 'deleted'] as const)(
    '%s 残留行复活为 active 并返回,保留 sdkSessionId 上下文',
    async (status) => {
      mocks.selectLimit.mockResolvedValue([dbRow(status)]);
      const row = await makeRepo().findActiveSession('bot', 'user');

      expect(row).not.toBeNull();
      expect(row!.id).toBe('feishu_bot_user');
      expect(row!.sdkSessionId).toBe('sdk-ctx-1');
      expect(mocks.updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active', userSendAt: expect.any(Number) }),
      );
      // 复活的 update 不允许触碰上下文/设置列
      const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty('sdkSessionId');
      expect(setArg).not.toHaveProperty('model');
      expect(setArg).not.toHaveProperty('permissionMode');
      // WHERE 必须精确锁定本会话行,防止误写成全表 update
      expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
      expect(mocks.updateWhere).toHaveBeenCalledWith({
        col: 'sessions.id',
        val: 'feishu_bot_user',
      });
      // 广播 created 让 sidebar 重拉列表、会话重新出现
      expect(mocks.webContentsSend).toHaveBeenCalledWith('local-db:sessions:created', {
        sessionId: 'feishu_bot_user',
      });
      expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:created', {
        sessionId: 'feishu_bot_user',
      });
    },
  );

  it('active 行直接返回,不发 update 不广播', async () => {
    mocks.selectLimit.mockResolvedValue([dbRow('active')]);
    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).not.toBeNull();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.webContentsSend).not.toHaveBeenCalled();
  });

  it('无行返回 null,不发 update', async () => {
    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).toBeNull();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});

const preparedDefaults: ImSessionRow = {
  id: 'feishu_bot_user',
  agentKind: 'claude-code',
  workingDir: '/tmp/im-working-dir/bot',
  model: 'claude-opus-4-8',
  effort: 'high',
  permissionMode: 'auto',
  fastMode: false,
  sdkSessionId: null,
  providerId: null,
};

describe('sessionRepo.createSession upsert 兜竞态(#748)', () => {
  beforeEach(() => {
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it('INSERT 带 onConflictDoUpdate:冲突时只翻 status/渠道列,不碰上下文列', async () => {
    await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertConflict).toHaveBeenCalledTimes(1);
    const conflictArg = mocks.insertConflict.mock.calls[0][0] as {
      target: unknown;
      set: Record<string, unknown>;
    };
    expect(conflictArg.set).toMatchObject({
      status: 'active',
      source: 'feishu',
      feishuBotAppId: 'bot',
      feishuOpenId: 'user',
    });
    expect(conflictArg.set).not.toHaveProperty('sdkSessionId');
    expect(conflictArg.set).not.toHaveProperty('model');
    expect(conflictArg.set).not.toHaveProperty('effort');
    expect(conflictArg.set).not.toHaveProperty('permissionMode');
    expect(conflictArg.set).not.toHaveProperty('title');
  });

  it('upsert 后以 DB 持久化行为准返回:冲突分支保留的上下文/设置不被 defaults 顶掉', async () => {
    mocks.selectLimit.mockResolvedValue([
      { ...dbRow('active'), model: 'old-model', effort: 'low', sdkSessionId: 'sdk-ctx-1' },
    ]);
    const result = await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(result.sdkSessionId).toBe('sdk-ctx-1');
    expect(result.model).toBe('old-model');
    expect(result.effort).toBe('low');
    expect(result.agentKind).toBe('claude-code');
  });

  it('回读为空(极端竞态行被删)时回落 prepared defaults,不抛错', async () => {
    const result = await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(result).toEqual(preparedDefaults);
  });
});

describe('sessionRepo workspaceKind(渠道声明 dialogue 归组时)', () => {
  const dialogueNs = { ...ns, workspaceKind: 'dialogue' } as unknown as ImSessionNamespace;

  function makeDialogueRepo() {
    return createImSessionRepo(
      { agentKind: 'claude-code' } as ImOrchestratorConfig,
      dialogueNs,
    );
  }

  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it('INSERT values 与冲突 set 都落 workspaceKind=dialogue(老行随下一条消息校正)', async () => {
    await makeDialogueRepo().createSession('bot', 'user', undefined, preparedDefaults);

    const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(values.workspaceKind).toBe('dialogue');
    const conflictArg = mocks.insertConflict.mock.calls[0][0] as {
      set: Record<string, unknown>;
    };
    expect(conflictArg.set.workspaceKind).toBe('dialogue');
  });

  it('软删行复活时一并校正 workspaceKind', async () => {
    mocks.selectLimit.mockResolvedValue([dbRow('archived')]);
    await makeDialogueRepo().findActiveSession('bot', 'user');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', workspaceKind: 'dialogue' }),
    );
  });

  it('渠道未声明 workspaceKind 时不写该列(保持默认 project 语义)', async () => {
    await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(values).not.toHaveProperty('workspaceKind');
    const conflictArg = mocks.insertConflict.mock.calls[0][0] as {
      set: Record<string, unknown>;
    };
    expect(conflictArg.set).not.toHaveProperty('workspaceKind');
  });
});
