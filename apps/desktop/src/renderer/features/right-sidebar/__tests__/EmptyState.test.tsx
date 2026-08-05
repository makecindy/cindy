// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Puzzle } from 'lucide-react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { EmptyState } from '../EmptyState';
import type { TabKindMenuMeta } from '../types';

afterEach(() => cleanup());

function ghostMeta(id: string, label: string): TabKindMenuMeta {
  return {
    kind: `ghost:${id}`,
    labelKey: 'rightSidebar.tabs.kinds.ghostPanel',
    labelText: label,
    icon: Puzzle,
    order: 100,
    enabled: true,
    singleton: true,
  };
}

describe('EmptyState add-more hint', () => {
  it('renders a non-interactive hint for the existing top add button', () => {
    render(
      <EmptyState
        onAddFileTab={vi.fn()}
        onAddReviewTab={vi.fn()}
        onAddBackgroundTasksTab={vi.fn()}
        onAddBrowserTab={vi.fn()}
        onAddTerminalTab={vi.fn()}
      />,
    );

    const hint = screen.getByText('rightSidebar.tabs.empty.addMoreHint');
    expect(hint.tagName).toBe('P');
    expect(hint.closest('button')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.tabs.empty.addMoreHint' }),
    ).toBeNull();
  });
});

describe('EmptyState 插件页签行(1 个直显 / ≥2 折叠)', () => {
  it('恰好 1 个启用中的插件 → 直接显示插件自己的行,点击回传 kind', () => {
    const onAddGhostTab = vi.fn();
    render(
      <EmptyState
        onAddFileTab={vi.fn()}
        onAddReviewTab={vi.fn()}
        onAddBackgroundTasksTab={vi.fn()}
        onAddBrowserTab={vi.fn()}
        onAddTerminalTab={vi.fn()}
        ghostTabMetas={[ghostMeta('art', '画廊')]}
        onAddGhostTab={onAddGhostTab}
      />,
    );

    // 直显插件名原文,没有折叠分组行
    fireEvent.click(screen.getByText('画廊'));
    expect(onAddGhostTab).toHaveBeenCalledWith('ghost:art');
    expect(screen.queryByText('rightSidebar.tabs.empty.pluginGroup')).toBeNull();
  });

  it('≥2 个 → 折叠分组:默认收起,展开后逐个列出并可点击', () => {
    const onAddGhostTab = vi.fn();
    render(
      <EmptyState
        onAddFileTab={vi.fn()}
        onAddReviewTab={vi.fn()}
        onAddBackgroundTasksTab={vi.fn()}
        onAddBrowserTab={vi.fn()}
        onAddTerminalTab={vi.fn()}
        ghostTabMetas={[ghostMeta('art', '画廊'), ghostMeta('memo', '备忘')]}
        onAddGhostTab={onAddGhostTab}
      />,
    );

    // 收起态:只有分组行,不见具体插件
    const groupRow = screen.getByText('rightSidebar.tabs.empty.pluginGroup');
    expect(screen.queryByText('画廊')).toBeNull();
    expect(screen.queryByText('备忘')).toBeNull();

    fireEvent.click(groupRow);
    fireEvent.click(screen.getByText('备忘'));
    expect(onAddGhostTab).toHaveBeenCalledWith('ghost:memo');

    // 再点分组行收回去
    fireEvent.click(groupRow);
    expect(screen.queryByText('画廊')).toBeNull();
  });

  it('没有插件(缺省)→ 不渲染任何插件行', () => {
    render(
      <EmptyState
        onAddFileTab={vi.fn()}
        onAddReviewTab={vi.fn()}
        onAddBackgroundTasksTab={vi.fn()}
        onAddBrowserTab={vi.fn()}
        onAddTerminalTab={vi.fn()}
      />,
    );
    expect(screen.queryByText('rightSidebar.tabs.empty.pluginGroup')).toBeNull();
    expect(screen.queryByText('rightSidebar.tabs.empty.pluginSub')).toBeNull();
  });
});
