/**
 * Pure description and local publishing helpers shared by Plugin details and selection.
 *
 * Permission presentation intentionally consumes the shared Ghost permission items directly.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { isUserInstallReservedGhostId, type InstalledGhost } from '../../../../shared/ghost';
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
  if (isUserInstallReservedGhostId(ghost.manifest.id) || ghost.builtin) return 'reservedId';
  if (ghost.namespaceState !== 'confirmed') return 'identityPending';
  if (ghost.namespace !== null || (market && (market.scope !== 'public' || market.organizationId !== null))) return 'privatePlugin';
  if (ghost.approval.state !== 'approved') return 'approvalRequired';
  if (!ghost.publishingSource || ghost.publishingSource.kind === 'unavailable') return 'sourceUnverified';
  if (ghost.publishingSource.kind === 'public-market') return 'publishingPermissionRequired';
  return null;
}

/** Returns the complete normalized description without model-generated copy. */
export function ghostPluginSummary(description: string, fallback: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}
