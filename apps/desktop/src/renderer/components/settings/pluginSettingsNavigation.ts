import { getApprovedGhostHostUi, type InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import type { SettingsSearchDocument } from './settingsSearchCatalog';
import { normalizeSettingsSearchText } from './settingsSearchCatalog';

export interface PluginSettingsPage {
  ghost: InstalledGhost;
  instanceId: string;
  viewId?: string;
  contributionId?: string;
  input?: Record<string, unknown>;
  title: string;
  id: string;
}
export interface PluginSettingsSearchDocument extends SettingsSearchDocument { page: PluginSettingsPage }

/** Derived from the same approved host declaration; there is no settings registry. */
export function buildPluginSettingsPages(ghosts: readonly InstalledGhost[]): PluginSettingsPage[] {
  return ghosts.flatMap(ghost => {
    const host = getApprovedGhostHostUi(ghost);
    if (!ghost.enabled || !host) return [];
    const instanceId = installedGhostStoragePart(ghost);
    const root = `plugin-settings-${instanceId}`;
    const pages: PluginSettingsPage[] = host.settings?.length
      ? [{ ghost, instanceId, title: ghost.manifest.name, id: root }] : [];
    if (ghost.uiCapabilityApproved === true) for (const item of host.contributions ?? []) {
      if (item.position === 'settings.section' && item.view) pages.push({ ghost, instanceId,
        viewId: item.view, contributionId: item.id, input: item.arguments,
        title: `${ghost.manifest.name} · ${item.title}`, id: `${root}-${item.id}` });
    }
    return pages;
  });
}

export function buildPluginSettingsSearchDocuments(pages: readonly PluginSettingsPage[], category: string): PluginSettingsSearchDocument[] {
  return pages.flatMap(page => {
    const fields = page.viewId ? [] : getApprovedGhostHostUi(page.ghost)?.settings ?? [];
    return [{ id: page.id, title: page.title, description: '' }, ...fields.map(field => ({
      id: `${page.id}-${field.id}`, title: field.title,
      description: `${field.description ?? ''} ${field.options?.map(option => option.label).join(' ') ?? ''}`,
    }))].map(item => ({ page, entry: { id: item.id, tab: 'ghosts' as const, targetId: item.id,
      titleKey: 'pluginUi.settings', sectionKey: 'pluginUi.settings' }, title: item.title,
      section: page.title, category,
      searchText: normalizeSettingsSearchText(`${item.title} ${page.title} ${category} ${item.description}`),
    }));
  });
}
