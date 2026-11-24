/**
 * Projections of organization ("团队共享") plugins for the 「发布插件」 page (#1541). Wording and
 * columns follow the public-market rows; rules follow the enterprise console (#1504).
 */
import type { MyPluginFilter } from '../../../../shared/pluginContributions';
import type { PersonalPluginSummary } from '../../../../shared/pluginAuthor';

/** Same keys as the public rows: `contribution.market.*`. */
export type TeamMarketState =
  | { state: 'available'; version: string }
  | { state: 'not_listed' | 'disabled' | 'archived' };

export function teamMarketState(plugin: PersonalPluginSummary): TeamMarketState {
  if (plugin.status === 'archived') return { state: 'archived' };
  if (!plugin.currentRelease) return { state: 'not_listed' };
  if (plugin.status === 'disabled') return { state: 'disabled' };
  return { state: 'available', version: plugin.currentRelease.version };
}

/** A version waiting for review, if any. */
export function teamPendingRelease(plugin: PersonalPluginSummary) {
  if (plugin.pendingRelease) return plugin.pendingRelease;
  return plugin.latestRelease?.reviewStatus === 'pending' ? plugin.latestRelease : null;
}

export function matchesTeamFilter(plugin: PersonalPluginSummary, filter: MyPluginFilter): boolean {
  switch (filter) {
    case 'pending':
      return teamPendingRelease(plugin) !== null;
    case 'needs_action':
      return plugin.latestRelease?.reviewStatus === 'rejected';
    case 'published':
      return plugin.status === 'active' && Boolean(plugin.currentRelease);
    default:
      return true;
  }
}

export function matchesTeamQuery(plugin: PersonalPluginSummary, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return plugin.name.toLocaleLowerCase().includes(needle) || plugin.ghostId.toLocaleLowerCase().includes(needle);
}

/** Review state label key for the latest submission, matching the public rows. */
export function teamLatestStateKey(plugin: PersonalPluginSummary): string | null {
  const latest = plugin.latestRelease;
  if (!latest?.reviewStatus) return null;
  if (latest.reviewStatus === 'approved' && plugin.status === 'active' && plugin.currentRelease?.id === latest.id) {
    return 'published';
  }
  return latest.reviewStatus;
}

/**
 * Authors may delist; they may list again only after their own delisting and with an approved
 * current version. An administrator's delisting can only be undone by an administrator.
 */
export function teamListingActions(plugin: PersonalPluginSummary): {
  canDelist: boolean;
  canList: boolean;
  delistedByAdmin: boolean;
} {
  const delistedByAdmin = plugin.status === 'disabled' && plugin.disabledByAdmin === true;
  return {
    canDelist: plugin.status === 'active' && Boolean(plugin.currentRelease),
    canList: plugin.status === 'disabled' && !delistedByAdmin &&
      plugin.currentRelease?.reviewStatus === 'approved',
    delistedByAdmin,
  };
}

/** Listed version icon; a never-listed plugin may show its pending version's icon. */
export function teamPluginIconUrl(plugin: PersonalPluginSummary): string | undefined {
  return plugin.currentRelease?.icon?.url ?? plugin.pendingRelease?.icon?.url ?? undefined;
}
