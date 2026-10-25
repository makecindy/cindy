// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value },
  Pressable: ({ children, accessibilityLabel, testID }: any) => el('button', { 'aria-label': accessibilityLabel, 'data-testid': testID }, typeof children === 'function' ? children({ pressed: false }) : children),
  View: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
}));
vi.mock('lucide-react-native', () => ({ Search: () => null, SlidersHorizontal: () => null, X: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/AppText', () => ({ TextInput: () => null }));
vi.mock('@/components/mobileInteractionStyles', () => ({ mobileInteractionStyles: {} }));
vi.mock('@/components/FilterReminderDot', () => ({ FilterReminderDot: () => el('i', { 'data-testid': 'filter-dot' }) }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: ({ children }: any) => children }));
vi.mock('@/theme', async () => {
  const { lightColors } = await import('@/theme/tokens');
  return { useTheme: () => ({ colors: lightColors }), useThemedStyles: (make: (colors: unknown) => unknown) => make(lightColors) };
});
import { HomeSearchBar } from '@/session/HomeSearchBar';

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement('div');
  root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); });

// 搜索栏筛选钮的提醒点已改用共用的 FilterReminderDot(与首页「⋯」的归档提醒共用):
// 只有筛选条件生效时才出现在筛选钮内,没有筛选时不出现。
it.each([[true, 1], [false, 0]])('filterActive=%s shows %s reminder dot(s) on the filter button', async (filterActive, count) => {
  await act(async () => root.render(el(HomeSearchBar, {
    autoFocus: false, filterActive, onChangeQuery: vi.fn(), onOpenFilter: vi.fn(), query: '',
  })));
  const filterButton = node.querySelector('[data-testid="home.searchFilterButton"]')!;
  expect(filterButton.querySelectorAll('[data-testid="filter-dot"]')).toHaveLength(count);
});
