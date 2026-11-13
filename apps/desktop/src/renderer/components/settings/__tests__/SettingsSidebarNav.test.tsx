// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TAB_IDS } from '@/lib/tabLabels';
import { SettingsSidebarNav } from '../SettingsSidebarNav';
import { buildPluginSettingsPages, buildPluginSettingsSearchDocuments } from '../pluginSettingsNavigation';
import { ghostHostUiApprovalTokens, type InstalledGhost } from '../../../../shared/ghost';

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
  // Unit: search uses the real approved manifest projection; built-in catalog
  // coverage does not prove plugin fields are searchable or disappear on revoke.
  it('searches registered plugin fields and restores the original navigation on revocation', () => {
    const ghost: InstalledGhost = { enabled: true, dir: '/fixture', namespace: 'local', approval: { state: 'approved', revision: 'one' },
      manifest: { schemaVersion: 3, id: 'example', name: 'Example', kind: 'chip', version: '1', entry: 'main.js', mcpApps: {
        host: { settings: [{ id: 'limit', title: 'Limit', description: 'Maximum results', type: 'number', default: 8 }] },
      } } };
    ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest);
    const pages = buildPluginSettingsPages([ghost]);
    const onSelect = vi.fn();
    const view = render(<SettingsSidebarNav tabIds={['ghosts']} activeTab="ghosts" onSelectTab={vi.fn()}
      pluginPages={pages} pluginSearchDocuments={buildPluginSettingsSearchDocuments(pages, 'Plugin settings')}
      selectedPluginPage={pages[0].id} onSelectSearchResult={onSelect} />);
    expect(screen.getByRole('tab', { name: 'Example' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Maximum results' } });
    fireEvent.click(screen.getByRole('option', { name: /Limit/ }));
    expect(onSelect).toHaveBeenCalledWith({ tab: 'ghosts', sectionId: `${pages[0].id}-limit` });
    const revoked = buildPluginSettingsPages([{ ...ghost, approvedHostUi: [] }]);
    view.rerender(<SettingsSidebarNav tabIds={['ghosts']} activeTab="ghosts" onSelectTab={vi.fn()} pluginPages={revoked} />);
    expect(screen.queryByRole('tab', { name: 'Example' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Plugins' }).getAttribute('aria-selected')).toBe('true');
  });
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
