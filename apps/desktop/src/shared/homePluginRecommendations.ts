import type { GhostRecommendation } from '@cindy/plugin-protocol';

export interface HomePluginRecommendationSource {
  ghostId: string;
  name: string;
  enabled: boolean;
  /** undefined = legacy plugin; [] = author explicitly withdrew all tasks. */
  items?: GhostRecommendation[];
}

export interface HomePluginRecommendationsSnapshot {
  ownerId: string | null;
  sources: HomePluginRecommendationSource[];
  recentIds: string[];
  newlyInstalledId: string | null;
}
