/**
 * 回归:IM 渠道 repo.createSession 建行后必须广播 `local-db:sessions:created`
 * (本机窗口 + device-link tap)。漏广播时 Slack / 飞书消息自动建的会话不会
 * 出现在 sidebar,要用户手动刷新才可见(2026-07 Slack 实踩)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const insertConflict = vi.fn(async () => {});
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    insertConflict,
    insertValues: vi.fn(() => ({ onConflictDoUpdate: insertConflict })),
    // createSession upsert 后回读持久化行;返回空数组时回落 prepared row
    selectLimit: vi.fn<() => Promise<Array<{ title?: string | null }>>>(async () => []),
    updateSet: vi.fn(),
    updateWhere: vi.fn(async () => undefined),
    webContentsSend: vi.fn(),
    tapWindowBroadcast: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mocks.webContentsSend } },
    ],
  },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: mocks.tapWindowBroadcast,
}));
vi.mock('../../../logger', () => ({
  createLogger: () => mocks.logger,
  maskPath: (p: string) => p,
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      insert: () => ({ values: mocks.insertValues }),
      select: () => ({ from: () => ({ where: () => ({ limit: mocks.selectLimit }) }) }),
      // resolveSessionTitle 标题回写链: update().set().where()
      update: () => ({
        set: mocks.updateSet.mockReturnValue({ where: mocks.updateWhere }),
      }),
    },
  }),
}));
vi.mock('../../../localDb/schema', () => ({ sessions: {} }));
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
  source: 'slack',
  sessionIdFor: (bot: string, user: string, scope?: string) =>
    `slack-${bot}-${user}${scope ? `-${scope}` : ''}`,
  defaultTitle: () => 'Slack',
  ensureWorkingDir: () => 'E:\\Work',
  extraInsertColumns: () => ({}),
} as unknown as ImSessionNamespace;

const preparedRow: ImSessionRow = {
  id: 'slack-bot-user',
  agentKind: 'claude-code',
  workingDir: 'E:\\Work',
  model: 'claude-opus-4-8',
  effort: 'high',
  permissionMode: 'auto',
  fastMode: false,
  sdkSessionId: null,
  providerId: null,
};

describe('sessionRepo.createSession broadcast', () => {
  beforeEach(() => {
    mocks.webContentsSend.mockClear();
    mocks.tapWindowBroadcast.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
  });

  it('建行后广播 local-db:sessions:created 到本机窗口与 device-link tap', async () => {
    const repo = createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);
    await repo.createSession('bot', 'user', undefined, preparedRow);

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.webContentsSend).toHaveBeenCalledWith('local-db:sessions:created', {
      sessionId: 'slack-bot-user',
    });
    expect(mocks.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:created', {
      sessionId: 'slack-bot-user',
    });
  });

  it('DB 插入失败时不广播(避免 renderer 重拉到不存在的行)', async () => {
    mocks.insertConflict.mockRejectedValueOnce(new Error('insert failed'));
    const repo = createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);

    await expect(repo.createSession('bot', 'user', undefined, preparedRow)).rejects.toThrow(
      'insert failed',
    );
    expect(mocks.webContentsSend).not.toHaveBeenCalled();
    expect(mocks.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('resolveSessionTitle 解析出标题时回写行并广播 sessions:patched; null 不动', async () => {
    const resolveSessionTitle = vi.fn<
      (userId: string, scopeKey?: string) => Promise<string | null>
    >(async () => '[飞书·群] 产品交流群');
    const repo = createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, {
      ...ns,
      resolveSessionTitle,
    });
    await repo.createSession('bot', 'user', undefined, preparedRow);

    expect(mocks.updateSet).toHaveBeenCalledWith({ title: '[飞书·群] 产品交流群' });
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
    expect(mocks.webContentsSend).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'slack-bot-user',
      patch: { title: '[飞书·群] 产品交流群' },
    });

    resolveSessionTitle.mockResolvedValueOnce(null);
    mocks.updateSet.mockClear();
    await repo.createSession('bot', 'user', undefined, preparedRow);
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it('resolveSessionTitle 只对新建行生效 — 复活行保留历史标题不回调解析器', async () => {
    // upsert 前预检 select 返回已存在的行 → 复活路径, 不解析标题
    // (oneshot 拼装过的话题名不能被渠道解析结果刷掉)。
    mocks.selectLimit.mockResolvedValueOnce([{ title: '[飞书·群名·简介] abc123' }]);
    const resolveSessionTitle = vi.fn<
      (userId: string, scopeKey?: string) => Promise<string | null>
    >(async () => '[飞书·群] 产品交流群');
    const repo = createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, {
      ...ns,
      resolveSessionTitle,
    });
    mocks.updateSet.mockClear();
    await repo.createSession('bot', 'user', undefined, preparedRow);
    expect(resolveSessionTitle).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
