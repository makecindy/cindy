// @vitest-environment jsdom
// GhostPanelBubbleLayer:幽灵球单形态(≥1 个最小化即一枚球)/ 展开点子气泡
// 恢复(先缩没后还原)/ 拖后吞点击 / left-top 定位 / detach 隐藏。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { GhostManifest, InstalledGhost } from '../../../shared/ghost';
import {
  __resetGhostPanelBubbleStateForTest,
  getGhostPanelBubbleState,
  minimizeGhostPanel,
} from '../../lib/ghostPanelBubbleState';
import {
  __resetGhostPanelWindowsStateForTest,
  __setGhostPanelWindowsStateForTest,
} from '../../lib/ghostPanelWindowState';
import {
  __resetGhostPanelRestoreModeForTest,
  setGhostPanelRestoreMode,
} from '../../hooks/useGhostPanelRestoreMode';
import { __resetInstalledGhostsStoreForTest } from '../useInstalledGhosts';
import { GhostPanelBubbleLayer } from '../GhostPanelBubbleLayer';

// 仓库同款 i18n mock:t 返回 key(带参拼上,便于断言)。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

function ghost(id: string, enabled = true): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: `${id} 插件`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['panel'],
    panel: { title: `${id} 面板`, html: 'panel.html' },
  };
  return {
    manifest,
    dir: `/fake/${id}`,
    enabled,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

function stubGhostsBridge(ghosts: InstalledGhost[]): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: {
      listSync: () => ({ ghosts }),
      onChanged: () => () => undefined,
    },
  };
}

