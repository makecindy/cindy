import { isModelVisible, type AgentKind } from '@cindy/model-providers';

import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getModelVisibilityOverride } from '../maker-host/model-visibility-mirror.js';

/** Settings display switch for image/video. Mirror-not-ready fails closed. */
export function isCatalogMediaModelVisible(
  providerId: string,
  modelId: string,
  defaultEnabled?: boolean,
  sourceAgent?: AgentKind,
  kind?: 'image' | 'video',
): boolean {
  try {
    const provider = getActiveCatalog().providers.find((item) => item.id === providerId);
    const models = kind === 'image' ? provider?.imageModels : kind === 'video' ? provider?.videoModels
      : [...(provider?.imageModels ?? []), ...(provider?.videoModels ?? [])];
    const media = models?.find(model => model.id === modelId);
    const mode = kind === 'image' ? 'image_generation' : kind === 'video' ? 'video_generation' : undefined;
    const agents = sourceAgent ? [sourceAgent] : media?.sourceAgents?.length ? media.sourceAgents
      : media?.sourceAgent ? [media.sourceAgent] : [provider?.agents[0] ?? 'claude-code'];
    return agents.some(agent => isModelVisible(
      getModelVisibilityOverride(agent, providerId, modelId),
      provider?.models?.[agent]?.find(model => model.id === modelId && (!mode || model.mode === mode))?.defaultEnabled ?? defaultEnabled,
    ));
  } catch {
    return false;
  }
}
