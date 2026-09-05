import type { InstalledGhost } from '../../shared/ghost.js';
import type { HomePluginRecommendationsSnapshot } from '../../shared/homePluginRecommendations.js';
import { validateGhostRecommendations, type GhostRecommendation } from '@cindy/plugin-protocol';

export function buildGhostRecommendationSnapshot(
  ownerId: string | null,
  ghosts: InstalledGhost[],
  entries: { id: string; items?: GhostRecommendation[]; installedAt?: number }[],
  recentIds: string[],
): HomePluginRecommendationsSnapshot {
  const sources = ghosts.map((g) => {
    // Keep legacy manifest/receipt content intact; invalid optional metadata must not disable a plugin.
    const candidates =
      entries.find((e) => e.id === g.manifest.id)?.items ?? g.manifest.recommendations;
    const validated =
      candidates === undefined ? undefined : validateGhostRecommendations(candidates);
    const items = validated?.ok ? validated.items : undefined;
    return {
      ghostId: g.manifest.id,
      name: g.manifest.name,
      enabled: g.enabled,
      ...(items !== undefined ? { items } : {}),
    };
  });
  const installed = new Set(sources.map((s) => s.ghostId));
  return {
    ownerId,
    sources,
    recentIds: recentIds.filter((id) => installed.has(id)),
    newlyInstalledId:
      entries
        .filter((e) => e.installedAt && installed.has(e.id))
        .sort((a, b) => b.installedAt! - a.installedAt!)[0]?.id ?? null,
  };
}
