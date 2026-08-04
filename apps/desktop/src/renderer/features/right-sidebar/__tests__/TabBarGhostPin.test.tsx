// @vitest-environment jsdom
/**
 * TabPill 图钉按钮 —— 插件面板页签专属的钉住切换。
 * i18n 走 key 透传(TabBar.test.tsx 同款),断言直接用 key。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TabStrip } from '../TabBar';
import {
  _resetGhostTabPinsForTest,
  isGhostTabPinned,
  markGhostTabOpened,
} from '../lib/pinnedGhostTabs';
import type { TabState } from '../types';

const GHOST_TAB: TabState = { id: 'tab-ghost', kind: 'ghost:cindy-art', state: null };
const FILE_TAB: TabState = { id: 'tab-file', kind: 'file-browser', state: null };
const PIN_ARIA = 'rightSidebar.tabs.pinAria';
const UNPIN_ARIA = 'rightSidebar.tabs.unpinAria';

function renderStrip(tabs: TabState[] = [GHOST_TAB, FILE_TAB]) {
  render(
    <TabStrip
      tabs={tabs}
      activeTabId={null}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onReorder={vi.fn()}
      onAdd={vi.fn()}
    />,
  );
}

beforeEach(() => {
  _resetGhostTabPinsForTest();
});
afterEach(() => cleanup());

describe('TabPill 图钉按钮', () => {
  it('插件页签渲染图钉按钮,非插件页签不渲染', () => {
    markGhostTabOpened('cindy-art');
    renderStrip();
    const unpinButtons = screen.getAllByRole('button', { name: UNPIN_ARIA });
    expect(unpinButtons).toHaveLength(1);
    // file-browser pill 内没有图钉(全 DOM 只有插件 pill 这一颗)
    expect(screen.queryAllByRole('button', { name: PIN_ARIA })).toHaveLength(0);
  });

  it('未钉住 → 按钮语义是「钉住」,点击写入钉住状态', () => {
    renderStrip();
    const pin = screen.getByRole('button', { name: PIN_ARIA });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(pin.hasAttribute('data-no-drag')).toBe(true);
    fireEvent.click(pin);
    expect(isGhostTabPinned('cindy-art')).toBe(true);
    // 状态翻转后按钮变「取消钉住」且常驻显形(aria-pressed=true)
    const unpin = screen.getByRole('button', { name: UNPIN_ARIA });
    expect(unpin.getAttribute('aria-pressed')).toBe('true');
  });

  it('钉住中 → 点击取消钉住', () => {
    markGhostTabOpened('cindy-art');
    renderStrip();
    fireEvent.click(screen.getByRole('button', { name: UNPIN_ARIA }));
    expect(isGhostTabPinned('cindy-art')).toBe(false);
    expect(screen.getByRole('button', { name: PIN_ARIA })).toBeTruthy();
  });
});
