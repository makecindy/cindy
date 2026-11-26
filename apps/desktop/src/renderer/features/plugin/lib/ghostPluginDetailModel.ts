/**
 * Pure description and local publishing helpers shared by Plugin details and selection.
 *
 * Permission presentation intentionally consumes the shared Ghost permission items directly.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { type InstalledGhost } from '../../../../shared/ghost';
import { LOCAL_PLUGIN_NAMESPACE } from '../../../../shared/pluginIdentity';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

/** UI submissions use local installations; Host and server verify actual publishing permission. */
export function localPublishingUnavailableKey(
  ghost: InstalledGhost | null | undefined,
  market?: (Pick<PluginMarketItem, 'scope' | 'organizationId'> & Partial<Pick<PluginMarketItem, 'sourceType' | 'publisherKind'>>) | null,
) {
  if (!ghost) return 'installationUnavailable';
  if (ghost.namespace === null && (
    (ghost.publishingSource?.kind === 'public-market' && ghost.trust?.level === 'cindy-official') ||
    (market?.scope === 'public' && market.sourceType === 'server' && market.publisherKind === 'official')
  )) return 'officialGithubRequired';
  if (ghost.builtin) return 'reservedId';
  if (ghost.namespaceState !== 'confirmed') return 'identityPending';
  if ((ghost.namespace !== null && ghost.namespace !== LOCAL_PLUGIN_NAMESPACE) || (market && (market.scope !== 'public' || market.organizationId !== null))) return 'privatePlugin';
  if (ghost.approval.state !== 'approved') return 'approvalRequired';
  if (!ghost.publishingSource || ghost.publishingSource.kind === 'unavailable') return 'sourceUnverified';
  if (ghost.publishingSource.kind === 'public-market') return 'publishingPermissionRequired';
  return null;
}

/**
 * Local development copies an organization member may publish to team sharing. Unlike the public
 * market, a team plugin of the same id is expected (it is how maintainers ship new versions);
 * Main and the server still verify the actual installation and publishing permission.
 */
export function teamPublishingUnavailableKey(ghost: InstalledGhost | null | undefined) {
  if (!ghost) return 'installationUnavailable';
  if (ghost.builtin) return 'reservedId';
  if (ghost.namespaceState !== 'confirmed') return 'identityPending';
  if (ghost.namespace !== null && ghost.namespace !== LOCAL_PLUGIN_NAMESPACE) return 'privatePlugin';
  if (ghost.approval.state !== 'approved') return 'approvalRequired';
  if (ghost.publishingSource?.kind !== 'local') return 'sourceUnverified';
  return null;
}

/** Returns the complete normalized description without model-generated copy. */
export function ghostPluginSummary(description: string, fallback: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}
