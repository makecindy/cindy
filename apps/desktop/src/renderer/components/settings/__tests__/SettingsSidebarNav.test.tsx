// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TAB_IDS } from '@/lib/tabLabels';
import { SettingsSidebarNav } from '../SettingsSidebarNav';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.title': 'Settings',
        'settings.tabs.ghosts': 'Plugins',
        'settings.tabs.general': 'General',
        'settings.tabs.builtinTools': 'Tools',
      })[key] ?? key,
  }),
}));

describe('SettingsSidebarNav', () => {
  it('selects Plugins as an in-panel settings tab', () => {
    const onSelectTab = vi.fn();

    render(<SettingsSidebarNav tabIds={TAB_IDS} activeTab="general" onSelectTab={onSelectTab} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }));

    expect(onSelectTab).toHaveBeenCalledWith('ghosts');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Plugins' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('renders a leading icon for every settings tab', () => {
    render(<SettingsSidebarNav tabIds={TAB_IDS} activeTab="general" onSelectTab={vi.fn()} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(TAB_IDS.length);
    for (const tab of tabs) {
      expect(tab.querySelector('svg')).not.toBeNull();
    }
  });

  it('keeps the search field outside the scrolling menu', () => {
    render(<SettingsSidebarNav tabIds={TAB_IDS} activeTab="general" onSelectTab={vi.fn()} />);

    const menu = screen.getByRole('tablist', { name: 'Settings' });
    const search = screen.getByRole('combobox', { name: 'settings.search.ariaLabel' });

    expect(menu.className).toContain('overflow-y-auto');
    expect(menu.contains(search)).toBe(false);
    expect(search.closest('[class*="overflow-y-auto"]')).toBeNull();

    fireEvent.change(search, { target: { value: 'missing-setting' } });

    const results = document.getElementById('settings-search-results');
    expect(results).not.toBeNull();
    expect(results?.className).toContain('overflow-y-auto');
    expect(results !== null && menu.contains(results)).toBe(false);
    expect((search as HTMLInputElement).disabled).toBe(false);

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
    expect(document.getElementById('settings-search-results')).toBeNull();
  });
});
