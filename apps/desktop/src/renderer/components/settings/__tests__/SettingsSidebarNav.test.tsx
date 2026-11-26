// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TAB_IDS } from '@/lib/tabLabels';
import { SettingsSidebarNav } from '../SettingsSidebarNav';
import { buildPluginSettingsPages, buildPluginSettingsSearchDocuments } from '../pluginSettingsNavigation';
import { type InstalledGhost } from '../../../../shared/ghost';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.title': 'Settings',
        'settings.tabs.ghosts': 'Plugins',
        'settings.tabs.general': 'General',
        'settings.tabs.builtinTools': 'Tools',
        'settings.tabs.usage': 'Usage history',
        'settings.tabs.billing': 'Usage and billing',
        'settings.navGroups.extensions': 'Tools & plugins',
        'settings.navGroups.models': 'Models',
      })[key] ?? key,
  }),
}));

describe('SettingsSidebarNav', () => {
  // Unit: search uses the real approved manifest projection; built-in catalog
  // coverage does not prove plugin fields are searchable or disappear on revoke.
  it('searches registered plugin fields and restores the original navigation on revocation', () => {
    const ghost: InstalledGhost = { enabled: true, dir: '/fixture', namespace: 'local', approval: { state: 'approved', revision: 'one' },
      manifest: { schemaVersion: 3, id: 'example', name: 'Example', kind: 'chip', version: '1', entry: 'main.js', mcpApps: {
        host: { settings: [{ id: 'limit', title: 'Limit', description: 'Maximum results', type: 'number', default: 8 }] },
      } } };

    const pages = buildPluginSettingsPages([ghost]);
    const onSelect = vi.fn();
    const view = render(<SettingsSidebarNav tabIds={['ghosts']} activeTab="ghosts" onSelectTab={vi.fn()}
      pluginPages={pages} pluginSearchDocuments={buildPluginSettingsSearchDocuments(pages, 'Plugin settings')}
      selectedPluginPage={pages[0].id} onSelectSearchResult={onSelect} />);
    expect(screen.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('true');
    const extensions = screen.getByRole('button', { name: 'Tools & plugins' });
    fireEvent.click(extensions);
    expect(screen.queryByRole('tab', { name: 'Example' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Maximum results' } });
    fireEvent.click(screen.getByRole('option', { name: /Limit/ }));
    expect(onSelect).toHaveBeenCalledWith({ tab: 'ghosts', sectionId: `${pages[0].id}-limit` });
    expect(screen.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('true');
    const revoked = buildPluginSettingsPages([{ ...ghost, approval: { state: 'invalid' as const } }]);
    view.rerender(<SettingsSidebarNav tabIds={['ghosts']} activeTab="ghosts" onSelectTab={vi.fn()} pluginPages={revoked} />);
    expect(screen.queryByRole('tab', { name: 'Example' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Plugins' }).getAttribute('aria-selected')).toBe('true');
  });
  it('opens one branch at a time and reveals a tab selected by navigation', () => {
    const onSelectTab = vi.fn();

    const view = render(<SettingsSidebarNav tabIds={TAB_IDS} activeTab="general" onSelectTab={onSelectTab} />);

    const models = screen.getByRole('button', { name: 'Models' });
    expect(screen.queryByRole('tab', { name: 'Plugins' })).toBeNull();
    fireEvent.click(models);
    expect(models.getAttribute('aria-expanded')).toBe('true');
    const modelTabs = within(screen.getByRole('tablist', { name: 'Models' }));
    fireEvent.click(modelTabs.getByRole('tab', { name: 'Usage and billing' }));
    expect(onSelectTab).toHaveBeenLastCalledWith('billing');
    fireEvent.click(screen.getByRole('button', { name: 'Tools & plugins' }));
    expect(models.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }));

    expect(onSelectTab).toHaveBeenCalledWith('ghosts');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Plugins' }).getAttribute('aria-selected')).toBe(
      'false',
    );

    view.rerender(<SettingsSidebarNav tabIds={TAB_IDS} activeTab="usage" onSelectTab={onSelectTab} />);
    expect(screen.getByRole('tab', { name: 'Usage history' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: 'Plugins' })).toBeNull();

    view.rerender(<SettingsSidebarNav tabIds={TAB_IDS} activeTab="providers" onSelectTab={onSelectTab} navigationKey="first" />);
    fireEvent.click(models);
    expect(models.getAttribute('aria-expanded')).toBe('false');
    view.rerender(<SettingsSidebarNav tabIds={TAB_IDS} activeTab="providers" onSelectTab={onSelectTab} navigationKey="deep-link" />);
    expect(models.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders a leading icon for every settings tab', () => {
    render(<SettingsSidebarNav tabIds={TAB_IDS} activeTab="general" onSelectTab={vi.fn()} />);

    const tabs = new Set(screen.getAllByRole('tab'));
    for (const group of screen.getAllByRole('button', { expanded: false })) {
      fireEvent.click(group);
      for (const tab of screen.getAllByRole('tab')) tabs.add(tab);
    }
    expect(tabs.size).toBe(TAB_IDS.length);
    for (const tab of tabs) {
      expect(tab.querySelector('svg')).not.toBeNull();
    }
  });
});
