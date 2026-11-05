import { createPluginUiComposerAccess } from '@cindy/maker-shared';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

export const pluginUiComposerAccess = createPluginUiComposerAccess();
export function pluginUiComposerKey(target: { sessionId?: string }) {
  return JSON.stringify([getDataOwnerGeneration(), target.sessionId]);
}
