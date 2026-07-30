// @vitest-environment jsdom

/**
 * IssueTrackerFeatureLayout —— 内容区分支的回归。
 *
 * 重点钉住「刷新失败不得盖掉已加载的列表」:useMyIssues 刷新失败时刻意保留旧 data,
 * 但 error 分支一旦优先于 hasItems,用户点一次刷新就会丢失整页内容。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyIssueItem, MyIssuesResult } from '@/../shared/myIssues';

const useMyIssuesMock = vi.fn();

vi.mock('../hooks/useMyIssues', () => ({
  useMyIssues: () => useMyIssuesMock(),
}));
vi.mock('@/features/cc-agent/useRegisterCCAgentSidebar', () => ({
  useRegisterCCAgentSidebar: () => undefined,
}));
vi.mock('@/components/layout/windowDrag', () => ({
  InvisibleWindowDragStrip: () => null,
  WINDOW_DRAG_STYLE: {},
  WINDOW_NO_DRAG_STYLE: {},
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && 'count' in vars ? `${key}:${String(vars.count)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

const { IssueTrackerFeatureLayout } = await import('../IssueTrackerFeatureLayout');

function item(over: Partial<MyIssueItem> = {}): MyIssueItem {
  return {
    number: 1061,
    url: 'https://github.com/makecindy/cindy/issues/1061',
    title: '已经加载出来的那条 issue',
    type: 'feature',
    state: 'open',
    createdAt: '2026-07-30T09:12:49Z',
    updatedAt: null,
    commentCount: null,
    sources: ['cindy-tool'],
    ...over,
  };
}

function result(items: MyIssueItem[]): MyIssuesResult {
  return { items, githubEnhancement: null, degraded: null, truncated: false };
}

function state(over: Record<string, unknown> = {}) {
  return {
    data: null,
    loading: false,
    refreshing: false,
    error: null,
    refresh: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  useMyIssuesMock.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { openExternal: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
});

describe('IssueTrackerFeatureLayout 内容区分支', () => {
  it('刷新失败但已有数据:保留列表,错误降级成提示条', () => {
    useMyIssuesMock.mockReturnValue(
      state({ data: result([item()]), error: 'ECONNRESET' }),
    );
    render(<IssueTrackerFeatureLayout />);

    // 列表还在,用户不丢内容。
    expect(screen.getByText('已经加载出来的那条 issue')).toBeTruthy();
    // 失败信息以提示条形式出现,而且不是整页错误态。
    expect(screen.getAllByText('issueTracker.list.loadFailed').length).toBe(1);
    expect(screen.getAllByText('issueTracker.list.retry').length).toBe(1);
  });

  it('从未加载成功过:才用整页错误态', () => {
    useMyIssuesMock.mockReturnValue(state({ data: null, error: 'ECONNRESET' }));
    render(<IssueTrackerFeatureLayout />);

    expect(screen.getByText('issueTracker.list.loadFailed')).toBeTruthy();
    expect(screen.queryByText('已经加载出来的那条 issue')).toBeNull();
  });

  it('加载中显示加载态', () => {
    useMyIssuesMock.mockReturnValue(state({ loading: true }));
    render(<IssueTrackerFeatureLayout />);
    expect(screen.getByText('issueTracker.detail.loading')).toBeTruthy();
  });

  it('一条都没有:显示空态引导,不显示常驻说明条(避免与引导里的说明重复)', () => {
    useMyIssuesMock.mockReturnValue(state({ data: result([]) }));
    render(<IssueTrackerFeatureLayout />);

    expect(screen.getByText('issueTracker.mine.emptyTitle')).toBeTruthy();
    // 空态与常驻条都含可点击的 /issue;空态时只应有一个。
    expect(screen.getAllByRole('button', { name: 'issueTracker.mine.startIssueChat' }).length).toBe(
      1,
    );
  });

  it('有数据:顶部常驻说明条在场', () => {
    useMyIssuesMock.mockReturnValue(state({ data: result([item()]) }));
    render(<IssueTrackerFeatureLayout />);

    expect(screen.getAllByRole('button', { name: 'issueTracker.mine.startIssueChat' }).length).toBe(
      1,
    );
    expect(screen.queryByText('issueTracker.mine.emptyTitle')).toBeNull();
  });
});
