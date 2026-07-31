// @vitest-environment jsdom
// GhostPanelBubbleLayer:最小化气泡的渲染 / 点击恢复(先缩没后还原) /
// 拖后吞点击 / detach 隐藏。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  return { manifest, dir: `/fake/${id}`, enabled };
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
  __resetGhostPanelWindowsStateForTest();
  __resetInstalledGhostsStoreForTest();
  window.localStorage.removeItem('xdt:ghostPanelBubbleStack:v1');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('GhostPanelBubbleLayer', () => {
  it('已最小化的插件渲染气泡(aria 带面板名);未最小化不渲染', () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    render(<GhostPanelBubbleLayer />);
    expect(screen.getByTestId('ghost-panel-bubble-a')).toBeTruthy();
    expect(screen.queryByTestId('ghost-panel-bubble-b')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'ghostPanelBubble.restoreAria:{"name":"a 面板"}' }),
    ).toBeTruthy();
  });

  it('点击气泡 → 先播缩没退场,~140ms 后恢复停靠、气泡卸载', async () => {
    stubGhostsBridge([ghost('a')]);
    minimizeGhostPanel('a');
    render(<GhostPanelBubbleLayer />);
    fireEvent.click(screen.getByTestId('ghost-panel-bubble-a'));
    // 点击后不是立刻恢复:退场动画窗口内仍处于最小化态
    expect(getGhostPanelBubbleState().a?.minimized).toBe(true);
    await waitFor(() => {
      expect(getGhostPanelBubbleState().a?.minimized).not.toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull();
    });
  });

  it('拖动(>4px)后松手:位置持久化、随后的 click 被吞、仍保持最小化', () => {
    stubGhostsBridge([ghost('a')]);
    minimizeGhostPanel('a');
    render(<GhostPanelBubbleLayer />);
    const bubble = screen.getByTestId('ghost-panel-bubble-a');
    fireEvent.pointerDown(bubble, { button: 0, pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(bubble, { pointerId: 1, clientX: 460, clientY: 420 });
    fireEvent.pointerUp(bubble, { pointerId: 1, clientX: 460, clientY: 420 });
    fireEvent.click(bubble);
    const entry = getGhostPanelBubbleState().a;
    expect(entry?.minimized).toBe(true); // 拖后 click 被吞,没有触发恢复
    expect(Number.isFinite(entry?.x) && Number.isFinite(entry?.y)).toBe(true);
    expect(document.body.classList.contains('resizing-pane')).toBe(false); // 拖完清理
  });

  it('已抽离独立窗口的插件不画气泡(合并回来自动复现)', () => {
    stubGhostsBridge([ghost('a')]);
    minimizeGhostPanel('a');
    __setGhostPanelWindowsStateForTest({ a: { detached: true, lastOpen: true, open: true } });
    const { rerender } = render(<GhostPanelBubbleLayer />);
    expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull();
    __setGhostPanelWindowsStateForTest({});
    rerender(<GhostPanelBubbleLayer />);
    expect(screen.getByTestId('ghost-panel-bubble-a')).toBeTruthy();
  });

  it('停用的插件不画气泡', () => {
    stubGhostsBridge([ghost('a', false)]);
    minimizeGhostPanel('a');
    render(<GhostPanelBubbleLayer />);
    expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull();
  });

  it('≥2 个最小化 → 合并成一枚堆叠球(带数量),不再各画各的', () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    minimizeGhostPanel('b');
    render(<GhostPanelBubbleLayer />);
    const stack = screen.getByTestId('ghost-panel-bubble-stack');
    expect(stack).toBeTruthy();
    expect(stack.textContent).toContain('2');
    expect(screen.queryByTestId('ghost-panel-bubble-a')).toBeNull();
    expect(screen.queryByTestId('ghost-panel-bubble-b')).toBeNull();
  });

  it('点堆叠球纵向展开子气泡;点子气泡恢复该插件,只剩 1 个时回到单气泡形态', async () => {
    stubGhostsBridge([ghost('a'), ghost('b')]);
    minimizeGhostPanel('a');
    minimizeGhostPanel('b');
    render(<GhostPanelBubbleLayer />);
    fireEvent.click(screen.getByTestId('ghost-panel-bubble-stack'));
    const childA = screen.getByTestId('ghost-panel-bubble-a');
    const childB = screen.getByTestId('ghost-panel-bubble-b');
    expect(childA).toBeTruthy();
    expect(childB).toBeTruthy();
    fireEvent.click(childA);
    await waitFor(() => {
      expect(getGhostPanelBubbleState().a?.minimized).not.toBe(true);
    });
    // 只剩 b:堆叠球消失,b 以单气泡形态出现(自己的位置语义)。
    await waitFor(() => {
      expect(screen.queryByTestId('ghost-panel-bubble-stack')).toBeNull();
    });
    expect(screen.getByTestId('ghost-panel-bubble-b')).toBeTruthy();
  });

  it('再点堆叠球收拢子气泡;点空白处也收拢', () => {
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

  it('展开期间拖堆叠球:子气泡在拖动过程中实时跟走,松手后保持展开', () => {
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
    // jsdom 视口 1024x768:默认锚点 (964, 58),拖 (-80, -70) 后 y 被 clamp 回
    // 顶部下限 58 → 锚点 (884, 58),子气泡向下排在 114 / 170(还没松手)。
    expect((childA as HTMLElement).style.transform).toBe('translate3d(884px, 114px, 0)');
    expect((childB as HTMLElement).style.transform).toBe('translate3d(884px, 170px, 0)');
    fireEvent.pointerUp(stack, { pointerId: 1, clientX: 420, clientY: 430 });
    fireEvent.click(stack);
    // 拖后 click 被吞:展开态不翻转,子气泡还在,且落在与拖动终点一致的位置。
    expect((screen.getByTestId('ghost-panel-bubble-a') as HTMLElement).style.transform).toBe(
      'translate3d(884px, 114px, 0)',
    );
    expect((screen.getByTestId('ghost-panel-bubble-b') as HTMLElement).style.transform).toBe(
      'translate3d(884px, 170px, 0)',
    );
  });

  it('拖动堆叠球:落点持久化到独立键、随后的 click 被吞(不展开)', () => {
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
    expect(document.body.classList.contains('resizing-pane')).toBe(false);
  });
});
