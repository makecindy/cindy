// @vitest-environment jsdom

/**
 * 会话搜索排序 —— 「记住上次选择」+「排序收在筛选菜单里」的行为契约。
 * ---------------------------------------------------------------------------
 * 1. useConversationSearch 的初始排序读 localStorage,切换排序会写回;
 * 2. rail 与内联两个**常驻挂载**的搜索实例共享同一排序,一处改动另一处即时跟随
 *    (PR #963 review:原先各自 useState 初始值,改完要等重挂载才生效);
 * 3. 搜索框旁只剩筛选一颗钮(排序已收进该菜单),其 aria 用单条文案读出筛选与排序。
 */

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SEARCH_SORT_BY_KEY,
  __resetSearchSortByStoreForTests,
} from '../conversationSearchPrefs';
import { SearchFilterMenu, useConversationSearch } from '../ConversationSearchBox';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args && Object.keys(args).length > 0 ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

vi.mock('@/lib/conversationSearchService', () => ({
  searchConversations: vi.fn(async () => ({ results: [] })),
}));

vi.mock('@/lib/orcaSessionIdentity', () => ({
  resolveSessionRoute: vi.fn(async () => '/'),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  __resetSearchSortByStoreForTests();
});

function renderSearch() {
  return renderHook(() =>
    useConversationSearch({
      enabled: false,
      navigate: vi.fn() as never,
      allKnownProjects: [],
    }),
  );
}

describe('useConversationSearch sort persistence', () => {
  it('defaults to relevance when nothing was persisted', () => {
    const { result } = renderSearch();
    expect(result.current.sortBy).toBe('relevance');
  });

  it('restores the sort persisted by a previous session', () => {
    localStorage.setItem(SEARCH_SORT_BY_KEY, 'activityAsc');
    const { result } = renderSearch();
    expect(result.current.sortBy).toBe('activityAsc');
  });

  it('persists the sort the user picks', () => {
    const { result } = renderSearch();
    act(() => result.current.setSortBy('activityDesc'));
    expect(result.current.sortBy).toBe('activityDesc');
    expect(localStorage.getItem(SEARCH_SORT_BY_KEY)).toBe('activityDesc');

    // 新挂载(重开搜索 / 重启客户端)沿用上次选择。
    cleanup();
    __resetSearchSortByStoreForTests();
    expect(renderSearch().result.current.sortBy).toBe('activityDesc');
  });

  it('keeps both mounted search instances (rail + inline) on the same sort', () => {
    // rail 的 ConversationSearchBox 与展开态 Provider 的内联搜索都常驻挂载
    // (CCAgentSidebarUpper 只切 opacity / hidden),两个实例必须实时同源。
    const rail = renderSearch();
    const inline = renderSearch();
    expect(rail.result.current.sortBy).toBe('relevance');
    expect(inline.result.current.sortBy).toBe('relevance');

    act(() => rail.result.current.setSortBy('activityAsc'));
    expect(rail.result.current.sortBy).toBe('activityAsc');
    // 关键回归点:另一个已挂载实例不用重挂载就跟上,不会拿旧排序去搜。
    expect(inline.result.current.sortBy).toBe('activityAsc');

    act(() => inline.result.current.setSortBy('activityDesc'));
    expect(rail.result.current.sortBy).toBe('activityDesc');
    expect(inline.result.current.sortBy).toBe('activityDesc');
  });

  it('follows the sort another window wrote (storage event)', () => {
    const { result } = renderSearch();
    expect(result.current.sortBy).toBe('relevance');
    act(() => {
      localStorage.setItem(SEARCH_SORT_BY_KEY, 'activityAsc');
      window.dispatchEvent(
        new StorageEvent('storage', { key: SEARCH_SORT_BY_KEY, newValue: 'activityAsc' }),
      );
    });
    expect(result.current.sortBy).toBe('activityAsc');
  });

  it('ignores a storage event that carries an illegal value', () => {
    localStorage.setItem(SEARCH_SORT_BY_KEY, 'activityDesc');
    const { result } = renderSearch();
    expect(result.current.sortBy).toBe('activityDesc');
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: SEARCH_SORT_BY_KEY, newValue: 'bogus' }),
      );
    });
    // 非法值回落默认排序,而不是把 'bogus' 塞进请求。
    expect(result.current.sortBy).toBe('relevance');
  });
});

describe('SearchFilterMenu trigger', () => {
  function renderFilterMenu() {
    return render(
      <SearchFilterMenu
        status="all"
        agentKind="all"
        lastActivity="all"
        projects="all"
        sortBy="activityDesc"
        allKnownProjects={[]}
        activeCount={0}
        lockedProjectKey={null}
        lockedProjectName={null}
        onStatusChange={vi.fn()}
        onAgentKindChange={vi.fn()}
        onLastActivityChange={vi.fn()}
        onProjectsChange={vi.fn()}
        onSortChange={vi.fn()}
        onReset={vi.fn()}
        compact
      />,
    );
  }

  it('keeps a single sliders button and reads out the current sort', () => {
    const { container } = renderFilterMenu();
    const buttons = container.querySelectorAll('button');
    // 搜索框旁只有这一颗钮:排序已收进它的菜单,不再有并排的排序钮。
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.querySelector('.lucide-sliders-horizontal')).not.toBeNull();
    // 无障碍标签是**单条**文案(整句语序交给各语言),排序作为其中一个插值传入,
    // 不是代码里拼接的两段译文。
    const aria = buttons[0]?.getAttribute('aria-label') ?? '';
    expect(aria).toContain('ccAgent.search.filterAria');
    expect(aria).not.toContain('ccAgent.search.sortAria');
    expect(aria).toContain('ccAgent.search.sort.activityDesc');
  });
});
