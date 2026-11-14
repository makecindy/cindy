import type { AutoReviewDelegate } from '@cindy/maker-core';
import { createPluginTaskReviewResolver } from '../../../desktop/src/main/maker-ipc/pluginTaskReviewContext.js';

/** The client id prefix of plugin target inputs (cindy-brain/pluginTargetSlot.ts). */
const PLUGIN_TARGET_CLIENT_ID_PREFIX = 'plugin-target:';
export const HOST_PLUGIN_DELEGATION_UNAVAILABLE = 'Plugin-delegated tasks are not delivered on the Host yet; their authorization context is unavailable';

/**
 * The desktop's Auto-review authorization context (register.ts setAutoReviewContextResolver):
 * the same resolver over a Host loader. The desktop loader (cindy-brain/pluginTargetReview.ts)
 * returns no plugin snapshot for an input that is not a plugin target, before it reads anything
 * else; the Host loader does the same. Plugin targets are not delivered on the Host (M2/M3), so
 * an input that claims to be one, for example a client-chosen client id, fails closed: the
 * resolver throws and the action needs confirmation. This check runs on the accepted input
 * itself, ahead of the desktop's narrower active-input conditions.
 */
export function createHostReviewContextResolver(options: {
  acceptedInput(sessionId: string): { clientId: string } | null | undefined;
}): NonNullable<AutoReviewDelegate['prepareRequest']> {
  return createPluginTaskReviewResolver(async sessionId => {
    if (options.acceptedInput(sessionId)?.clientId.startsWith(PLUGIN_TARGET_CLIENT_ID_PREFIX)) {
      throw new Error(HOST_PLUGIN_DELEGATION_UNAVAILABLE);
    }
    return null;
  });
}
