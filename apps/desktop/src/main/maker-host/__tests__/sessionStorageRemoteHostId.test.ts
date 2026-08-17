/**
 * #1 回归:`maker.createSession()` 这条入库路径(maker:create-session IPC / scheduler /
 * Feishu / Orca 都经由 DesktopSessionStorage.create())也必须规范化 remoteHostId,
 * 不能让空串 / 空白原样落库 —— 否则 renderer 按 `remoteHostId ? remote : local` 分组时
 * 把它当本地,而 maker 侧又拿着一个"看似 remote"的空值,语义分裂。
 *
 * 这里 mock 掉 db client,只断言传给 insert().values() 的 row.remoteHostId。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock 工厂会被 hoist 到 import 之上,引用模块级 let 会报未初始化;用 vi.hoisted 兜住。
const h = vi.hoisted(() => ({
  captured: null as Record<string, unknown> | null,
  updateSet: null as Record<string, unknown> | null,
  updateReturning: [] as Array<{ id: string }>,
  whereCalled: false,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          h.captured = row;
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          h.updateSet = patch;
          return {
            where: () => {
              h.whereCalled = true;
              return { returning: async () => h.updateReturning };
            },
          };
        },
      }),
    },
  }),
}));

import { DesktopSessionStorage } from '../session-storage';

describe('DesktopSessionStorage.create remoteHostId 规范化', () => {
  beforeEach(() => {
    h.captured = null;
  });

  const base = {
    id: 's1',
    title: 'New Maker',
    workDir: '/repo',
    model: 'gpt-5.5',
    agentKind: 'codex' as const,
  };

  it('空白 host 落 null(本地语义)', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base, remoteHostId: '   ' } as any);
    expect(h.captured?.remoteHostId).toBeNull();
  });

  it('空串 host 落 null', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base, remoteHostId: '' } as any);
    expect(h.captured?.remoteHostId).toBeNull();
  });

  it('有效 host trim 后保留', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base, remoteHostId: ' host-a ' } as any);
    expect(h.captured?.remoteHostId).toBe('host-a');
  });

  it('未传 host 落 null', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base } as any);
    expect(h.captured?.remoteHostId).toBeNull();
  });
});

describe('DesktopSessionStorage.create workspaceKind', () => {
  beforeEach(() => {
    h.captured = null;
  });

  const base = {
    id: 'dialogue-session',
    title: 'New Maker',
    workDir: '/userData/dialogues/2026-06-29/dialogue-session',
    model: 'gpt-5.4',
    agentKind: 'codex' as const,
  };

  it('保留显式 dialogue 分类,即使会话有真实 workingDir', async () => {
    const storage = new DesktopSessionStorage();
    await storage.create({ ...base, workspaceKind: 'dialogue' });
    expect(h.captured?.workspaceKind).toBe('dialogue');
    expect(h.captured?.workingDir).toBe('/userData/dialogues/2026-06-29/dialogue-session');
  });

  it('未传 workspaceKind 仍按历史默认 project 落库', async () => {
    const storage = new DesktopSessionStorage();
    await storage.create(base);
    expect(h.captured?.workspaceKind).toBe('project');
  });

  it('非法 workspaceKind 不会原样落库', async () => {
    const storage = new DesktopSessionStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await storage.create({ ...base, workspaceKind: 'scratch' } as any);
    expect(h.captured?.workspaceKind).toBe('project');
  });
});

describe('DesktopSessionStorage.create Review purpose', () => {
  beforeEach(() => {
    h.captured = null;
  });

  it('persists Review source in the same insert that creates the session', async () => {
    const storage = new DesktopSessionStorage();
    await storage.create({
      id: 'review-session',
      title: 'Review',
      workDir: '/repo',
      model: 'gpt-5.5',
      agentKind: 'codex',
      reviewMode: true,
    });
    expect(h.captured?.source).toBe('review');
  });
});

describe('DesktopSessionStorage.create workingDir 规范化', () => {
  beforeEach(() => {
    h.captured = null;
  });

  it('Windows 反斜杠路径入库前归一为 storage spelling', async () => {
    const storage = new DesktopSessionStorage();
    const created = await storage.create({
      id: 'windows-path-session',
      title: 'New Maker',
      workDir: 'D:\\repo\\project\\',
      model: 'gpt-5.4',
      agentKind: 'codex',
    });
    expect(h.captured?.workingDir).toBe('D:/repo/project');
    expect(created.workDir).toBe('D:/repo/project');
  });
});

describe('DesktopSessionStorage.compareAndClearSdkSessionId', () => {
  beforeEach(() => {
    h.updateSet = null;
    h.updateReturning = [];
    h.whereCalled = false;
  });
  it('用单条条件 update 清空旧 id，并按 returning 报告 CAS 是否命中', async () => {
    const storage = new DesktopSessionStorage();
    h.updateReturning = [{ id: 'session-1' }];
    await expect(storage.compareAndClearSdkSessionId('session-1', 'sdk-old')).resolves.toBe(true);
    expect(h.updateSet?.sdkSessionId).toBeNull();
    expect(h.updateSet?.updatedAt).toEqual(expect.any(Number));
    expect(h.whereCalled).toBe(true);
    h.updateReturning = [];
    await expect(storage.compareAndClearSdkSessionId('session-1', 'sdk-stale')).resolves.toBe(false);
  });
});
