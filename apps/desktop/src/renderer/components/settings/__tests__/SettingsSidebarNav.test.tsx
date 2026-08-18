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
});
