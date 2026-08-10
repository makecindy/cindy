// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { EmptyState } from '../EmptyState';

afterEach(() => cleanup());

function renderEmptyState(
  onAddResourceUsageTab = vi.fn(),
  onAddSubagentsTab = vi.fn(),
) {
  return render(
    <EmptyState
      onAddFileTab={vi.fn()}
      onAddReviewTab={vi.fn()}
      onAddSubagentsTab={onAddSubagentsTab}
      onAddBackgroundTasksTab={vi.fn()}
      onAddResourceUsageTab={onAddResourceUsageTab}
      onAddBrowserTab={vi.fn()}
      onAddTerminalTab={vi.fn()}
    />,
  );
}

describe('EmptyState add-more hint', () => {
  it('renders a non-interactive hint for the existing top add button', () => {
    renderEmptyState();

    const hint = screen.getByText('rightSidebar.tabs.empty.addMoreHint');
    expect(hint.tagName).toBe('P');
    expect(hint.closest('button')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.tabs.empty.addMoreHint' }),
    ).toBeNull();
  });
});

describe('EmptyState 面板收束(2026-08)', () => {
  it('不再渲染任何插件页签入口(插件面板只从插件页进入)', () => {
    renderEmptyState();
    expect(screen.queryByText('rightSidebar.tabs.empty.pluginGroup')).toBeNull();
    expect(screen.queryByText('rightSidebar.tabs.empty.pluginSub')).toBeNull();
  });

  it('提供资源用量快捷入口', () => {
    const onAddResourceUsageTab = vi.fn();
    renderEmptyState(onAddResourceUsageTab);
    fireEvent.click(screen.getByText('rightSidebar.tabs.empty.openResourceUsage'));
    expect(onAddResourceUsageTab).toHaveBeenCalledOnce();
  });

  it('提供 Subagent 工作区快捷入口', () => {
    const onAddSubagentsTab = vi.fn();
    renderEmptyState(vi.fn(), onAddSubagentsTab);
    fireEvent.click(screen.getByText('rightSidebar.tabs.empty.openSubagents'));
    expect(onAddSubagentsTab).toHaveBeenCalledOnce();
  });
});
