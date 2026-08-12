// @vitest-environment jsdom

/**
 * MessageNavRail 组件测试:显隐规则 / 刻度渲染与当前项标记 / 点击跳转回调。
 * 几何判定的分支矩阵在 messageNavRailModel.test.ts(纯函数);这里覆盖
 * 组件把 DOM 测量喂给纯函数后的端到端行为。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 预览卡内容不在本文件的覆盖范围(Content 直接丢掉,与原先 Tip stub 只透传
// children 等价)。Provider 放一个隐藏结构标记,直接断言当前 DOM 中的实例数,
// 避免 Windows 全量 shard 高负载时 useEffect 挂载计数尚未刷新造成误报。
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: {
    Provider: ({ children }: { children: ReactNode }) => (
      <>
        <span data-testid="message-nav-tooltip-provider" hidden />
        {children}
      </>
    ),
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: () => null,
  },
}));

import { MessageNavRail } from '../MessageNavRail';
import { NAV_RAIL_ACTIVE_FUDGE_PX, type NavRailEntry } from '../messageNavRailModel';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function mockRect(el: HTMLElement, rect: Partial<DOMRect>) {
  el.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    }) as DOMRect;
}

/** 造一个滚动容器 + 若干带 data-message-client-id 锚点的消息节点。 */
function buildScrollContainer(
  containerWidth: number,
  anchors: Array<{ id: string; top: number }>,
): HTMLDivElement {
  const root = document.createElement('div');
  mockRect(root, { width: containerWidth, height: 700, top: 0, bottom: 700 });
  for (const a of anchors) {
    const el = document.createElement('div');
    el.setAttribute('data-message-client-id', a.id);
    mockRect(el, { top: a.top, bottom: a.top + 40 });
    root.appendChild(el);
  }
  document.body.appendChild(root);
  return root;
}

const ENTRIES: NavRailEntry[] = [
  { id: 'u1', preview: '第一问' },
  { id: 'u2', preview: '第二问' },
  { id: 'u3', preview: '第三问' },
  { id: 'u4', preview: '第四问' },
  { id: 'u5', preview: '第五问' },
];

const MIXED_ENTRIES: NavRailEntry[] = [
  { id: 'u1', preview: '第一问' },
  { id: 'u2', preview: '自动任务提问', isAutomation: true },
  { id: 'u3', preview: '第三问' },
  { id: 'u4', preview: '第四问' },
  { id: 'u5', preview: '第五问' },
];

