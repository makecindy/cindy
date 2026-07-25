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
});
