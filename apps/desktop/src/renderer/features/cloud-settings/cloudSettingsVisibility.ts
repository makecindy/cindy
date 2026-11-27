import { isSettingsTab, TAB_IDS } from '@/lib/tabLabels';
import type { SettingsSearchEntry } from '@/components/settings/settingsSearchTypes';
import {
  CLOUD_SETTINGS_GROUPS,
  type CloudSettingsDomain,
  type CloudSettingsTab,
} from '../../../shared/cloudSettings';

/**
 * What the cloud settings page shows. Presentation only: the shared domains, the Host
 * contract and every section stay in place, so adding one back is a change to this list.
 */
export interface CloudSettingsVisibility {
  /** Categories, in display order. */
  tabs: readonly CloudSettingsTab[];
  /** Domains a category reads and shows; a category not listed here shows its whole group. */
  domains: Partial<Record<CloudSettingsTab, readonly CloudSettingsDomain[]>>;
  /** The instance overview category. Its operations also live on the device card. */
  instance: boolean;
  /** One step to the cloud desktop, for everything this page leaves out. */
  more: boolean;
  /** Sharing, joining by link, CLI suggestions and the model visibility switches. */
  providerManagement: boolean;
  /** The Claude Code, Codex and Pi rows under the Cindy memory switch. */
  memoryAgentRows: boolean;
}

/**
 * Every supported category in the local page's order. Plugins is in it, since the native client
 * manages the instance's plugins and skills there; a browser still opens the remote desktop for
 * them. Left out: the instance overview, whose operations all
 * live on the device card's Update dialog.
 */
export const CLOUD_SETTINGS_VISIBILITY: CloudSettingsVisibility = {
  tabs: TAB_IDS.filter((tab): tab is CloudSettingsTab => tab in CLOUD_SETTINGS_GROUPS),
  domains: {},
  instance: false,
  more: true,
  providerManagement: true,
  memoryAgentRows: true,
};

/** Every section this page can show, the overview included. */
export const CLOUD_SETTINGS_ALL_SECTIONS: CloudSettingsVisibility = {
  tabs: TAB_IDS.filter((tab): tab is CloudSettingsTab => tab in CLOUD_SETTINGS_GROUPS),
  domains: {},
  instance: true,
  more: false,
  providerManagement: true,
  memoryAgentRows: true,
};

export type CloudSettingsPageTab = CloudSettingsTab | 'instance' | 'more';

export const cloudTabDomains = (
  visibility: CloudSettingsVisibility,
  tab: CloudSettingsPageTab,
): readonly CloudSettingsDomain[] =>
  tab === 'instance' || tab === 'more'
    ? []
    : (visibility.domains[tab] ?? CLOUD_SETTINGS_GROUPS[tab]);

/** Links to the overview go to the instance's device card when the page has no overview. */
export const cloudLinkOpensDeviceCard = (
  visibility: CloudSettingsVisibility,
  tab: string | null,
  section: string | null,
) =>
  !visibility.instance && (section === 'maintenance' || tab === 'instance');

/** The category an old `tab=` link lands on; never a hidden or empty one. */
export function cloudTabFromLink(
  visibility: CloudSettingsVisibility,
  tab: string | null,
): CloudSettingsTab | 'more' | undefined {
  if ((visibility.tabs as readonly (string | null)[]).includes(tab)) return tab as CloudSettingsTab;
  if (tab === 'more' && visibility.more) return 'more';
  // Links to General, whose settings sit under Personalization, land there.
  if (tab === 'general' && visibility.tabs.includes('personalization')) return 'personalization';
  return visibility.more && isSettingsTab(tab) ? 'more' : undefined;
}

/** The category a settings search entry opens here, or null when it is not shown. */
export function cloudSearchEntryTab(
  visibility: CloudSettingsVisibility,
  entry: SettingsSearchEntry,
): CloudSettingsTab | null {
  if ((visibility.tabs as readonly string[]).includes(entry.tab))
    return entry.tab as CloudSettingsTab;
  return null;
}
