import type { ExecutableMediaModelsResult } from '../model-access/mediaModels.js';
import type { GhostMediaModelType } from '../../shared/ghost.js';

/**
 * Provider video models are executable without the Gateway catalog. Preserve
 * that local fallback, but never turn a genuine catalog outage into a
 * successful empty response when no local video model can be offered.
 */
export async function loadPluginMediaAvailability(
  type: GhostMediaModelType,
  localVideoModelCount: number,
  load: () => Promise<ExecutableMediaModelsResult>,
): Promise<ExecutableMediaModelsResult> {
  try {
    return await load();
  } catch (error) {
    if (type !== 'video' || localVideoModelCount === 0) throw error;
    return { models: [], unavailable: [], candidateCount: 0 };
  }
}
