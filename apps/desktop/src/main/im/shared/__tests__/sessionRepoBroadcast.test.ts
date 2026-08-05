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
      // createSession upsert 后回读持久化行;返回空数组时回落 prepared row
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
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
});