afterEach(() => {
  cleanup();
  __resetGhostPanelBubbleStateForTest();
  __resetGhostPanelRestoreModeForTest();
  __resetGhostPanelWindowsStateForTest();
  __resetInstalledGhostsStoreForTest();
  window.localStorage.removeItem('xdt:ghostPanelBubbleStack:v1');
  window.localStorage.removeItem('ghostPanel.restoreMode');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('GhostPanelBubbleLayer', () => {
  it('只要有 1 个最小化就渲染幽灵球(数量角标 1);没有最小化不渲染', () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    render(<GhostPanelBubbleLayer />);
    const stack = screen.getByTestId('ghost-panel-bubble-stack');
    expect(stack).toBeTruthy();
    expect(stack.textContent).toContain('1');
    // 单个也不再直渲插件自己的气泡(2026-07-31 定案:不分 1 个还是多个)。
    expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull();
    expect(screen.queryByTestId('ghost-panel-bubble-b')).toBeNull();
  });

  it('全部面板都开着(无最小化)整层不渲染', () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    render(<GhostPanelBubbleLayer />);
    expect(screen.queryByTestId('ghost-panel-bubble-stack')).toBeNull();
  });

  it('选择侧栏恢复入口时不渲染浮动幽灵球', () => {
    stubGhostsBridge([ghost('a')]);
    minimizeGhostPanel('a');
    setGhostPanelRestoreMode('sidebar');
    render(<GhostPanelBubbleLayer />);
    expect(screen.queryByTestId('ghost-panel-bubble-stack')).toBeNull();
  });

  it('点球展开子气泡(aria 带面板名);点子气泡先播缩没退场,到点恢复;最后一个恢复后整层卸载', async () => {
    stubGhostsBridge([ghost('a')]);
    minimizeGhostPanel('a');
    render(<GhostPanelBubbleLayer />);
    fireEvent.click(screen.getByTestId('ghost-panel-bubble-stack'));
    const childA = screen.getByTestId('ghost-panel-bubble-a');
    expect(
      screen.getByRole('button', { name: 'ghostPanelBubble.restoreAria:{"name":"a 面板"}' }),
    ).toBeTruthy();
    fireEvent.click(childA);
    // 点击后不是立刻恢复:退场动画窗口内仍处于最小化态
    expect(getGhostPanelBubbleState().a?.minimized).toBe(true);
    await waitFor(() => {
      expect(getGhostPanelBubbleState().a?.minimized).not.toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ghost-panel-bubble-stack')).toBeNull();
    });
  });

  it('已抽离独立窗口的插件不计入(合并回来自动复现)', () => {
    stubGhostsBridge([ghost('a')]);
    minimizeGhostPanel('a');
    __setGhostPanelWindowsStateForTest({ a: { detached: true, lastOpen: true, open: true } });
    const { rerender } = render(<GhostPanelBubbleLayer />);
    expect(screen.queryByTestId('ghost-panel-bubble-stack')).toBeNull();
    act(() => __setGhostPanelWindowsStateForTest({}));
    rerender(<GhostPanelBubbleLayer />);
    expect(screen.getByTestId('ghost-panel-bubble-stack')).toBeTruthy();
  });

  it('停用的插件不计入', () => {
    stubGhostsBridge([ghost('a', false)]);
    minimizeGhostPanel('a');
    render(<GhostPanelBubbleLayer />);
    expect(screen.queryByTestId('ghost-panel-bubble-stack')).toBeNull();
  });

  it('多个最小化仍是一枚球(带数量);点子气泡恢复该插件后球和角标还在', async () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    minimizeGhostPanel('b');
    render(<GhostPanelBubbleLayer />);
    const stack = screen.getByTestId('ghost-panel-bubble-stack');
    expect(stack.textContent).toContain('2');
    fireEvent.click(stack);
    const childA = screen.getByTestId('ghost-panel-bubble-a');
    expect(childA).toBeTruthy();
    expect(screen.getByTestId('ghost-panel-bubble-b')).toBeTruthy();
    fireEvent.click(childA);
    await waitFor(() => {
      expect(getGhostPanelBubbleState().a?.minimized).not.toBe(true);
    });
    // 只剩 b:球不消失、不再回落单气泡形态,角标变 1。
    await waitFor(() => {
      expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull();
    });
    expect(screen.getByTestId('ghost-panel-bubble-stack').textContent).toContain('1');
    expect(screen.getByTestId('ghost-panel-bubble-b')).toBeTruthy();
  });

  it('再点球收拢子气泡;点空白处也收拢', () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    minimizeGhostPanel('b');
    render(<GhostPanelBubbleLayer />);
    const stack = screen.getByTestId('ghost-panel-bubble-stack');
    fireEvent.click(stack);
    expect(screen.getByTestId('ghost-panel-bubble-a')).toBeTruthy();
    fireEvent.click(stack);
    expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull();
    fireEvent.click(stack);
    expect(screen.getByTestId('ghost-panel-bubble-a')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull();
  });

  it('展开期间拖球:子气泡实时跟走(left/top 直改),松手后保持展开', () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    minimizeGhostPanel('b');
    render(<GhostPanelBubbleLayer />);
    const stack = screen.getByTestId('ghost-panel-bubble-stack');
    fireEvent.click(stack);
    const childA = screen.getByTestId('ghost-panel-bubble-a');
    const childB = screen.getByTestId('ghost-panel-bubble-b');
    fireEvent.pointerDown(stack, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(stack, { pointerId: 1, clientX: 420, clientY: 430 });
    // jsdom 视口 1024x768:默认锚点 (964, 58),拖 (-80, -70) → (884, -12),y 被
    // clamp 到四边边距 12(顶部无额外下限)→ 锚点 (884, 12),子气泡向下排在
    // 68 / 124(还没松手)。
    // 落位断言 left/top 而非 transform:app-region 挖洞按布局矩形算,定位
    // 必须走布局属性(2026-07-31 草稿页拖不动的修复口径)。
    expect((childA as HTMLElement).style.left).toBe('884px');
    expect((childA as HTMLElement).style.top).toBe('68px');
    expect((childB as HTMLElement).style.left).toBe('884px');
    expect((childB as HTMLElement).style.top).toBe('124px');
    fireEvent.pointerUp(stack, { pointerId: 1, clientX: 420, clientY: 430 });
    fireEvent.click(stack);
    // 拖后 click 被吞:展开态不翻转,子气泡还在,且落在与拖动终点一致的位置。
    const settledA = screen.getByTestId('ghost-panel-bubble-a') as HTMLElement;
    const settledB = screen.getByTestId('ghost-panel-bubble-b') as HTMLElement;
    expect(settledA.style.left).toBe('884px');
    expect(settledA.style.top).toBe('68px');
    expect(settledB.style.left).toBe('884px');
    expect(settledB.style.top).toBe('124px');
  });

  it('拖动幽灵球:落点持久化到独立键、随后的 click 被吞(不展开)、拖完清理', () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    minimizeGhostPanel('b');
    render(<GhostPanelBubbleLayer />);
    const stack = screen.getByTestId('ghost-panel-bubble-stack');
    fireEvent.pointerDown(stack, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(stack, { pointerId: 1, clientX: 420, clientY: 430 });
    fireEvent.pointerUp(stack, { pointerId: 1, clientX: 420, clientY: 430 });
    fireEvent.click(stack);
    expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull(); // 拖后 click 被吞
    const raw = window.localStorage.getItem('xdt:ghostPanelBubbleStack:v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as { x: number; y: number };
    expect(Number.isFinite(parsed.x) && Number.isFinite(parsed.y)).toBe(true);
    // 往上拖过头只被四边边距 12 拦住(不再卡在顶部拖动带下沿 58):
    // 默认位 y=58 + dy(-70) = -12 → 12。
    expect(parsed.y).toBe(12);
    expect(document.body.classList.contains('resizing-pane')).toBe(false);
  });

  it('拖动阈值内的按-放不算拖:随后的 click 正常展开', () => {
    stubGhostsBridge([ghost('a')]);
    minimizeGhostPanel('a');
    render(<GhostPanelBubbleLayer />);
    const stack = screen.getByTestId('ghost-panel-bubble-stack');
    fireEvent.pointerDown(stack, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(stack, { pointerId: 1, clientX: 501, clientY: 501 });
    fireEvent.pointerUp(stack, { pointerId: 1, clientX: 501, clientY: 501 });
    fireEvent.click(stack);
    expect(screen.getByTestId('ghost-panel-bubble-a')).toBeTruthy();
    expect(window.localStorage.getItem('xdt:ghostPanelBubbleStack:v1')).toBeNull();
  });
});
