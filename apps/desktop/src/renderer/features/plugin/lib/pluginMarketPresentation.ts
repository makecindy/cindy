/**
 * Maps server authorization scope into the client-facing source taxonomy.
 *
 * Scope is the source of truth for visibility and publishing authority. Whether a
 * public Plugin is installed by default is an installation policy, not a source.
 * An installed Ghost without a matching market record remains local.
 */
import { isCindyAccountGhostId, type GhostInstallApproval } from '../../../../shared/ghost';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

export type PluginPresentationOrigin = 'public' | 'organization' | 'local' | 'custom';

export type PluginCatalogPresentationItem<TInstalled> =
  { kind: 'installed'; item: TInstalled } | { kind: 'market'; item: PluginMarketItem };

export function pluginPresentationOrigin(
  item: Pick<PluginMarketItem, 'scope' | 'sourceType'> | null | undefined,
): PluginPresentationOrigin {
  // 自定义市场（Git / 本地源）归 'custom'，与服务端 scope 正交。
  if (item && item.sourceType !== 'server') return 'custom';
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
 * installation record is incomplete: reinstalling that exact release restores
 * the Host receipt without adding a capability-confirmation step. A verified
 * install at the current release has nothing to recover.
 */
export function marketReviewTargetsInstalledGhost(
  item: Pick<PluginMarketItem, 'installState'> | null | undefined,
  approvalState: GhostInstallApproval['state'] | undefined,
): boolean {
  if (item?.installState === 'update-available') return true;
  return (
    item?.installState === 'installed' &&
    approvalState !== undefined &&
    approvalState !== 'approved'
  );
}

/**
 * Where an unverifiable install is recovered. Market-owned installs redownload
 * the bound release; anything else needs the user to point at a `.cindy` package.
 * Both routes revalidate real bytes and restore the installation record without
 * creating a separate capability authorization flow.
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

/** 浏览可看公开目录；安装只在当前会话真能跑这个插件时露出。 */
export function canOfferMarketInstall(
  mode: 'signed-out' | 'local' | 'cloud',
  ghostId: string,
): boolean {
  if (mode === 'signed-out') return false;
  return mode === 'cloud' || !isCindyAccountGhostId(ghostId);
}
