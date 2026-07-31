// @vitest-environment jsdom

/**
 * GhostSummonCard chip 形态(2026-07-29 改版)回归:
 * - 标注行渲染意识名 + 状态文字;不再渲「调用插件 · GHOST」overline,
 *   也不再吞用户 prompt(合并形态已取消,正文由 UserMessage 气泡承载)。
 * - 状态文字对齐兑现事实:running「调用中…」;turn 结束后按
 *   GhostFulfillmentContext 区分「已调用/已完成」,不替 AI 撒谎。
 * - 法阵终态编舞:running→false 时缺口收拢(dasharray → 100 0)+ ✓ 弹出;
 *   历史消息(挂载即非 running)直接静态落终态帧,不播编舞。
 * - 展开抽屉保留透明性:$指令 徽章 + 指令原文双色分段。
 * - 未兑现软提示保持低调胶囊形态不变。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { GhostFulfillmentContext, GhostSummonCard } from '@/components/chat/GhostSummonCard';
import type { GhostDirectiveDisplay } from '@/cindy-brain/ghostCommand';

vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => [],
}));

const commandDirective: GhostDirectiveDisplay = {
  kind: 'command',
  command: 'xd-feishu',
  name: 'XD Feishu',
  ghostId: 'xd-feishu',
  raw: '[插件指令] 用户显式点名插件 XD Feishu(id: xd-feishu)',
};

const mentionDirective: GhostDirectiveDisplay = {
  kind: 'mention',
  ghosts: [{ name: 'XD Feishu', ghostId: 'xd-feishu' }],
  raw: '[插件提示] 消息提及了插件 XD Feishu(id: xd-feishu)',
};

/** 模拟 prefers-reduced-motion 匹配结果(jsdom 默认无 matchMedia)。 */
function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function fulfillmentOf(clientId: string, ghostIds: string[]) {
  return new Map<string, ReadonlySet<string>>([[clientId, new Set(ghostIds)]]);
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // biome-ignore lint/performance/noDelete: 还原 jsdom 默认(无 matchMedia)。
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('GhostSummonCard(chip 形态)', () => {
  it('renders the seal chip with plugin name and no overline/prompt slot', () => {
    render(<GhostSummonCard directive={commandDirective} running />);
    expect(screen.getByText('XD Feishu')).toBeTruthy();
    expect(screen.getByText('调用中…')).toBeTruthy();
    expect(screen.queryByText(/GHOST/)).toBeNull();
  });

  it('reports 已调用 only when the turn actually issued a ghost_call', () => {
    const { unmount } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" />
      </GhostFulfillmentContext.Provider>,
    );
    expect(screen.getByText('已调用')).toBeTruthy();
    unmount();

    render(<GhostSummonCard directive={commandDirective} messageClientId="m2" />);
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('mounts historic messages directly on the closed static frame', () => {
    const { container } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" />
      </GhostFulfillmentContext.Provider>,
    );
    const arcs = container.querySelectorAll('circle.summon-seal-arc');
    expect(arcs.length).toBe(2);
    for (const arc of arcs) {
      expect(arc.getAttribute('stroke-dasharray')).toBe('100 0');
    }
    // 静态终态:✓ 直显(fulfilled)但不挂弹出动画(历史消息零动画)。
    expect(container.querySelector('svg.lucide-check')).toBeTruthy();
    expect(container.querySelector('.summon-seal-tick-pop')).toBeNull();
  });

  it('closes neutrally without tick or halo when the plugin was never actually called', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <GhostSummonCard directive={commandDirective} messageClientId="m2" running />,
    );
    rerender(<GhostSummonCard directive={commandDirective} messageClientId="m2" running={false} />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // 环中性闭合 = turn 结束;不放 ✓/光晕伪造成功,状态文字为「已完成」。
    for (const arc of container.querySelectorAll('circle.summon-seal-arc')) {
      expect(arc.getAttribute('stroke-dasharray')).toBe('100 0');
    }
    expect(container.querySelector('svg.lucide-check')).toBeNull();
    expect(container.querySelector('.summon-seal-halo')).toBeNull();
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('plays the closing choreography when running flips false', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" running />
      </GhostFulfillmentContext.Provider>,
    );
    let arcs = container.querySelectorAll('circle.summon-seal-arc');
    expect(arcs[0]?.getAttribute('stroke-dasharray')).toBe('83 17');
    expect(arcs[1]?.getAttribute('stroke-dasharray')).toBe('39 61');

    rerender(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" running={false} />
      </GhostFulfillmentContext.Provider>,
    );
    // closing:缺口已收拢,旋转仍挂着(满圆前不摘)。
    arcs = container.querySelectorAll('circle.summon-seal-arc');
    for (const arc of arcs) {
      expect(arc.getAttribute('stroke-dasharray')).toBe('100 0');
    }
    expect(container.querySelector('.animate-\\[spin_2\\.4s_linear_infinite\\]')).toBeTruthy();

    // settling:光晕 + ✓ 弹出,旋转已摘除。
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.summon-seal-halo')).toBeTruthy();
    expect(container.querySelector('.summon-seal-tick-pop')).toBeTruthy();
    expect(container.querySelector('.animate-\\[spin_2\\.4s_linear_infinite\\]')).toBeNull();

    // done:光晕一次性卸载,✓ 常驻。
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(container.querySelector('.summon-seal-halo')).toBeNull();
    expect(container.querySelector('.summon-seal-tick-pop')).toBeTruthy();
  });

  it('skips the choreography under prefers-reduced-motion and lands on the terminal frame', () => {
    stubMatchMedia(true);
    vi.useFakeTimers();
    const { container, rerender } = render(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" running />
      </GhostFulfillmentContext.Provider>,
    );
    rerender(
      <GhostFulfillmentContext.Provider value={fulfillmentOf('m1', ['xd-feishu'])}>
        <GhostSummonCard directive={commandDirective} messageClientId="m1" running={false} />
      </GhostFulfillmentContext.Provider>,
    );
    // 不走 closing/settling 计时:立即闭合 + ✓ 直显 + 无旋转、无光晕。
    const arcs = container.querySelectorAll('circle.summon-seal-arc');
    for (const arc of arcs) {
      expect(arc.getAttribute('stroke-dasharray')).toBe('100 0');
    }
    expect(container.querySelector('.animate-\\[spin_2\\.4s_linear_infinite\\]')).toBeNull();
    expect(container.querySelector('.summon-seal-halo')).toBeNull();
    expect(container.querySelector('svg.lucide-check')).toBeTruthy();
  });

  it('keeps transparency: expanding reveals the $command badge and directive text', () => {
    render(<GhostSummonCard directive={commandDirective} messageClientId="m1" />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    // $指令 徽章 + 指令原文里的注入值,至少各出现一次。
    expect(screen.getAllByText('$xd-feishu').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('追加给模型的指令')).toBeTruthy();
  });

  it('keeps the low-key pill for unfulfilled mentions', () => {
    render(<GhostSummonCard directive={mentionDirective} messageClientId="m1" />);
    expect(screen.getByText(/提及插件/)).toBeTruthy();
    // 胶囊形态没有法阵。
    expect(document.querySelector('circle.summon-seal-arc')).toBeNull();
  });
});
