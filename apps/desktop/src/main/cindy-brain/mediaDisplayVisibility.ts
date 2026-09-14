import { isModelVisible } from '@cindy/model-providers';

import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getModelVisibilityOverride } from '../maker-host/model-visibility-mirror.js';

/** Settings display switch for image/video. Mirror-not-ready fails closed. */
export function isCatalogMediaModelVisible(
  providerId: string,
  modelId: string,
  defaultEnabled?: boolean,
): boolean {
  try {
    const provider = getActiveCatalog().providers.find((item) => item.id === providerId);
    const agent = provider?.agents[0] ?? 'claude-code';
    return isModelVisible(
      getModelVisibilityOverride(agent, providerId, modelId),
      defaultEnabled,
    );
  } catch {
    return false;
  }
}
