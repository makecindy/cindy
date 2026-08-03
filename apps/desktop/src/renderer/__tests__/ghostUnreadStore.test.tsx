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

  it('首帧就正确:快照必须在**第一次 getSnapshot** 之前就绪,不许晚一帧', async () => {
    const { useGhostUnread, useGhostUnreadSummary, useAnyGhostUnread } = await loadStore();
    // 逐次 render 记录快照值:只要出现过一次 false→true 的翻转,就说明绿点是
    // 晚一帧跳出来的(useSyncExternalStore 订阅后复查才纠正),而不是首帧就对。
    const frames: string[] = [];
    function Probe() {
      frames.push(
        `${useGhostUnread('inbox')}|${useGhostUnreadSummary('inbox') ?? '-'}|${useAnyGhostUnread()}`,
      );
      return null;
    }
    render(<Probe />);
    expect(frames.length).toBeGreaterThan(0);
    // 第一帧就必须带上 unreadSync 的内容。
    expect(frames[0]).toBe('true|3 条新工单|true');
    // 之后每一帧都一样(没有纠正性的第二次 render)。
    expect(new Set(frames).size).toBe(1);
  });

  it('先绑监听再取快照 —— 同步读期间到达的推送不会丢', async () => {
    // 用 unreadSync 的执行时刻模拟那个窗口:它被调用时,监听如果已经绑好,
    // 这条推送就能被接住;如果顺序反了(先读后绑),它无人接收,而就绪标记已置位
    // 不会再读,那颗点会一直缺到重启。
    unreadSync.mockImplementationOnce(() => {
      for (const cb of [...listeners]) cb({ ghostId: 'mail', unread: true, at: 9 });
      return { entries: [] };
    });
    const { useGhostUnread } = await loadStore();
    function Probe() {
      return <span data-testid="row">{useGhostUnread('mail') ? 'on' : 'off'}</span>;
    }
    render(<Probe />);
    expect(listeners.length).toBeGreaterThan(0); // 读之前监听确实已绑上
    expect(screen.getByTestId('row').textContent).toBe('on');
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
    // 必须带上"当时看到的那条"的点亮时刻,main 据此条件删除。
    expect(clearUnread).toHaveBeenCalledWith('inbox', 100);
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

  it('前台判据:窗口最小化 / 失焦时为假 —— 常开面板不许把用户没看见的未读吞掉', async () => {
    const { useHostWindowForeground } = await loadStore();
    let visibility: DocumentVisibilityState = 'visible';
    let focused = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);

    function Probe() {
      return <span data-testid="fg">{useHostWindowForeground() ? 'fg' : 'bg'}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('fg').textContent).toBe('fg');

    // 最小化 / 切到后台 → visibilityState 变 hidden。
    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByTestId('fg').textContent).toBe('bg');

    // 恢复可见但没聚焦(被别的窗口盖住 / 用户在别的 app)→ 仍然不算看见。
    visibility = 'visible';
    focused = false;
    act(() => window.dispatchEvent(new Event('blur')));
    expect(screen.getByTestId('fg').textContent).toBe('bg');

    // 用户切回来 → 这一刻才算看见。
    focused = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(screen.getByTestId('fg').textContent).toBe('fg');

    vi.restoreAllMocks();
  });

  it('元素可见判据:已挂载但被压成零宽/隐藏时为假,切回可见才转真', async () => {
    // 同一前台窗口里另一个停靠面板被最大化 → 本面板仍挂载但零宽。只看窗口
    // foreground 会把这段时间到来的未读当成已读吞掉(codex review)。
    type IoCb = (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void;
    let fire: IoCb | null = null;
    const disconnect = vi.fn();
    const observed: Element[] = [];
    class FakeIO {
      constructor(cb: IoCb) {
        fire = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect = disconnect;
    }
    vi.stubGlobal('IntersectionObserver', FakeIO);

    const { useElementVisible } = await loadStore();
    function Probe({ show = true }: { show?: boolean }) {
      const { ref, visible } = useElementVisible();
      return show ? (
        <div ref={ref} data-testid="vis">
          {visible ? 'vis' : 'hidden'}
        </div>
      ) : (
        <span data-testid="vis">gone</span>
      );
    }
    const { unmount, rerender } = render(<Probe />);
    // **首帧必须是"尚未观测到可见"**:IntersectionObserver 的首次结果下一拍才到,
    // 这期间面板可能正躺在被邻居最大化压成零宽的容器里。初值若为可见,清零 effect
    // 会在首帧就把未读消费掉(greptile review P1)。
    expect(screen.getByTestId('vis').textContent).toBe('hidden');
    // 被最大化的邻居压成零宽:不相交、比例 0。
    act(() => fire?.([{ isIntersecting: false, intersectionRatio: 0 }]));
    expect(screen.getByTestId('vis').textContent).toBe('hidden');
    // 用户切回本面板 → 重新占面积,这一刻才算看见。
    act(() => fire?.([{ isIntersecting: true, intersectionRatio: 1 }]));
    expect(screen.getByTestId('vis').textContent).toBe('vis');

    // 崩溃走 fallback:host 节点脱离 DOM → 观察器解绑,判据回落到"还不知道"。
    const before = observed.length;
    rerender(<Probe show={false} />);
    expect(disconnect).toHaveBeenCalled();
    // 用户点「重载」生成**新的** host:必须重新观察新节点,否则那颗点永远清不掉。
    rerender(<Probe show />);
    expect(observed.length).toBeGreaterThan(before);
    act(() => fire?.([{ isIntersecting: true, intersectionRatio: 1 }]));
    expect(screen.getByTestId('vis').textContent).toBe('vis');
    unmount();
    expect(disconnect).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('环境不支持 IntersectionObserver 时 fail-open —— 不因判据缺失而永远清不掉', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { useElementVisible } = await loadStore();
    function Probe() {
      const { ref, visible } = useElementVisible();
      return (
        <span ref={ref} data-testid="vis">
          {visible ? 'vis' : 'hidden'}
        </span>
      );
    }
    render(<Probe />);
    expect(screen.getByTestId('vis').textContent).toBe('vis');
    vi.unstubAllGlobals();
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
