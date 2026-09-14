/**
 * 会话搜索 IPC:`unnamedLabel` 必须原样转发到 searchConversations。
 *
 * 这条测试是补第 6 轮 review 抓到的洞:handler 用白名单重建请求对象,新增字段不加进来
 * 就会被静默丢掉 —— renderer 传了、main 收不到,表现是「搜界面上看得见的兜底文案搜不到、
 * 搜内部哨兵 New Maker 反而命中」,而 conversationSearch.ts 那侧的实现完全正确。
 * 上一轮只钉了投影函数被正确调用,没钉过 IPC 边界(PR #1031)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  searchConversations: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: h.ipcHandle },
}));
vi.mock('../conversationSearch.js', () => ({
  searchConversations: h.searchConversations,
}));

import { registerSearchIpc } from '../ipc/search.js';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

function handler(): Handler {
  registerSearchIpc();
  const call = h.ipcHandle.mock.calls.find(([channel]) => channel === 'local-db:conversations:search');
  if (!call) throw new Error('search handler not registered');
  return call[1] as Handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.searchConversations.mockResolvedValue({
    query: 'needle',
    results: [],
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  });
});

describe('local-db:conversations:search — agentKind=pi', () => {
  it('accepts filters.agentKind pi so remote Pi search is not rejected', async () => {
    await handler()(null, {
      query: 'needle',
      filters: { agentKind: 'pi' },
    });

    expect(h.searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ agentKind: 'pi' }),
      }),
    );
  });
});

describe('local-db:conversations:search — lastActivity', () => {
  it('forwards the recent-activity window with a keyword query', async () => {
    await handler()(null, {
      query: 'needle',
      filters: { lastActivity: '3d' },
    });

    expect(h.searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'needle',
        filters: expect.objectContaining({ lastActivity: '3d' }),
      }),
    );
  });

  it('does not turn a time filter into an empty-keyword search', async () => {
    const invoke = handler();
    await expect(invoke(null, {
      query: '',
      filters: { lastActivity: '3d' },
    })).rejects.toThrow();
    expect(h.searchConversations).not.toHaveBeenCalled();
  });
});

describe('local-db:conversations:search — workingDirs 透传', () => {
  it('keeps filters.workingDirs so project search is not widened to all sessions', async () => {
    await handler()(null, {
      query: 'needle',
      filters: { workingDirs: ['/repo-remote'] },
    });

    expect(h.searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ workingDirs: ['/repo-remote'] }),
      }),
    );
  });
});

describe('local-db:conversations:search — unnamedLabel 透传', () => {
  it('把 renderer 的已解析文案原样带给 searchConversations', async () => {
    await handler()(null, { query: 'needle', unnamedLabel: '未命名任务' });

    expect(h.searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'needle', unnamedLabel: '未命名任务' }),
    );
  });

  it('不做 trim / 归一:改一个字符就会让两端的命中下标错位', async () => {
    // main 算 titleMatchIndices、renderer 渲染同一个串,逐字一致是高亮对齐的前提。
    await handler()(null, { query: 'needle', unnamedLabel: ' Untitled session ' });

    expect(h.searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({ unnamedLabel: ' Untitled session ' }),
    );
  });

  it('没传 / 空白 → undefined(旧 renderer 构建按原始哨兵匹配,不炸)', async () => {
    const invoke = handler();
    await invoke(null, { query: 'needle' });
    await invoke(null, { query: 'needle', unnamedLabel: '   ' });

    for (const call of h.searchConversations.mock.calls) {
      expect((call[0] as { unnamedLabel?: string }).unnamedLabel).toBeUndefined();
    }
  });

  it('类型不对或长度离谱 → INVALID_PARAMS,不静默截断', async () => {
    const invoke = handler();
    await expect(invoke(null, { query: 'needle', unnamedLabel: 42 })).rejects.toThrow();
    await expect(
      invoke(null, { query: 'needle', unnamedLabel: 'x'.repeat(121) }),
    ).rejects.toThrow();
    expect(h.searchConversations).not.toHaveBeenCalled();
  });
});
