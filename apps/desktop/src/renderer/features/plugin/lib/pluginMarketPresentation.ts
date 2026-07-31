/**
 * Maps server authorization scope into the client-facing source taxonomy.
 *
 * Scope is the source of truth for visibility and publishing authority. Whether a
 * public Plugin is installed by default is an installation policy, not a source.
 * An installed Ghost without a matching market record remains local.
 */
import type { GhostInstallApproval } from '../../../../shared/ghost';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

export type PluginPresentationOrigin =
  | 'public'
  | 'organization'
  | 'local';

export type PluginCatalogPresentationItem<TInstalled> =
  { kind: 'installed'; item: TInstalled } | { kind: 'market'; item: PluginMarketItem };

export function pluginPresentationOrigin(
  item: Pick<PluginMarketItem, 'scope'> | null | undefined,
): PluginPresentationOrigin {
  if (item?.scope === 'public' || item?.scope === 'organization') {
    return item.scope;
  }
  // Personal market publishing is intentionally not exposed by the client.
  // Keep the renderer taxonomy closed even if an older/newer server returns it.
  return 'local';
}

/**
 * Main's install state is authoritative for the update affordance.
 *
 * A same-version `update-available` item can be a legacy-adopted install whose
 * bytes have not been verified against the market release. Version equality
 * alone cannot suppress that replacement path; same-release metadata refreshes
 * are already reported as `installed` by Main.
 */
export function pluginUpdateForInstalledVersion(
  item: PluginMarketItem | null | undefined,
): PluginMarketItem | null {
  return item?.installState === 'update-available' ? item : null;
}

/**
 * Whether the market install flow may run against an already-installed Plugin.
 *
 * A pending release is the usual case. The same release is also allowed when the
 * install carries no Host approval: re-installing that exact release is how such
 * an install gets reviewed again, and the flow shows every permission as newly
 * requested. An approved install at the current release has nothing to review.
 */
export function marketReviewTargetsInstalledGhost(
  item: Pick<PluginMarketItem, 'installState'> | null | undefined,
  approvalState: GhostInstallApproval['state'] | undefined,
): boolean {
  if (item?.installState === 'update-available') return true;
  return item?.installState === 'installed' && approvalState !== undefined && approvalState !== 'approved';
}

/**
 * Where an unapproved install gets reviewed again. Market-owned installs replay
 * the market confirmation; anything else needs the user to point at a `.cindy`
 * package. Both routes end in the same permission confirmation — there is no
 * path that restores an install without one.
 */
export function ghostReapprovalRoute(
  item: Pick<PluginMarketItem, 'installState'> | null | undefined,
): 'market' | 'local-package' {
  return item?.installState === 'installed' || item?.installState === 'update-available'
    ? 'market'
    : 'local-package';
}

/**
 * Keeps the complete catalog in server order while rendering an installed card
 * for market records already owned by this client. Local-only installs have no
 * server position, so they remain visible after the ordered market catalog.
 */
export function orderPluginCatalogItems<TInstalled extends { id: string }>(
  marketItems: readonly PluginMarketItem[],
  installedItems: readonly TInstalled[],
  availableMarketItems: readonly PluginMarketItem[],
): PluginCatalogPresentationItem<TInstalled>[] {
  const installedByGhostId = new Map(installedItems.map((item) => [item.id, item]));
  const availableByPluginId = new Map(availableMarketItems.map((item) => [item.pluginId, item]));
  const emittedInstalledIds = new Set<string>();
  const ordered: PluginCatalogPresentationItem<TInstalled>[] = [];

  for (const marketItem of marketItems) {
    const availableItem = availableByPluginId.get(marketItem.pluginId);
    if (
      availableItem &&
      (marketItem.installState === 'not-installed' || marketItem.installState === 'conflict')
    ) {
      ordered.push({ kind: 'market', item: availableItem });
    }
    if (
      marketItem.installState !== 'installed' &&
      marketItem.installState !== 'update-available' &&
      marketItem.installState !== 'conflict'
    ) {
      continue;
    }
    const installedItem = installedByGhostId.get(marketItem.ghostId);
    if (!installedItem || emittedInstalledIds.has(installedItem.id)) continue;
    emittedInstalledIds.add(installedItem.id);
    ordered.push({ kind: 'installed', item: installedItem });
  }

  for (const installedItem of installedItems) {
    if (emittedInstalledIds.has(installedItem.id)) continue;
    ordered.push({ kind: 'installed', item: installedItem });
  }
  return ordered;
}
