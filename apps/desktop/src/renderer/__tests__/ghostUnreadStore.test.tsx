// @vitest-environment jsdom
/**
 * ghostUnreadStore.test.tsx — 未读角标 renderer store 的订阅语义。
 * ---------------------------------------------------------------------------
 * 覆盖:首帧 unreadSync 快照(绿点不许晚一帧跳出来)、推送增删、per-ghostId 的
 * primitive 订阅(挂载 N 行不退回整表)、聚合 hook、以及"本地先熄灭再报主机"。
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: Array<(p: { ghostId: string; unread: boolean; summary?: string; at?: number }) => void> = [];
const snapshotListeners: Array<
  (p: { entries: Array<{ ghostId: string; summary?: string; at: number }> }) => void
> = [];
const clearUnread = vi.fn(() => Promise.resolve({ ok: true }));
const unreadSync = vi.fn(() => ({
  entries: [{ ghostId: 'inbox', summary: '3 条新工单', at: 100 }],
}));

beforeEach(() => {
  listeners.length = 0;
  snapshotListeners.length = 0;
  clearUnread.mockClear();
  unreadSync.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: {
      unreadSync,
      clearUnread,
      onBadge: (cb: (typeof listeners)[number]) => {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      onUnreadSnapshot: (cb: (typeof snapshotListeners)[number]) => {
        snapshotListeners.push(cb);
        return () => {
          const i = snapshotListeners.indexOf(cb);
          if (i >= 0) snapshotListeners.splice(i, 1);
        };
      },
    },
  };
  vi.resetModules();
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function loadStore() {
  const mod = await import('../cindy-brain/ghostUnreadStore');
  mod.__resetGhostUnreadForTest();
  return mod;
}

function push(payload: { ghostId: string; unread: boolean; summary?: string; at?: number }): void {
  act(() => {
    for (const cb of [...listeners]) cb(payload);
  });
}

describe('ghostUnreadStore', () => {
  it('首帧就带上 unreadSync 的快照(绿点与插件入口同帧,不晚一帧跳出来)', async () => {
    const { useGhostUnread, useGhostUnreadSummary } = await loadStore();
    function Probe() {
      return (
        <span data-testid="row">
          {useGhostUnread('inbox') ? 'on' : 'off'}:{useGhostUnreadSummary('inbox') ?? '-'}
        </span>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId('row').textContent).toBe('on:3 条新工单');
    expect(unreadSync).toHaveBeenCalledTimes(1);
  });

  it('推送点亮 / 熄灭都反映到订阅者;摘要跟着最新一次点亮走', async () => {
    const { useGhostUnread, useGhostUnreadSummary } = await loadStore();
    function Probe() {
      return (
        <span data-testid="row">
          {useGhostUnread('mail') ? 'on' : 'off'}:{useGhostUnreadSummary('mail') ?? '-'}
        </span>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId('row').textContent).toBe('off:-');
    push({ ghostId: 'mail', unread: true, summary: '1 封新邮件', at: 1 });
    expect(screen.getByTestId('row').textContent).toBe('on:1 封新邮件');
    push({ ghostId: 'mail', unread: true, summary: '2 封新邮件', at: 2 });
    expect(screen.getByTestId('row').textContent).toBe('on:2 封新邮件');
    push({ ghostId: 'mail', unread: false });
    expect(screen.getByTestId('row').textContent).toBe('off:-');
  });

  it('按 ghostId 精准订阅:别的意识点亮不重渲染本行(性能不变量)', async () => {
    const { useGhostUnread } = await loadStore();
    const renders = { count: 0 };
    function Row() {
      renders.count += 1;
      return <span>{useGhostUnread('mail') ? 'on' : 'off'}</span>;
    }
    render(<Row />);
    const before = renders.count;
    push({ ghostId: 'other', unread: true, at: 1 });
    // useSyncExternalStore 的快照没变 → React 不该重跑本组件。
    expect(renders.count).toBe(before);
    push({ ghostId: 'mail', unread: true, at: 2 });
    expect(renders.count).toBeGreaterThan(before);
  });

  it('聚合 hook:任一意识有未读即为真(侧栏插件入口的静态点)', async () => {
    const { useAnyGhostUnread, __resetGhostUnreadForTest } = await loadStore();
    // 起点清空,免得 unreadSync 的快照把这条测试变成恒真。
    unreadSync.mockReturnValueOnce({ entries: [] });
    __resetGhostUnreadForTest();
    function Probe() {
      return <span data-testid="any">{useAnyGhostUnread() ? 'yes' : 'no'}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('any').textContent).toBe('no');
    push({ ghostId: 'a', unread: true, at: 1 });
    push({ ghostId: 'b', unread: true, at: 2 });
    expect(screen.getByTestId('any').textContent).toBe('yes');
    push({ ghostId: 'a', unread: false });
    expect(screen.getByTestId('any').textContent).toBe('yes'); // b 还亮着
    push({ ghostId: 'b', unread: false });
    expect(screen.getByTestId('any').textContent).toBe('no');
  });

  it('用户已读:本地先熄灭再报主机(面板已在眼前,点还亮着半秒是可见的错)', async () => {
    const { useGhostUnread, clearGhostUnread } = await loadStore();
    function Probe() {
      return <span data-testid="row">{useGhostUnread('inbox') ? 'on' : 'off'}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('row').textContent).toBe('on');
    act(() => clearGhostUnread('inbox'));
    expect(screen.getByTestId('row').textContent).toBe('off');
    expect(clearUnread).toHaveBeenCalledWith('inbox');
  });

  it('换账号快照整表替换 —— 账号 A 的点与摘要不许留在账号 B 的界面上', async () => {
    const { useGhostUnread, useGhostUnreadSummary } = await loadStore();
    function Probe({ id }: { id: string }) {
      return (
        <span data-testid={id}>
          {useGhostUnread(id) ? 'on' : 'off'}:{useGhostUnreadSummary(id) ?? '-'}
        </span>
      );
    }
    render(
      <>
        <Probe id="inbox" />
        <Probe id="mail" />
      </>,
    );
    // 起点是账号 A:unreadSync 的快照点亮了 inbox。
    expect(screen.getByTestId('inbox').textContent).toBe('on:3 条新工单');

    // 切到账号 B:main 推来 B 自己的账本(inbox 不在其中)。
    act(() => {
      for (const cb of [...snapshotListeners]) {
        cb({ entries: [{ ghostId: 'mail', summary: 'B 的邮件', at: 5 }] });
      }
    });
    expect(screen.getByTestId('inbox').textContent).toBe('off:-');
    expect(screen.getByTestId('mail').textContent).toBe('on:B 的邮件');

    // 登出:空快照把界面清干净。
    act(() => {
      for (const cb of [...snapshotListeners]) cb({ entries: [] });
    });
    expect(screen.getByTestId('mail').textContent).toBe('off:-');
  });

  it('unreadSync 抛错时按"全无未读"起步,后续推送照常生效(未读是提醒不是内容)', async () => {
    unreadSync.mockImplementationOnce(() => {
      throw new Error('store broken');
    });
    const { useGhostUnread } = await loadStore();
    function Probe() {
      return <span data-testid="row">{useGhostUnread('inbox') ? 'on' : 'off'}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('row').textContent).toBe('off');
    push({ ghostId: 'inbox', unread: true, at: 1 });
    expect(screen.getByTestId('row').textContent).toBe('on');
  });
});