describe('MessageNavRail', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    // jsdom 没有 CSS.escape(真实渲染器 Chromium 提供);测试 id 都是安全字符。
    vi.stubGlobal('CSS', { escape: (s: string) => s });
  });

  it('宽容器 + ≥4 条提问:渲染全部刻度,当前项 = 最后一条越过阈值线的提问', async () => {
    // 容器宽 1000,内容列 880 → 两侧留白 60 ≥ 44,有空间。
    // 阈值线 = top(0) + NAV_RAIL_ACTIVE_FUDGE_PX:u1 / u2 已越过,
    // u3(400) 起还在下方 → 当前项 u2。
    const root = buildScrollContainer(1000, [
      { id: 'u1', top: -400 },
      { id: 'u2', top: NAV_RAIL_ACTIVE_FUDGE_PX - 10 },
      { id: 'u3', top: 400 },
      { id: 'u4', top: 600 },
      { id: 'u5', top: 900 },
    ]);
    render(
      <MessageNavRail
        entries={ENTRIES}
        scrollRef={{ current: root }}
        contentMaxWidth={880}
        bottomOffset={200}
        onJump={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button')).toHaveLength(5);
    });
    const buttons = screen.getAllByRole('button');
    expect(buttons[1].getAttribute('aria-current')).toBe('true');
    expect(buttons[0].getAttribute('aria-current')).toBeNull();
    expect(buttons[2].getAttribute('aria-current')).toBeNull();
  });

  it('整条导轨只挂一个 TooltipProvider(而不是每根刻度一个)', async () => {
    // skipDelayDuration 是 Provider 级状态:每根刻度各自一个 Provider 时,
    // 相邻刻度之间跨 Provider,新 Provider 没有"刚刚开过"的记忆,鼠标竖着
    // 划过去会看到预览卡反复消失再冒出(刻度纵距只有 9px)。这条守的就是
    // 「别退回每刻度一个 Provider」——闪断本身依赖 Radix 真实计时,在 jsdom
    // 里测不稳,所以断言结构不断言时序。
    const root = buildScrollContainer(1000, [
      { id: 'u1', top: -400 },
      { id: 'u2', top: 50 },
      { id: 'u3', top: 400 },
      { id: 'u4', top: 600 },
      { id: 'u5', top: 900 },
    ]);
    render(
      <MessageNavRail
        entries={ENTRIES}
        scrollRef={{ current: root }}
        contentMaxWidth={880}
        bottomOffset={200}
        onJump={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button')).toHaveLength(5);
    });
    expect(screen.getAllByTestId('message-nav-tooltip-provider')).toHaveLength(1);
  });

  it('点击刻度回调 onJump(clientId),且点击项乐观标记为当前项', async () => {
    const onJump = vi.fn();
    const root = buildScrollContainer(1000, [
      { id: 'u1', top: -400 },
      { id: 'u2', top: 50 },
      { id: 'u3', top: 400 },
      { id: 'u4', top: 600 },
      { id: 'u5', top: 900 },
    ]);
    render(
      <MessageNavRail
        entries={ENTRIES}
        scrollRef={{ current: root }}
        contentMaxWidth={880}
        bottomOffset={200}
        onJump={onJump}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button')).toHaveLength(5);
    });
    fireEvent.click(screen.getAllByRole('button')[4]);
    expect(onJump).toHaveBeenCalledWith('u5');
    expect(screen.getAllByRole('button')[4].getAttribute('aria-current')).toBe('true');
  });

  it('自动化提问使用更短的刻度,但保留相同点击定位入口', async () => {
    const root = buildScrollContainer(1000, [
      { id: 'u1', top: -400 },
      { id: 'u2', top: 50 },
      { id: 'u3', top: 400 },
      { id: 'u4', top: 600 },
      { id: 'u5', top: 900 },
    ]);
    render(
      <MessageNavRail
        entries={MIXED_ENTRIES}
        scrollRef={{ current: root }}
        contentMaxWidth={880}
        bottomOffset={200}
        onJump={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button')).toHaveLength(5);
    });
    const buttons = screen.getAllByRole('button');
    expect(buttons[1].getAttribute('data-message-nav-automation')).toBe('true');
    expect(buttons[0].getAttribute('data-message-nav-automation')).toBeNull();
    expect(buttons[1].querySelector('span')?.className).toContain('w-2');
    expect(buttons[0].querySelector('span')?.className).toContain('w-3');
  });

  it('渲染窗口外的锚点(DOM 缺失)视作已越过阈值', async () => {
    // 只有 u4 / u5 挂载且都在阈值下方 → 当前项 = 未挂载里最晚的 u3。
    const root = buildScrollContainer(1000, [
      { id: 'u4', top: 300 },
      { id: 'u5', top: 600 },
    ]);
    render(
      <MessageNavRail
        entries={ENTRIES}
        scrollRef={{ current: root }}
        contentMaxWidth={880}
        bottomOffset={200}
        onJump={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole('button')[2].getAttribute('aria-current')).toBe('true');
    });
  });

  it('提问少于 4 条不渲染', async () => {
    const root = buildScrollContainer(1000, [
      { id: 'u1', top: 100 },
      { id: 'u2', top: 300 },
      { id: 'u3', top: 500 },
    ]);
    const { container } = render(
      <MessageNavRail
        entries={ENTRIES.slice(0, 3)}
        scrollRef={{ current: root }}
        contentMaxWidth={880}
        bottomOffset={200}
        onJump={vi.fn()}
      />,
    );
    // 等一帧让 measure 跑完,仍不应出现任何刻度。
    await waitFor(() => {
      expect(container.querySelector('nav')).toBeNull();
    });
  });

  it('窄容器(内容列左侧留白不足)不渲染', async () => {
    // 容器 900,内容列 880 → 留白 10 < 44。
    const root = buildScrollContainer(900, [
      { id: 'u1', top: -400 },
      { id: 'u2', top: 50 },
      { id: 'u3', top: 400 },
      { id: 'u4', top: 600 },
      { id: 'u5', top: 900 },
    ]);
    const { container } = render(
      <MessageNavRail
        entries={ENTRIES}
        scrollRef={{ current: root }}
        contentMaxWidth={880}
        bottomOffset={200}
        onJump={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('nav')).toBeNull();
    });
  });
});
